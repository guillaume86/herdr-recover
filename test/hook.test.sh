#!/bin/sh
# The hook against a fake hc: what it labels for each event.
set -u
here=$(cd "$(dirname "$0")" && pwd)
hook="$here/../hook/recover-hook.sh"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
fails=0
ID=03f81d7c-f3fb-4095-b4fa-845fe178921c
OTHER=11111111-2222-3333-4444-555555555555

# The fake hc: `get` prints $tmp/get.json, `label` appends its arguments to $tmp/labels.
cat > "$tmp/hc" <<EOF
#!/bin/sh
case "\$1" in
  get) cat "$tmp/get.json" ;;
  label) shift; shift; printf '%s\n' "\$@" >> "$tmp/labels" ;;
esac
EOF
chmod +x "$tmp/hc"
mkdir -p "$tmp/claude/sessions"

CLAUDE_FRONT='{"argv":["claude"],"cwd":"/w","name":"claude","pid":777}'
terminal() { # $1 = recover.* labels as JSON members (may be empty), $2 = the program in front
  printf '{"address":"t3","argv":["/bin/bash"],"foreground":%s,"keep":true,"labels":{"where":"x / 1"%s},"name":null,"parent":null,"pid":4242,"state":"live"}\n' \
    "${2:-$CLAUDE_FRONT}" "${1:+,$1}" > "$tmp/get.json"
}
session_file() { printf '{"pid":%s,"sessionId":"%s","cwd":"/w","kind":"%s"}' "$1" "$2" "$3" > "$tmp/claude/sessions/$1.json"; }
fire() { # $1 = JSON payload, $2 = the agent (default: Claude Code's hook, called without one)
  : > "$tmp/labels"
  printf '%s' "$1" | HC_TERMINAL_ID=t3 RECOVER_HC="$tmp/hc" CLAUDE_CONFIG_DIR="$tmp/claude" sh "$hook" ${2:+"$2"}
  echo "exit $?" >> "$tmp/labels"
}
has() { grep -qxF -- "$1" "$tmp/labels" || { echo "FAIL ($name): expected label $1"; cat "$tmp/labels"; fails=$((fails + 1)); }; }
none() { [ "$(grep -c '^recover\.' "$tmp/labels")" = 0 ] || { echo "FAIL ($name): expected no labels"; cat "$tmp/labels"; fails=$((fails + 1)); }; }
exited0() { grep -qx "exit 0" "$tmp/labels" || { echo "FAIL ($name): hook did not exit 0"; fails=$((fails + 1)); }; }

name="a new interactive session is recorded with the terminal's own pid, not the agent's"
terminal ""
session_file 777 "$ID" interactive
fire "{\"hook_event_name\":\"SessionStart\",\"session_id\":\"$ID\",\"cwd\":\"/home/u/my work\",\"source\":\"startup\"}"
has "recover.session=$ID"; has "recover.agent=claude"; has "recover.cwd=/home/u/my work"; has "recover.shell=4242"; has "recover.resumed="; exited0
want_file="$tmp/claude/sessions/777.json"
command -v cygpath >/dev/null 2>&1 && want_file=$(cygpath -m "$want_file")
has "recover.file=$want_file"

name="a Windows folder in the payload is unescaped"
fire "{\"hook_event_name\":\"SessionStart\",\"session_id\":\"$ID\",\"cwd\":\"C:\\\\Users\\\\u\\\\dev\"}"
has 'recover.cwd=C:\Users\u\dev'

name="the same session starting again keeps its marks"
terminal "\"recover.session\":\"$ID\",\"recover.resumed\":\"123\""
fire "{\"hook_event_name\":\"SessionStart\",\"session_id\":\"$ID\",\"cwd\":\"/w\",\"source\":\"resume\"}"
has "recover.shell=4242"; has "recover.failed="
grep -q '^recover.resumed=' "$tmp/labels" && { echo "FAIL ($name): resumed was reset"; fails=$((fails + 1)); }

name="a claude -p run as a tool is not recorded"
terminal "\"recover.session\":\"$ID\""
session_file 888 "$OTHER" print
fire "{\"hook_event_name\":\"SessionStart\",\"session_id\":\"$OTHER\",\"cwd\":\"/w\"}"
none; exited0

name="a nested session with no file of its own is not recorded while the remembered one runs"
rm -f "$tmp/claude/sessions/888.json"
fire "{\"hook_event_name\":\"SessionStart\",\"session_id\":\"$OTHER\",\"cwd\":\"/w\"}"
none

name="a sub-agent is not recorded"
terminal ""
fire "{\"hook_event_name\":\"SessionStart\",\"session_id\":\"$OTHER\",\"agent_id\":\"sub1\",\"cwd\":\"/w\"}"
none

name="a malformed session id is refused"
fire '{"hook_event_name":"SessionStart","session_id":"x;rm -rf /","cwd":"/w"}'
none; exited0

name="/exit forgets the session"
terminal "\"recover.session\":\"$ID\""
fire "{\"hook_event_name\":\"SessionEnd\",\"session_id\":\"$ID\",\"reason\":\"prompt_input_exit\"}"
has "recover.session="; has "recover.shell="
grep -q '^recover.auto' "$tmp/labels" && { echo "FAIL ($name): auto was touched"; fails=$((fails + 1)); }

name="a signal keeps it; /clear leaves it to the next SessionStart"
fire "{\"hook_event_name\":\"SessionEnd\",\"session_id\":\"$ID\",\"reason\":\"other\"}"
none
fire "{\"hook_event_name\":\"SessionEnd\",\"session_id\":\"$ID\",\"reason\":\"clear\"}"
none

name="another session's end is ignored"
fire "{\"hook_event_name\":\"SessionEnd\",\"session_id\":\"$OTHER\",\"reason\":\"prompt_input_exit\"}"
none

if [ -r /proc/self/cmdline ] && [ "$(uname -s)" = Linux ]; then
  name="on Linux the agent's launch flags are read from its process"
  terminal ""
  session_file 777 "$ID" interactive
  # A process named claude, with flags, that runs the hook: the hook walks up to it.
  mkdir -p "$tmp/bin" && ln -sf "$(command -v sh)" "$tmp/bin/claude"
  : > "$tmp/labels"
  printf '%s' "{\"hook_event_name\":\"SessionStart\",\"session_id\":\"$ID\",\"cwd\":\"/w\"}" > "$tmp/payload"
  HC_TERMINAL_ID=t3 RECOVER_HC="$tmp/hc" CLAUDE_CONFIG_DIR="$tmp/claude" \
    "$tmp/bin/claude" -c 'sh "$0" < "$1"; true' "$hook" "$tmp/payload" --model opus "a prompt" --add-dir /a "/b c" --dangerously-skip-permissions
  has 'recover.flags=["--model","opus","--add-dir","/a","/b c","--dangerously-skip-permissions"]'
fi

name="codex: a session is recorded on the terminal Codex is in front of"
CODEX_FRONT='{"argv":["codex","-m","gpt-5.5"],"cwd":"/w","name":"codex","pid":900}'
terminal "" "$CODEX_FRONT"
fire "{\"session_id\":\"$ID\",\"cwd\":\"/w\",\"hook_event_name\":\"SessionStart\",\"source\":\"startup\"}" codex
has "recover.agent=codex"; has "recover.session=$ID"; has "recover.shell=4242"; has "recover.flags=[]"; exited0

name="codex: not on a terminal where Codex isn't in front (its server's terminal moved on)"
terminal ""
fire "{\"session_id\":\"$ID\",\"cwd\":\"/w\",\"hook_event_name\":\"SessionStart\"}" codex
none; exited0

name="codex: not on a terminal resuming another session; yes on the one resuming this one"
terminal "" "{\"argv\":[\"codex\",\"resume\",\"$OTHER\"],\"cwd\":\"/w\",\"name\":\"codex\",\"pid\":900}"
fire "{\"session_id\":\"$ID\",\"cwd\":\"/w\",\"hook_event_name\":\"SessionStart\",\"source\":\"resume\"}" codex
none
terminal "" "{\"argv\":[\"codex\",\"resume\",\"$ID\"],\"cwd\":\"/w\",\"name\":\"codex\",\"pid\":900}"
fire "{\"session_id\":\"$ID\",\"cwd\":\"/w\",\"hook_event_name\":\"SessionStart\",\"source\":\"resume\"}" codex
has "recover.session=$ID"

name="codex: a thread Codex started for itself (a sub-agent) is not recorded"
terminal "" "$CODEX_FRONT"
printf '{"type":"session_meta","payload":{"id":"%s","thread_source":"subagent"}}\n{"x":1}\n' "$OTHER" > "$tmp/rollout.jsonl"
fire "{\"session_id\":\"$OTHER\",\"transcript_path\":\"$tmp/rollout.jsonl\",\"cwd\":\"/w\",\"hook_event_name\":\"SessionStart\"}" codex
none
printf '{"type":"session_meta","payload":{"id":"%s","thread_source":"user"}}\n' "$ID" > "$tmp/rollout.jsonl"
fire "{\"session_id\":\"$ID\",\"transcript_path\":\"$tmp/rollout.jsonl\",\"cwd\":\"/w\",\"hook_event_name\":\"SessionStart\"}" codex
has "recover.session=$ID"

name="codex: its SessionEnd (also sent after 30 idle minutes) forgets nothing"
terminal "\"recover.session\":\"$ID\"" "$CODEX_FRONT"
fire "{\"session_id\":\"$ID\",\"hook_event_name\":\"SessionEnd\",\"reason\":\"other\"}" codex
none

name="outside a herdr terminal it does nothing"
: > "$tmp/labels"
printf '{"hook_event_name":"SessionStart","session_id":"%s"}' "$ID" | HC_TERMINAL_ID= RECOVER_HC="$tmp/hc" sh "$hook"
[ $? = 0 ] && none

if [ "$fails" = 0 ]; then echo "hook: all passed"; else echo "hook: $fails failed"; exit 1; fi
