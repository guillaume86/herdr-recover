#!/bin/sh
# herdr-recover: set up Recover on this machine.
#
#   sh install.sh              set up herdr-core's shell, and each agent found here
#   sh install.sh --uninstall  take it all out again
#   sh install.sh --doctor     say what is set up
#
# Run it on every machine whose agents should come back: this computer, a WSL distro, a
# server (on Windows, from Git Bash). The Herdr app isn't needed there, only hc. Two parts:
#
#   herdr-core   its `shell` (config.toml) becomes hook/recover-shell.sh, copied to
#                ~/.local/share/herdr-recover: in a kept terminal's new shell, after a reboot
#                or a core stop, it types the line that resumes the session. On Windows,
#                PowerShell starts it through Git Bash. A `shell` you had is kept, and put
#                back by --uninstall.
#   the agents   each records its session on its terminal, the way it takes extensions, so its
#                own commands update and remove it:
#     Claude Code  a plugin:   claude plugin marketplace add guillaume86/herdr-recover
#                              claude plugin install herdr-recover@herdr-recover
#     Codex        a plugin:   codex plugin marketplace add guillaume86/herdr-recover
#                              codex plugin add herdr-recover@herdr-recover
#     Pi           a package:  pi install git:github.com/guillaume86/herdr-recover
#     OpenCode     a TUI plugin, copied to ~/.config/opencode/herdr-recover/tui.js and listed
#                  in cli.json (OpenCode 1: a plugin file in ~/.config/opencode/plugins)
#
# RECOVER_SOURCE=<folder> installs from a local clone instead of GitHub (development).

set -u
here=$(cd "$(dirname "$0")" && pwd)
mode="${1:-install}"
name=herdr-recover
repo=guillaume86/herdr-recover
source="${RECOVER_SOURCE:-}"
opencode_dir="${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}"
opencode_state="${XDG_STATE_HOME:-$HOME/.local/state}/opencode"
pi_dir="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
share="${XDG_DATA_HOME:-$HOME/.local/share}/$name"
mark="# $name"
case "$(uname -s)" in MINGW* | MSYS* | CYGWIN*) windows=1 ;; *) windows= ;; esac

has() { command -v "$1" >/dev/null 2>&1; }
step() { printf '%s\n' "$*"; }
run() { printf '  $ %s\n' "$*"; "$@" >/dev/null 2>&1; }
pi_source() { if [ -n "$source" ]; then printf '%s' "$source"; else printf 'git:github.com/%s' "$repo"; fi; }

# Recover's hooks from before it was a plugin, in Claude Code's settings.json.
legacy() { grep -qs "$name/recover-hook.sh" "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/settings.json"; }

# ── herdr-core ──

core_config() {
  if [ -n "$windows" ]; then printf '%s/herdr-core/config.toml' "$(cygpath -u "$APPDATA")"
  else printf '%s/herdr-core/config.toml' "${XDG_CONFIG_HOME:-$HOME/.config}"; fi
}
toml() { printf '"%s"' "$(printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g')"; }
# A PowerShell literal, and the same inside a -f format string.
ps_literal() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/''/g")"; }
ps_format() { printf '%s' "$1" | sed "s/'/''/g; s/{/{{/g; s/}/}}/g"; }

# The `shell` line: recover-shell.sh in front of the shell there was (Linux, macOS), or
# PowerShell starting its job through Git Bash (Windows). $1 = the `shell = […]` there was.
core_line() {
  inner=
  if [ -n "$1" ]; then inner=${1#*[}; inner=${inner%]*}; fi
  script="$share/recover-shell.sh"
  if [ -z "$windows" ]; then
    printf 'shell = [%s%s]' "$(toml "$script")" "${inner:+, $(printf '%s' "$inner" | sed 's/^[[:space:]]*//')}"
    return 0
  fi
  first=$(printf '%s' "$inner" | sed -n 's/^[[:space:]]*"\([^"]*\)".*/\1/p')
  if [ -n "$first" ]; then
    case $(printf '%s' "${first##*[\\/]}" | tr 'A-Z' 'a-z') in
      pwsh | pwsh.exe | powershell | powershell.exe) exe=$first ;;
      *) step "  skipped: $(core_config) runs $first; Recover on Windows starts its job from PowerShell."; return 1 ;;
    esac
  elif has pwsh.exe; then exe=pwsh.exe
  else exe=powershell.exe; fi
  sh_exe="$(cygpath -m /)/bin/sh.exe"
  [ -f "$(cygpath -u "$sh_exe")" ] || { step "  skipped: Git Bash's sh.exe isn't at $sh_exe."; return 1; }
  hc_exe=$(cygpath -m "$(command -v hc)")
  # The paths escaped for the format string, not its {0} and {1}.
  args="\"$(ps_format "$(cygpath -m "$script")")\" --job {0} {1} pwsh \"$(ps_format "$hc_exe")\""
  stub="if (\$env:HC_TERMINAL_ID) { try { Start-Process -WindowStyle Hidden -FilePath $(ps_literal "$sh_exe") -ArgumentList ('$args' -f \$env:HC_TERMINAL_ID, \$PID) } catch {} }"
  printf 'shell = [%s, "-NoLogo", "-NoExit", "-Command", %s]' "$(toml "$exe")" "$(toml "$stub")"
}

# Rewrites the config in one move (the core reads it live): $1 = file, $2 = our line ("" to
# take ours out), $3 = the `shell` line to keep as "was" (with ours) or to put back (without).
write_core() {
  mkdir -p "$(dirname "$1")" || return 1
  tmp="$1.$name.$$"
  {
    if [ -n "$2" ]; then
      [ -n "$3" ] && printf '%s was: %s\n' "$mark" "$3"
      printf '%s  %s\n' "$2" "$mark"
    elif [ -n "$3" ]; then
      printf '%s\n' "$3"
    fi
    if [ -f "$1" ]; then awk -v m="$mark" 'index($0, m) == 0 && $0 !~ /^[[:space:]]*shell[[:space:]]*=/' "$1"; fi
  } >"$tmp" && mv -f "$tmp" "$1" || { rm -f "$tmp"; return 1; }
  [ -s "$1" ] || rm -f "$1"
}

# The `shell` line that isn't ours, now or kept from before ours.
core_was() {
  now=$(grep -E '^[[:space:]]*shell[[:space:]]*=' "$1" 2>/dev/null | grep -vF "$mark" | head -1)
  if [ -n "$now" ]; then printf '%s' "$now"; else sed -n "s/^$mark was: //p" "$1" 2>/dev/null | head -1; fi
}

install_core() {
  step "herdr-core:"
  has hc || { step "  skipped: hc isn't on PATH here."; return 0; }
  cfg=$(core_config)
  was=$(core_was "$cfg")
  case $was in "" | *\]*) ;; *) step "  skipped: $cfg sets \`shell\` over several lines; put it on one and run install.sh again."; return 0 ;; esac
  line=$(core_line "$was") || { printf '%s\n' "$line"; return 0; }
  mkdir -p "$share" && cp "$here/hook/recover-shell.sh" "$share/recover-shell.sh" && chmod +x "$share/recover-shell.sh" \
    || { step "  failed to copy recover-shell.sh to $share"; return 0; }
  if write_core "$cfg" "$line" "$was"; then
    step "  installed: $cfg runs $share/recover-shell.sh. New terminals and the shells of lost ones use it from now on, with no restart."
  else step "  failed to write $cfg"; fi
}

uninstall_core() {
  cfg=$(core_config)
  if grep -qsF "$mark" "$cfg"; then
    step "herdr-core:"
    write_core "$cfg" "" "$(sed -n "s/^$mark was: //p" "$cfg" | head -1)" && step "  removed Recover's shell from $cfg"
  fi
  # After the config: a configured shell that is missing is a terminal that can't open.
  rm -f "$share/recover-shell.sh"; rmdir "$share" 2>/dev/null
  return 0
}

# ── the agents ──

install_claude() {
  has claude || return 0
  step "Claude Code:"
  run claude plugin marketplace add "${source:-$repo}" || run claude plugin marketplace update "$name"
  if run claude plugin install "$name@$name"; then step "  installed. New sessions in herdr terminals are remembered."
  else step "  failed: run the commands above to see why."; fi
  if legacy; then
    step "  Remove the hooks of Recover's earlier install from ${CLAUDE_CONFIG_DIR:-~/.claude}/settings.json"
    step "  (the SessionStart and SessionEnd entries that run $name/recover-hook.sh), or they run twice."
  fi
}

install_codex() {
  has codex || return 0
  step "Codex:"
  if [ -n "$windows" ]; then step "  skipped: Recover's Codex hook runs on Linux and macOS."; return 0; fi
  run codex plugin marketplace add "${source:-$repo}" || run codex plugin marketplace upgrade "$name"
  if run codex plugin add "$name@$name"; then
    step "  installed. The next time Codex starts it asks to trust the new hook: choose to trust it (or use /hooks)."
  else step "  failed: run the commands above to see why."; fi
}

# OpenCode's major version: from the command, else from its config (cli.json is OpenCode 2's).
opencode_major() {
  v=$(opencode --version 2>/dev/null | sed -n 's/^[^0-9]*\([0-9][0-9]*\).*/\1/p' | head -1)
  if [ -n "$v" ]; then echo "$v"; elif [ -f "$opencode_dir/cli.json" ]; then echo 2; else echo 1; fi
}

# Lists ./herdr-recover in cli.json's `plugins` (JSONC), the file kept as it is otherwise.
register_opencode() {
  f="$opencode_dir/cli.json"
  spec="\"./$name\""
  if [ ! -f "$f" ]; then
    # OpenCode 2 imports OpenCode 1's settings into cli.json on its first start, only while
    # there is none: don't make one first.
    if [ -f "$opencode_dir/tui.json" ] || [ -f "$opencode_dir/tui.jsonc" ] || [ -f "$opencode_state/kv.json" ]; then
      step "  start OpenCode once (it moves its earlier settings into cli.json), then run install.sh again."; return 1
    fi
    printf '{\n  "plugins": [%s]\n}\n' "$spec" >"$f"; return
  fi
  grep -qF "$spec" "$f" && return 0
  tmp="$f.$name.$$"
  if grep -q '"plugins"[[:space:]]*:[[:space:]]*\[' "$f"; then
    awk -v spec="$spec" '
      !done && match($0, /"plugins"[[:space:]]*:[[:space:]]*\[/) {
        head = substr($0, 1, RSTART + RLENGTH - 1); rest = substr($0, RSTART + RLENGTH)
        $0 = head spec (rest ~ /^[[:space:]]*\]/ ? "" : ", ") rest; done = 1
      }
      { print }' "$f" >"$tmp"
  elif tr -d ' \t\r\n' <"$f" | grep -qx '{}'; then
    printf '{\n  "plugins": [%s]\n}\n' "$spec" >"$tmp"
  else
    awk -v spec="$spec" '!done && (i = index($0, "{")) { $0 = substr($0, 1, i) "\n  \"plugins\": [" spec "]," substr($0, i + 1); done = 1 } { print }' "$f" >"$tmp"
  fi
  mv -f "$tmp" "$f"
}

unregister_opencode() {
  f="$opencode_dir/cli.json"
  grep -qsF "\"./$name\"" "$f" || return 0
  tmp="$f.$name.$$"
  sed -e "s#\"./$name\"[[:space:]]*,[[:space:]]*##" -e "s#,[[:space:]]*\"./$name\"##" -e "s#\"./$name\"##" "$f" >"$tmp" && mv -f "$tmp" "$f"
}

install_opencode() {
  has opencode || [ -d "$opencode_dir" ] || return 0
  step "OpenCode:"
  if [ "$(opencode_major)" -ge 2 ]; then
    # OpenCode 1's plugin file would load in OpenCode 2's shared background service, which has
    # the environment of whichever terminal started it, and label that terminal.
    rm -f "$opencode_dir/plugins/$name.js"
    mkdir -p "$opencode_dir/$name" && cp "$here/opencode/tui.js" "$opencode_dir/$name/tui.js" \
      || { step "  failed to copy the plugin to $opencode_dir/$name"; return 0; }
    register_opencode && step "  installed: $opencode_dir/$name/tui.js, listed in $opencode_dir/cli.json (run install.sh again to update it)"
  else
    mkdir -p "$opencode_dir/plugins" && cp "$here/opencode/$name.js" "$opencode_dir/plugins/$name.js" \
      && step "  installed: $opencode_dir/plugins/$name.js (run install.sh again to update it)" \
      || step "  failed to copy the plugin to $opencode_dir/plugins"
  fi
}

install_pi() {
  has pi || return 0
  step "Pi:"
  if run pi install "$(pi_source)"; then step "  installed. New sessions in herdr terminals are remembered."
  else step "  failed: run the command above to see why."; fi
}

doctor() {
  printf 'hc: %s\n' "$(command -v hc 2>/dev/null || echo 'not on PATH (the hooks need it)')"
  cfg=$(core_config)
  if grep -qsF "$mark" "$cfg"; then
    if [ -f "$share/recover-shell.sh" ]; then step "herdr-core: shell set up ($cfg)"
    else step "herdr-core: $cfg runs $share/recover-shell.sh, which is missing: new terminals can't start. Run install.sh again."; fi
  else step "herdr-core: not set up (lost terminals come back as plain shells)"; fi
  if has claude; then
    claude plugin list 2>/dev/null | grep -q "$name" && step "Claude Code: plugin installed" || step "Claude Code: not set up"
    legacy && step "  (and hooks of an earlier install in settings.json)"
  fi
  has codex && { grep -qs "$name" "${CODEX_HOME:-$HOME/.codex}/config.toml" && step "Codex: plugin installed" || step "Codex: not set up"; }
  if has opencode || [ -d "$opencode_dir" ]; then
    if [ "$(opencode_major)" -ge 2 ]; then
      if [ -f "$opencode_dir/$name/tui.js" ] && grep -qsF "\"./$name\"" "$opencode_dir/cli.json"; then step "OpenCode: TUI plugin installed"
      else step "OpenCode: not set up"; fi
      [ -f "$opencode_dir/plugins/$name.js" ] && step "  (and OpenCode 1's plugin file, which OpenCode 2 runs in the wrong place: run install.sh again)"
    else
      [ -f "$opencode_dir/plugins/$name.js" ] && step "OpenCode: plugin installed" || step "OpenCode: not set up"
    fi
  fi
  has pi && { grep -qs "$name" "$pi_dir/settings.json" && step "Pi: package installed" || step "Pi: not set up"; }
  return 0
}

case "$mode" in
  install)
    has hc || step "hc isn't on PATH here; Recover needs it (set RECOVER_HC or fix PATH)." >&2
    install_core; install_claude; install_codex; install_opencode; install_pi
    has claude || has codex || has opencode || has pi || [ -d "$opencode_dir" ] || step "No supported agent found here (Claude Code, Codex, OpenCode, Pi)."
    ;;
  --uninstall | uninstall)
    uninstall_core
    if has claude; then step "Claude Code:"; run claude plugin uninstall "$name@$name"; run claude plugin marketplace remove "$name"; fi
    if has codex; then step "Codex:"; run codex plugin remove "$name@$name"; run codex plugin marketplace remove "$name"; fi
    if [ -f "$opencode_dir/plugins/$name.js" ] || [ -d "$opencode_dir/$name" ]; then
      step "OpenCode:"; rm -rf "$opencode_dir/plugins/$name.js" "$opencode_dir/$name"; unregister_opencode; step "  removed"
    fi
    if has pi; then step "Pi:"; run pi remove "$(pi_source)"; fi
    ;;
  --doctor | doctor) doctor ;;
  *) echo "usage: sh install.sh [--uninstall|--doctor]" >&2; exit 2 ;;
esac
