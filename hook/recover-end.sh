# herdr-recover: Claude Code's SessionEnd hook. Sourced, not run:
#
#   . "${CLAUDE_PLUGIN_ROOT}/hook/recover-end.sh"     (the plugin's SessionEnd command)
#
# Claude Code gives plugin SessionEnd hooks 1.5 s in all, the shell it starts for them included,
# and a plugin can't ask for more. On a slow machine one program start can take all of that
# (Windows: Git Bash and hc.exe, an antivirus looking at each one), and a hook past it is
# cancelled ("Hook cancelled") before it marks anything. So the hook is async (Claude Code
# starts it and exits without waiting: it still gets the event, and runs on after Claude Code
# is gone, on Windows and Linux alike), and, should Claude Code ever end it at exit, it costs
# as little as can be: no shell of its own (it runs in the one Claude Code starts: Git Bash's
# bash on Windows, sh on Linux and macOS), the event read with builtins, and its one hc call
# left running in the background, where it outlives the hook.
#
# It marks a session the person ended (/exit, Ctrl+C, /logout): `recover.ended=<id>`, which
# herdr-core's shell and the Recover mod read as "forget it, don't resume it". A signal (reason
# "other": a crash, a kill, a shutdown) keeps the session, to be brought back.
#
# Sourced, it is POSIX only, and it ends that shell with exit 0 whatever happens. recover-hook.sh
# sources it too, with the event already read (recover_event). RECOVER_SYNC=1 waits for hc
# (tests); RECOVER_DEBUG=1 says what it did on stderr.

[ -n "${HC_TERMINAL_ID:-}" ] || exit 0
if [ -z "${recover_event:-}" ]; then
  while IFS= read -r recover_line || [ -n "$recover_line" ]; do recover_event="${recover_event:-}$recover_line"; done
fi
recover_say() { [ -n "${RECOVER_DEBUG:-}" ] && printf 'recover: %s\n' "$*" >&2; return 0; }

# A top-level string field of the event, raw (JSON escapes kept), or empty when it is absent or
# not a string: as recover-hook.sh reads it.
recover_field() {
  REPLY=
  case $recover_event in *"\"$1\""*) ;; *) return 0 ;; esac
  recover_v=${recover_event#*\"$1\"}
  recover_v=${recover_v#"${recover_v%%[![:space:]:]*}"}
  case $recover_v in \"*) recover_v=${recover_v#\"}; REPLY=${recover_v%%\"*} ;; esac
}

recover_field session_id; recover_session=$REPLY
recover_field agent_id; recover_agent=$REPLY
recover_field reason; recover_reason=$REPLY
case $recover_session in
  "" | -* | *[!A-Za-z0-9._:-]*) recover_say "no usable session id"; exit 0 ;;
esac
# A sub-agent's end isn't its terminal's.
[ -z "$recover_agent" ] || { recover_say "a sub-agent"; exit 0; }
case $recover_reason in
  clear | resume) recover_say "ignored ($recover_reason)"; exit 0 ;;   # the same process starts another session
  other) recover_say "kept (a signal)"; exit 0 ;;                      # worth bringing back
esac
recover_hc=${RECOVER_HC:-hc}
command -v "$recover_hc" >/dev/null 2>&1 || { recover_say "no hc on PATH"; exit 0; }
# The mark names the session, so a record goes only when it is this one's (a `claude -p` ending
# under it leaves it be). In the background, every stream its own: Claude Code reads the hook's
# output until it closes, and this mustn't keep it open.
"$recover_hc" label "$HC_TERMINAL_ID" "recover.ended=$recover_session" </dev/null >/dev/null 2>&1 &
recover_say "ended ($recover_reason)"
[ -z "${RECOVER_SYNC:-}" ] || wait
exit 0
