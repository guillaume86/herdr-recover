#!/bin/sh
# herdr-recover: remember the agent session on its herdr-core terminal.
#
# Claude Code runs this at SessionStart and SessionEnd (hooks run through
# sh, or Git Bash on Windows), with the event as JSON on stdin. It labels the
# terminal the agent runs in (`hc label $HC_TERMINAL_ID recover.*`), so the
# Recover mod in the Herdr app can bring the session back after a restart or
# a reboot. It needs only sh, sed and hc: no node, python or jq.
#
# Starting a process costs a lot under Git Bash (hundreds of ms when antivirus
# looks at each one), so the JSON is read with one sed per document and the
# rest is shell builtins.
#
# It never fails the agent: every exit is 0, and anything unexpected is a
# silent exit (RECOVER_DEBUG=1 says why on stderr).

say() { [ -n "${RECOVER_DEBUG:-}" ] && printf 'recover: %s\n' "$*" >&2; return 0; }

[ -n "${HC_TERMINAL_ID:-}" ] || exit 0
input=$(cat 2>/dev/null) || exit 0
hc="${RECOVER_HC:-hc}"
command -v "$hc" >/dev/null 2>&1 || { say "no hc on PATH"; exit 0; }

# `key=value` lines for the string fields named, from a JSON document on stdin, in one
# sed: the lines are joined, kept in the hold space, and each field copied out of a fresh
# copy. Values are raw (JSON escapes kept); a value with an escaped quote is cut short.
# A field given as `name:key` is printed as `name=` (for keys with dots or quotes).
fields() {
  script='$!{
:a
N
$!ba
}
s/\n//g
h'
  for f in "$@"; do
    name=${f%%:*}; key=${f#*:}
    script="$script
g
s/.*\"$key\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/$name=\1/p"
  done
  sed -n "$script"
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

event= session= agent_id= cwd= reason=
while IFS= read -r line; do
  case $line in
    e=*) event=${line#e=} ;;
    s=*) session=${line#s=} ;;
    a=*) agent_id=${line#a=} ;;
    c=*) cwd=${line#c=} ;;
    r=*) reason=${line#r=} ;;
  esac
done <<EOF
$(printf '%s' "$input" | fields e:hook_event_name s:session_id a:agent_id c:cwd r:reason)
EOF

case "$session" in
  "" | -* | *[!A-Za-z0-9._:-]*) say "no usable session id"; exit 0 ;;
esac
# A sub-agent's session belongs to its parent's terminal record, not in place of it.
[ -z "$agent_id" ] || { say "a sub-agent"; exit 0; }

# What the terminal remembers now, and its own program (its shell): the record names it,
# so a new shell after a restart tells the mod the session was lost. hc sorts its keys,
# so the top-level "pid" is the one right after "parent" (`foreground` has its own).
old= shell_pid=
while IFS= read -r line; do
  case $line in
    o=*) old=${line#o=} ;;
    p=*) shell_pid=${line#p=} ;;
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
s/.*"parent"[[:space:]]*:[[:space:]]*\(null\|"[^"]*"\)[[:space:]]*,[[:space:]]*"pid"[[:space:]]*:[[:space:]]*\([0-9]*\).*/p=\2/p')
EOF
[ -n "$shell_pid" ] || { say "no terminal pid from hc get"; exit 0; }

config="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
sessions="$config/sessions"

case "$event" in
  SessionStart)
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
    cwd=$(unescape "$cwd")
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
    now="${EPOCHSECONDS:-$(date +%s)}000"
    # The same session starting again (a resume, a compaction) keeps its marks; a new one starts clean.
    if [ "$old" = "$session" ]; then
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
