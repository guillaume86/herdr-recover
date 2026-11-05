#!/bin/sh
# herdr-recover: remember the agent session on its herdr-core terminal.
#
# Claude Code runs this at SessionStart and SessionEnd (hooks run through
# sh, or Git Bash on Windows), with the event as JSON on stdin. It labels the
# terminal the agent runs in (`hc label $HC_TERMINAL_ID recover.*`), so the
# Recover mod in the Herdr app can bring the session back after a restart or
# a reboot. It needs only sh, sed and hc: no node, python or jq.
#
# It never fails the agent: every exit is 0, and anything unexpected is a
# silent exit (RECOVER_DEBUG=1 says why on stderr).

say() { [ -n "${RECOVER_DEBUG:-}" ] && printf 'recover: %s\n' "$*" >&2; return 0; }

[ -n "${HC_TERMINAL_ID:-}" ] || exit 0
input=$(cat 2>/dev/null) || exit 0
hc="${RECOVER_HC:-hc}"
command -v "$hc" >/dev/null 2>&1 || { say "no hc on PATH"; exit 0; }

# A JSON string field's raw value (escapes kept), first match. Fields are flat in hook input.
field() {
  printf '%s' "$input" | tr -d '\n' | sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\(\([^\"\\\\]\|\\\\.\)*\)\".*/\1/p" | head -n 1
}
# Undo JSON escapes a path can carry: \\ and \" and \/.
unescape() { printf '%s' "$1" | sed 's/\\\\/\\/g; s/\\"/"/g; s/\\\//\//g'; }

event=$(field hook_event_name)
session=$(field session_id)
case "$session" in
  "" | -* | *[!A-Za-z0-9._:-]*) say "no usable session id"; exit 0 ;;
esac
# A sub-agent's session belongs to its parent's terminal record, not in place of it.
[ -z "$(field agent_id)" ] || { say "a sub-agent"; exit 0; }

# What the terminal remembers now.
labels=$("$hc" get "$HC_TERMINAL_ID" --json 2>/dev/null) || { say "hc get failed"; exit 0; }
label() { printf '%s' "$labels" | tr -d '\n' | sed -n "s/.*\"recover\.$1\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" | head -n 1; }
old=$(label session)
# The terminal's own program (its shell): the record names it, so a new shell after a
# restart tells the mod the session was lost. hc sorts its keys, so the top-level "pid"
# is the one right after "parent" (`foreground` has a "pid" of its own: the agent's).
shell_pid=$(printf '%s' "$labels" | tr -d '\n' | sed -n 's/.*"parent"[[:space:]]*:[[:space:]]*\(null\|"[^"]*"\)[[:space:]]*,[[:space:]]*"pid"[[:space:]]*:[[:space:]]*\([0-9]*\).*/\2/p' | head -n 1)
[ -n "$shell_pid" ] || { say "no terminal pid in hc get"; exit 0; }

config="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
sessions="$config/sessions"
# Claude Code keeps sessions/<pid>.json for each interactive process; a session's file
# says whether it is interactive, and whether it is still running.
session_file() { grep -l "\"sessionId\":\"$1\"" "$sessions"/*.json 2>/dev/null | head -n 1; }
kind_of() { [ -n "$1" ] && sed -n 's/.*"kind":"\([a-z]*\)".*/\1/p' "$1" | head -n 1; }

case "$event" in
  SessionStart)
    mine=$(session_file "$session")
    kind=$(kind_of "$mine")
    # A `claude -p` the agent ran as a tool inherits HC_TERMINAL_ID and fires SessionStart
    # too. It must not take the place of the interactive session: not when it says it isn't
    # interactive, and not while the remembered session is still running here.
    if [ -n "$kind" ] && [ "$kind" != "interactive" ]; then say "not interactive ($kind)"; exit 0; fi
    if [ -n "$old" ] && [ "$old" != "$session" ] && [ -z "$mine" ]; then
      oldfile=$(session_file "$old")
      if [ "$(kind_of "$oldfile")" = "interactive" ]; then say "nested under live session $old"; exit 0; fi
    fi
    cwd=$(unescape "$(field cwd)")
    # The session file, for the mod to tell a running session from a lost one by reading it
    # (hc can't see a child program on Windows). In the app's own path form: C:/Users/... there.
    file=$mine
    if [ -n "$file" ] && command -v cygpath >/dev/null 2>&1; then file=$(cygpath -m "$file"); fi
    flags="[]"
    # The agent's launch flags, from its process (Linux; the mod fills them in elsewhere).
    if [ -r /proc/self/stat ]; then
      pid=$$
      i=0
      while [ "$pid" -gt 1 ] && [ $i -lt 12 ]; do
        i=$((i + 1))
        first=$(tr '\0' '\n' < "/proc/$pid/cmdline" 2>/dev/null | head -n 1)
        case "${first##*/}" in
          claude)
            flags=$(tr '\0' '\n' < "/proc/$pid/cmdline" 2>/dev/null | awk '
              BEGIN { n["--dangerously-skip-permissions"]=0; n["--allow-dangerously-skip-permissions"]=0;
                      n["--permission-mode"]=1; n["--model"]=1; n["--add-dir"]=2; n["--settings"]=1; n["--agent"]=1 }
              NR == 1 { next }
              { w[++c] = $0 }
              END {
                out = ""; i = 1
                while (i <= c) {
                  k = w[i]; eq = index(k, "="); name = eq ? substr(k, 1, eq - 1) : k
                  if (!(name in n)) { i++; continue }
                  if (eq) { out = out (out == "" ? "" : ",") "\"" k "\""; i++; continue }
                  take = n[name]; ok = (i + take <= c)
                  for (j = 1; j <= take && ok; j++) if (substr(w[i + j], 1, 1) == "-") ok = 0
                  if (!ok) { i++; continue }
                  for (j = 0; j <= take; j++) { v = w[i + j]; gsub(/\\/, "\\\\", v); gsub(/"/, "\\\"", v); out = out (out == "" ? "" : ",") "\"" v "\"" }
                  i += take + 1
                }
                print "[" out "]"
              }')
            break ;;
        esac
        pid=$(awk '{print $4}' "/proc/$pid/stat" 2>/dev/null) || break
        [ -n "$pid" ] || break
      done
    fi
    now=$(date +%s)000
    same=
    [ "$old" = "$session" ] && same=1
    # The same session starting again (a resume, a compaction) keeps its marks; a new one starts clean.
    if [ -n "$same" ]; then
      "$hc" label "$HC_TERMINAL_ID" "recover.cwd=$cwd" "recover.shell=$shell_pid" "recover.failed=" ${file:+"recover.file=$file"} >/dev/null 2>&1
    else
      "$hc" label "$HC_TERMINAL_ID" "recover.agent=claude" "recover.session=$session" "recover.cwd=$cwd" \
        "recover.flags=$flags" "recover.dir=${CLAUDE_CONFIG_DIR:-}" "recover.shell=$shell_pid" "recover.file=$file" \
        "recover.at=$now" "recover.resumed=" "recover.failed=" >/dev/null 2>&1
    fi
    say "recorded $session in $HC_TERMINAL_ID (shell $shell_pid)"
    ;;
  SessionEnd)
    [ "$old" = "$session" ] || { say "not the remembered session"; exit 0; }
    reason=$(field reason)
    case "$reason" in
      clear | resume) say "ignored ($reason)" ;;        # the same process starts another session
      other) say "kept (a signal)" ;;                   # a crash, a kill, a shutdown: worth bringing back
      *)
        "$hc" label "$HC_TERMINAL_ID" recover.agent= recover.session= recover.cwd= recover.flags= \
          recover.dir= recover.file= recover.shell= recover.at= recover.resumed= recover.failed= >/dev/null 2>&1
        say "forgot ($reason)" ;;
    esac
    ;;
  *) say "event $event: nothing to do" ;;
esac
exit 0
