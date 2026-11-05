#!/bin/sh
# herdr-recover: remember the agent session on its herdr-core terminal.
#
#   sh recover-hook.sh claude   Claude Code's SessionStart hook (its SessionEnd sources
#                               recover-end.sh; given one, this hands it over)
#   sh recover-hook.sh codex    Codex's SessionStart hook
#
# The agent runs it with the event as JSON on stdin (Claude Code through sh, or
# Git Bash on Windows). It labels the terminal the agent runs in
# (`hc label $HC_TERMINAL_ID recover.*`), so the Recover mod in the Herdr app can
# bring the session back after a restart or a reboot. It needs only sh, sed and
# hc: no node, python or jq. The agent plugins (.claude-plugin, .codex-plugin)
# point their hooks here.
#
# Starting a process costs a lot under Git Bash (up to a second or more when an
# antivirus looks at each one), so the event is read with shell builtins, and a
# SessionStart (which runs in the background) reads the terminal with one hc and
# one sed.
#
# It never fails the agent: every exit is 0, and anything unexpected is a
# silent exit (RECOVER_DEBUG=1 says why on stderr).

say() { [ -n "${RECOVER_DEBUG:-}" ] && printf 'recover: %s\n' "$*" >&2; return 0; }

agent=${1:-claude}
case $agent in claude | codex) ;; *) say "unknown agent $agent"; exit 0 ;; esac
[ -n "${HC_TERMINAL_ID:-}" ] || exit 0
hc="${RECOVER_HC:-hc}"
command -v "$hc" >/dev/null 2>&1 || { say "no hc on PATH"; exit 0; }

# The event, read and taken apart with builtins only: Claude Code gives SessionEnd hooks
# 1.5 s in all, and under Git Bash each process started can cost a third of that.
input=
while IFS= read -r line || [ -n "$line" ]; do input="$input$line"; done

# REPLY = a top-level string field of the event, raw (JSON escapes kept), or empty when it
# is absent or not a string. A value with an escaped quote is cut short.
field() {
  REPLY=
  case $input in *"\"$1\""*) ;; *) return 0 ;; esac
  v=${input#*\"$1\"}
  v=${v#"${v%%[![:space:]:]*}"}
  case $v in \"*) v=${v#\"}; REPLY=${v%%\"*} ;; esac
}

# Undo the JSON escapes a path can carry: \\ and \/.
unescape() {
  v=$1; out=
  while :; do
    case $v in
      *'\\'*) out="$out${v%%'\\'*}\\"; v=${v#*'\\'} ;;
      *) break ;;
    esac
  done
  v="$out$v"; out=
  while :; do
    case $v in
      *'\/'*) out="$out${v%%'\/'*}/"; v=${v#*'\/'} ;;
      *) break ;;
    esac
  done
  printf '%s' "$out$v"
}

field hook_event_name; event=$REPLY
field session_id; session=$REPLY
field agent_id; agent_id=$REPLY
field cwd; cwd=$REPLY
field reason; reason=$REPLY
field transcript_path; transcript=$REPLY

case "$session" in
  "" | -* | *[!A-Za-z0-9._:-]*) say "no usable session id"; exit 0 ;;
esac
# A sub-agent's session belongs to its parent's terminal record, not in place of it.
[ -z "$agent_id" ] || { say "a sub-agent"; exit 0; }

# What the terminal remembers now, its own program (its shell), and the program in front:
# the record names the shell, so a new shell after a restart tells the mod the session was
# lost. hc sorts its keys, so the top-level "pid" is the one right after "parent"
# (`foreground` has its own), and a foreground's "argv" comes first.
terminal_state() {
  old= shell_pid= front= front_argv=
  while IFS= read -r line; do
    case $line in
      o=*) old=${line#o=} ;;
      p=*) shell_pid=${line#p=} ;;
      f=*) front=${line#f=} ;;
      v=*) front_argv=${line#v=} ;;
    esac
  done <<EOF
$("$hc" get "$HC_TERMINAL_ID" --json 2>/dev/null | sed -n '$!{
:a
N
$!ba
}
s/\n//g
h
s/.*"recover\.session"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/o=\1/p
g
s/.*"parent"[[:space:]]*:[[:space:]]*\(null\|"[^"]*"\)[[:space:]]*,[[:space:]]*"pid"[[:space:]]*:[[:space:]]*\([0-9]*\).*/p=\2/p
g
s/.*"foreground"[[:space:]]*:[[:space:]]*{[^}]*"name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/f=\1/p
g
s/.*"foreground"[[:space:]]*:[[:space:]]*{[[:space:]]*"argv"[[:space:]]*:[[:space:]]*\(\[[^]]*\]\).*/v=\1/p')
EOF
  [ -n "$shell_pid" ] || { say "no terminal pid from hc get"; exit 0; }
}

# Labels the terminal with this session: a new one starts clean, the same one starting
# again (a resume, a compaction) keeps its marks. $1 = config folder, $2 = session file,
# $3 = flags as a JSON array.
record() {
  cwd=$(unescape "$cwd")
  if [ "$old" = "$session" ]; then
    "$hc" label "$HC_TERMINAL_ID" "recover.cwd=$cwd" "recover.shell=$shell_pid" "recover.failed=" "recover.ended=" \
      ${2:+"recover.file=$2"} >/dev/null 2>&1
  else
    now="${EPOCHSECONDS:-$(date +%s)}000"
    "$hc" label "$HC_TERMINAL_ID" "recover.agent=$agent" "recover.session=$session" "recover.cwd=$cwd" \
      "recover.flags=$3" "recover.dir=$1" "recover.shell=$shell_pid" "recover.file=$2" "recover.pid=" \
      "recover.at=$now" "recover.resumed=" "recover.failed=" "recover.ended=" >/dev/null 2>&1
  fi
  say "recorded $agent $session in $HC_TERMINAL_ID (shell $shell_pid)"
}

case "$agent:$event" in
  claude:SessionStart)
    terminal_state
    sessions="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/sessions"
    # Claude Code keeps sessions/<pid>.json for each interactive process. The one naming
    # this session, and its kind, in one sed over them all (F prints the file's name).
    mine= kind=
    while IFS= read -r line; do
      case $line in
        k=*) kind=${line#k=} ;;
        ?*) [ -z "$mine" ] && mine=$line ;;
      esac
    done <<EOF
$(sed -n "/\"sessionId\":\"$session\"/{F;s/.*\"kind\":\"\([a-z]*\)\".*/k=\1/p}" "$sessions"/*.json 2>/dev/null)
EOF
    # A `claude -p` the agent ran as a tool inherits HC_TERMINAL_ID and fires SessionStart
    # too. It must not take the place of the interactive session: not when it says it isn't
    # interactive, and not while the remembered session is still running here.
    if [ -n "$kind" ] && [ "$kind" != "interactive" ]; then say "not interactive ($kind)"; exit 0; fi
    if [ -n "$old" ] && [ "$old" != "$session" ] && [ -z "$mine" ]; then
      # Exit 1: a file names the remembered session as interactive (0: none, 2: no files).
      sed -n "/\"sessionId\":\"$old\"/{/\"kind\":\"interactive\"/q1}" "$sessions"/*.json 2>/dev/null
      [ $? -eq 1 ] && { say "nested under live session $old"; exit 0; }
    fi
    # The session file, for the mod to tell a running session from a lost one by reading it
    # (hc can't see a child program on Windows), in the app's own path form there: /c/x is C:/x.
    file=$mine
    case $file in
      /[A-Za-z]/*) drive=${file#/}; drive=${drive%%/*}; file="$drive:/${file#/?/}" ;;
      /*) if command -v cygpath >/dev/null 2>&1; then file=$(cygpath -m "$file"); fi ;;
    esac
    flags="[]"
    # The agent's launch flags, from its process: Linux only (the mod fills them in on
    # Windows). Not under Git Bash, whose /proc can block reading a native Windows process.
    if [ -r /proc/self/stat ] && [ ! -e /proc/cygdrive ]; then
      pid=$$
      i=0
      while [ "$pid" -gt 1 ] && [ $i -lt 12 ]; do
        i=$((i + 1))
        first=$(tr '\0' '\n' < "/proc/$pid/cmdline" 2>/dev/null | sed -n 1p)
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
        read -r _ _ _ pid _ < "/proc/$pid/stat" 2>/dev/null || break
        [ -n "$pid" ] || break
      done
    fi
    record "${CLAUDE_CONFIG_DIR:-}" "$file" "$flags"
    ;;
  codex:SessionStart)
    # Codex runs its hooks in a background server that all its terminals share, with the
    # environment of the terminal that started it, so HC_TERMINAL_ID can name another
    # Codex terminal (the Herdr TUI's integration has the same gap; `codex --no-daemon`
    # has none). Two checks keep that from overwriting a record: Codex must be the program
    # in front there, and not one resuming another session (several terminals resuming
    # after a reboot).
    terminal_state
    [ "${front##*/}" = codex ] || { say "codex isn't in front in $HC_TERMINAL_ID"; exit 0; }
    named=$(printf '%s' "$front_argv" | grep -o -E '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}')
    if [ -n "$named" ] && ! printf '%s\n' "$named" | grep -qxF "$session"; then
      say "$HC_TERMINAL_ID resumed another session"; exit 0
    fi
    # A sub-agent's thread, or one Codex started for itself: its transcript says who started it.
    if [ -n "$transcript" ] && [ -r "$transcript" ]; then
      by=$(sed -n '1{s/.*"thread_source"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p;q;}' "$transcript" 2>/dev/null)
      [ -z "$by" ] || [ "$by" = user ] || { say "a $by thread"; exit 0; }
    fi
    # Flags: the mod reads them from the program in front, where hc shows its command line.
    record "${CODEX_HOME:-}" "" "[]"
    ;;
  claude:SessionEnd)
    # The plugin sources recover-end.sh for this (Claude Code's 1.5 s exit budget); called
    # here anyway (an older plugin command), the same rules, with the event already read.
    recover_event=$input
    . "${0%/*}/recover-end.sh"
    ;;
  *) say "$agent $event: nothing to do" ;;
esac
exit 0
