#!/bin/sh
# herdr-recover: set up Recover for the coding agents on this machine.
#
#   sh install.sh              for each agent found here, install Recover its own way
#   sh install.sh --uninstall  take it out again
#   sh install.sh --doctor     say what is set up
#
# Run it on every machine whose agents should come back: this computer, a WSL
# distro, a server. The Herdr app isn't needed there, only hc. Each agent gets
# Recover the way it takes extensions, so its own commands update and remove it:
#
#   Claude Code  a plugin:    claude plugin marketplace add guillaume86/herdr-recover
#                             claude plugin install herdr-recover@herdr-recover
#   Codex        a plugin:    codex plugin marketplace add guillaume86/herdr-recover
#                             codex plugin add herdr-recover@herdr-recover
#   Pi           a package:   pi install git:github.com/guillaume86/herdr-recover
#   OpenCode     a plugin file, copied to ~/.config/opencode/plugins/herdr-recover.js
#
# RECOVER_SOURCE=<folder> installs from a local clone instead of GitHub (development).

set -u
here=$(cd "$(dirname "$0")" && pwd)
mode="${1:-install}"
name=herdr-recover
repo=guillaume86/herdr-recover
source="${RECOVER_SOURCE:-}"
opencode_dir="${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}"
pi_dir="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
case "$(uname -s)" in MINGW* | MSYS* | CYGWIN*) windows=1 ;; *) windows= ;; esac

has() { command -v "$1" >/dev/null 2>&1; }
step() { printf '%s\n' "$*"; }
run() { printf '  $ %s\n' "$*"; "$@" >/dev/null 2>&1; }
pi_source() { if [ -n "$source" ]; then printf '%s' "$source"; else printf 'git:github.com/%s' "$repo"; fi; }

# Recover's hooks from before it was a plugin, in Claude Code's settings.json.
legacy() { grep -qs "$name/recover-hook.sh" "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/settings.json"; }

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

install_opencode() {
  has opencode || [ -d "$opencode_dir" ] || return 0
  step "OpenCode:"
  mkdir -p "$opencode_dir/plugins" && cp "$here/opencode/$name.js" "$opencode_dir/plugins/$name.js" \
    && step "  installed: $opencode_dir/plugins/$name.js (run install.sh again to update it)" \
    || step "  failed to copy the plugin to $opencode_dir/plugins"
}

install_pi() {
  has pi || return 0
  step "Pi:"
  if run pi install "$(pi_source)"; then step "  installed. New sessions in herdr terminals are remembered."
  else step "  failed: run the command above to see why."; fi
}

doctor() {
  printf 'hc: %s\n' "$(command -v hc 2>/dev/null || echo 'not on PATH (the hooks need it)')"
  if has claude; then
    claude plugin list 2>/dev/null | grep -q "$name" && step "Claude Code: plugin installed" || step "Claude Code: not set up"
    legacy && step "  (and hooks of an earlier install in settings.json)"
  fi
  has codex && { grep -qs "$name" "${CODEX_HOME:-$HOME/.codex}/config.toml" && step "Codex: plugin installed" || step "Codex: not set up"; }
  { has opencode || [ -d "$opencode_dir" ]; } && { [ -f "$opencode_dir/plugins/$name.js" ] && step "OpenCode: plugin installed" || step "OpenCode: not set up"; }
  has pi && { grep -qs "$name" "$pi_dir/settings.json" && step "Pi: package installed" || step "Pi: not set up"; }
  return 0
}

case "$mode" in
  install)
    has hc || step "hc isn't on PATH here; the hooks need it (set RECOVER_HC or fix PATH)." >&2
    install_claude; install_codex; install_opencode; install_pi
    has claude || has codex || has opencode || has pi || [ -d "$opencode_dir" ] || step "No supported agent found here (Claude Code, Codex, OpenCode, Pi)."
    ;;
  --uninstall | uninstall)
    if has claude; then step "Claude Code:"; run claude plugin uninstall "$name@$name"; run claude plugin marketplace remove "$name"; fi
    if has codex; then step "Codex:"; run codex plugin remove "$name@$name"; run codex plugin marketplace remove "$name"; fi
    if [ -f "$opencode_dir/plugins/$name.js" ]; then step "OpenCode:"; rm -f "$opencode_dir/plugins/$name.js" && step "  removed $opencode_dir/plugins/$name.js"; fi
    if has pi; then step "Pi:"; run pi remove "$(pi_source)"; fi
    ;;
  --doctor | doctor) doctor ;;
  *) echo "usage: sh install.sh [--uninstall|--doctor]" >&2; exit 2 ;;
esac
