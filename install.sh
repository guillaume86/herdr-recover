#!/bin/sh
# herdr-recover: install the hook on this machine.
#
#   sh install.sh              copy the hook to ~/.local/share/herdr-recover/ and add it to
#                              Claude Code's ~/.claude/settings.json (SessionStart, SessionEnd)
#   sh install.sh --uninstall  take both out again
#   sh install.sh --doctor     say what is installed
#
# Run it on every machine whose agents should come back: this computer, a WSL
# distro, a server. The Herdr app isn't needed there, only hc. Editing the
# settings file needs python3 (or python) or jq; the hook itself needs neither.
# The first time it changes settings.json, a copy is kept as settings.json.recover-backup.

set -eu
here=$(cd "$(dirname "$0")" && pwd)
mode="${1:-install}"
data="${XDG_DATA_HOME:-$HOME/.local/share}/herdr-recover"
hook="$data/recover-hook.sh"
# Claude Code runs it through sh (Git Bash on Windows), so it doesn't depend on the exec bit.
command="sh '$hook'"
config="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
settings="$config/settings.json"
mark="herdr-recover"

# A python that really runs (Windows' WindowsApps alias can be a stub that opens the Store), else jq.
works() { "$1" -c 'import json, sys; sys.exit(0 if sys.version_info[0] >= 3 else 1)' >/dev/null 2>&1; }
json_tool() {
  if command -v python3 >/dev/null 2>&1 && works python3; then echo python3
  elif command -v python >/dev/null 2>&1 && works python; then echo python
  elif command -v jq >/dev/null 2>&1; then echo jq
  else echo ""; fi
}

# Adds or removes Recover's hooks in a Claude Code settings file, leaving everything else as it is.
edit_settings() { # $1 = add|remove
  tool=$(json_tool)
  [ -n "$tool" ] || { echo "install.sh: python3 or jq is needed to edit $settings" >&2; exit 1; }
  mkdir -p "$config"
  [ -f "$settings" ] || printf '{}\n' > "$settings"
  [ -f "$settings.recover-backup" ] || cp "$settings" "$settings.recover-backup"
  # python and jq on Windows are native programs: give them C:/... paths (Git Bash has cygpath).
  native=$settings
  if command -v cygpath >/dev/null 2>&1; then native=$(cygpath -m "$settings"); fi
  if [ "$tool" = jq ]; then
    if [ "$1" = add ]; then
      jq --arg cmd "$command" '
        .hooks //= {} |
        .hooks.SessionStart = ([(.hooks.SessionStart // [])[] | .hooks = [(.hooks // [])[] | select((.command // "") | contains("herdr-recover") | not)] | select(.hooks | length > 0)] + [{"hooks":[{"type":"command","command":$cmd,"timeout":10,"async":true}]}]) |
        .hooks.SessionEnd = ([(.hooks.SessionEnd // [])[] | .hooks = [(.hooks // [])[] | select((.command // "") | contains("herdr-recover") | not)] | select(.hooks | length > 0)] + [{"hooks":[{"type":"command","command":$cmd,"timeout":10}]}])
      ' "$native" > "$settings.tmp"
    else
      jq '
        .hooks //= {} |
        .hooks.SessionStart = [(.hooks.SessionStart // [])[] | .hooks = [(.hooks // [])[] | select((.command // "") | contains("herdr-recover") | not)] | select(.hooks | length > 0)] |
        .hooks.SessionEnd = [(.hooks.SessionEnd // [])[] | .hooks = [(.hooks // [])[] | select((.command // "") | contains("herdr-recover") | not)] | select(.hooks | length > 0)] |
        if .hooks.SessionStart == [] then del(.hooks.SessionStart) else . end |
        if .hooks.SessionEnd == [] then del(.hooks.SessionEnd) else . end |
        if .hooks == {} then del(.hooks) else . end
      ' "$native" > "$settings.tmp"
    fi
  else
    RECOVER_MODE="$1" RECOVER_HOOK="$command" RECOVER_SETTINGS="$native" "$tool" - <<'PY' > "$settings.tmp"
import json, os
mode, cmd, path = os.environ["RECOVER_MODE"], os.environ["RECOVER_HOOK"], os.environ["RECOVER_SETTINGS"]
with open(path, encoding="utf-8-sig") as f:
    text = f.read()
doc = json.loads(text) if text.strip() else {}
hooks = doc.setdefault("hooks", {})
for event in ("SessionStart", "SessionEnd"):
    groups = []
    for g in hooks.get(event, []):
        kept = [h for h in g.get("hooks", []) if "herdr-recover" not in str(h.get("command", ""))]
        if kept:
            groups.append({**g, "hooks": kept})
    if mode == "add":
        hook = {"type": "command", "command": cmd, "timeout": 10}
        # SessionStart runs in the background: Claude doesn't wait for it to start. SessionEnd
        # stays in the foreground, so an /exit is forgotten before Claude is gone.
        if event == "SessionStart":
            hook["async"] = True
        groups.append({"hooks": [hook]})
    if groups:
        hooks[event] = groups
    else:
        hooks.pop(event, None)
if not hooks:
    doc.pop("hooks", None)
# Bytes, not print(): on Windows a redirected stdout would use the console's code page and CRLF.
import sys
sys.stdout.buffer.write((json.dumps(doc, indent=2, ensure_ascii=False) + "\n").encode("utf-8"))
PY
  fi
  mv "$settings.tmp" "$settings"
}

case "$mode" in
  install)
    command -v hc >/dev/null 2>&1 || echo "install.sh: hc isn't on PATH here; the hook needs it (set RECOVER_HC or fix PATH)" >&2
    mkdir -p "$data"
    cp "$here/hook/recover-hook.sh" "$hook"
    chmod 755 "$hook"
    edit_settings add
    echo "Installed: $hook"
    echo "Hooks added to $settings. New Claude Code sessions in herdr terminals are remembered from now on."
    ;;
  --uninstall | uninstall)
    [ -f "$settings" ] && grep -q "$mark" "$settings" && edit_settings remove && echo "Hooks removed from $settings"
    [ -f "$hook" ] && rm -f "$hook" && echo "Removed $hook"
    rmdir "$data" 2>/dev/null || true
    ;;
  --doctor | doctor)
    [ -x "$hook" ] && echo "hook: $hook" || echo "hook: not installed"
    if [ -f "$settings" ] && grep -q "$mark" "$settings"; then echo "settings: hooks present in $settings"; else echo "settings: no Recover hooks in $settings"; fi
    command -v hc >/dev/null 2>&1 && echo "hc: $(command -v hc)" || echo "hc: not on PATH"
    ;;
  *) echo "usage: sh install.sh [--uninstall|--doctor]" >&2; exit 2 ;;
esac
