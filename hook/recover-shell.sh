#!/bin/sh
# herdr-recover: herdr-core's shell, so a kept terminal brings its agent back by itself.
#
#   recover-shell.sh [shell [args…]]              the core's shell (Linux, macOS): starts the
#                                                 job below, then becomes the shell
#   recover-shell.sh --job <t> <pid> <kind> [hc]  the job alone, for terminal <t> whose shell
#                                                 (pid, kind posix|pwsh|cmd) is already running:
#                                                 what the PowerShell entry starts on Windows
#
# install.sh puts it in herdr-core's config (`shell`), which hc uses for every new terminal and,
# in a kept terminal whose program was lost (a reboot, a core stop, a killed shell), for the
# shell that replaces it. That terminal still carries the recover.* labels the agent's
# integration wrote: the job types the line that resumes the session into the new shell, so
# the session comes back with no app, client or daemon. It needs sh, awk and hc (Git Bash on
# Windows).
#
# The script becomes the shell at once (exec: same pid, so the terminal's program is the
# shell), and a shell always starts, whatever the job finds. The job claims the terminal
# before it types (recover.shell = the shell's pid), as the Recover mod's Resume does, so
# nothing else sends the line twice. RECOVER_LOG=<file> says what it did.

case $(uname -s 2>/dev/null) in MINGW* | MSYS* | CYGWIN*) PATH="/usr/bin:$PATH" ;; esac

log() { [ -n "${RECOVER_LOG:-}" ] && printf '%s %s: %s\n' "$(date +%T)" "${t:-?}" "$*" >>"$RECOVER_LOG"; return 0; }

# The shell family of a program, as the Recover mod tells them apart.
shell_kind() {
  b=${1##*/}; b=${b##*\\}; b=${b%.exe}; b=${b%.EXE}
  case $b in pwsh | powershell | PowerShell) echo pwsh ;; cmd | CMD) echo cmd ;; *) echo posix ;; esac
}

# hc: the one given, the herdr-core that started this shell (its holder) when /proc says so,
# RECOVER_HC, PATH, or where the installer puts it. The core's own PATH is often bare.
find_hc() {
  [ -n "${1:-}" ] && [ -x "$1" ] && { hc=$1; return 0; }
  exe=$(readlink "/proc/$PPID/exe" 2>/dev/null)
  case ${exe##*/} in herdr-core | hc) hc=$exe; return 0 ;; esac
  for c in "${RECOVER_HC:-}" hc hc.exe "$HOME/.local/bin/hc"; do
    [ -n "$c" ] && hc=$(command -v "$c" 2>/dev/null) && return 0
  done
  return 1
}

# `hc get --json` on stdin → sh assignments: the terminal's pid (tpid), its recover.* labels
# (session agent ended auto failed shell), and `line`, the resume line for a shell of kind $1
# exactly as the mod's resumeLine() writes it (lib/core.js), or empty when the record can't be
# resumed safely there.
read_record() {
  awk -v kind="$1" '
    function jstr(s, i,    out, c, e) {
      out = ""; i++
      while (i <= length(s)) {
        c = substr(s, i, 1)
        if (c == "\"") { POS = i + 1; return out }
        if (c == "\\") {
          e = substr(s, i + 1, 1)
          if (e == "u") { BAD = 1; e = "?"; i += 4 }
          else if (e == "n") e = "\n"; else if (e == "t") e = "\t"; else if (e == "r") e = "\r"
          out = out e; i += 2; continue
        }
        out = out c; i++
      }
      POS = 0; BAD = 1; return out
    }
    function ws(s, i) { while (substr(s, i, 1) ~ /[ \t\r\n,]/) i++; return i }
    # Without gsub: what a backslash in its replacement does differs between awks.
    function sq(w,    out, k) {
      out = ""
      while ((k = index(w, "\047")) > 0) { out = out substr(w, 1, k - 1) "\047\\\047\047"; w = substr(w, k + 1) }
      return "\047" out w "\047"
    }
    function psq(w,    out, k) {
      out = ""
      while ((k = index(w, "\047")) > 0) { out = out substr(w, 1, k) "\047"; w = substr(w, k + 1) }
      return "\047" out w "\047"
    }
    # Regexes as strings, so no "/" needs escaping: a backslash in a bracket means itself in some
    # awks, and an escape in others.
    function shq(w) { return w ~ "^[A-Za-z0-9_@%+=:,./-]+$" ? w : sq(w) }
    function cmdq(w,    b) {
      if (index(w, "\"")) CMDBAD = 1
      b = w; gsub(/\\/, "", b)
      return w != "" && b ~ "^[A-Za-z0-9_@%+=:,./-]*$" ? w : "\"" w "\""
    }
    { s = s $0 }
    END {
      if (match(s, /"parent":(null|"[^"]*"),"pid":[0-9]+/)) { tp = substr(s, RSTART, RLENGTH); sub(/.*:/, "", tp) }
      p = index(s, "\"labels\":{")
      if (p) {
        i = p + 10
        while (1) {
          i = ws(s, i); if (substr(s, i, 1) != "\"") break
          k = jstr(s, i); i = POS; if (!POS) break
          i = ws(s, i); if (substr(s, i, 1) != ":") break
          i = ws(s, i + 1); if (substr(s, i, 1) != "\"") break
          BAD = 0; v = jstr(s, i); i = POS; if (!POS) break
          # A value with an escape this script does not decode (\u: a control character) is
          # never typed into a shell.
          if (substr(k, 1, 8) == "recover.") { L[substr(k, 9)] = v; if (BAD) RB = 1 }
        }
      }
      agent = L["agent"]; id = L["session"]
      # The flags, a JSON array of strings in a label. Unreadable: none, as the mod does.
      n = 0; f = L["flags"]; j = ws(f, 1)
      if (substr(f, j, 1) == "[") {
        j++
        while (1) {
          j = ws(f, j); if (substr(f, j, 1) != "\"") break
          BAD = 0; w = jstr(f, j); if (!POS) { n = 0; break }
          if (BAD) RB = 1
          a[++n] = w; j = POS
        }
        if (substr(f, j, 1) != "]") n = 0
      }
      ok = !RB && id ~ /^[A-Za-z0-9][A-Za-z0-9._:-]*$/ && length(id) <= 128
      # The resume command, as words (AGENTS[agent].resume in lib/core.js).
      m = 0
      if (agent == "claude") { w2[++m] = "claude"; for (x = 1; x <= n; x++) w2[++m] = a[x]; w2[++m] = "--resume"; w2[++m] = id; var = "CLAUDE_CONFIG_DIR" }
      else if (agent == "codex") { w2[++m] = "codex"; w2[++m] = "resume"; for (x = 1; x <= n; x++) w2[++m] = a[x]; w2[++m] = id; var = "CODEX_HOME" }
      else if (agent == "opencode" || agent == "pi") { w2[++m] = agent; for (x = 1; x <= n; x++) w2[++m] = a[x]; w2[++m] = "--session"; w2[++m] = id; var = "" }
      else ok = 0
      cwd = L["cwd"]; dir = (var != "" && L["dir"] != "") ? L["dir"] : ""
      line = ""
      if (ok && kind == "pwsh") {
        if (cwd != "") line = "Set-Location -LiteralPath " psq(cwd) "; "
        if (dir != "") line = line "$env:" var " = " psq(dir) "; "
        words = ""; for (x = 1; x <= m; x++) words = words (x > 1 ? " " : "") psq(w2[x])
        line = line "& " words
      } else if (ok && kind == "cmd") {
        words = ""; for (x = 1; x <= m; x++) words = words (x > 1 ? " " : "") cmdq(w2[x])
        if (cwd != "") line = "cd /d " cmdq(cwd) " && "
        if (dir != "") line = line "set \"" var "=" dir "\" && "
        line = CMDBAD ? "" : line words
      } else if (ok) {
        words = dir != "" ? "env " shq(var "=" dir) : ""
        for (x = 1; x <= m; x++) words = words (words != "" ? " " : "") shq(w2[x])
        line = (cwd != "" ? "cd -- " shq(cwd) " && " : "") words
      }
      print "tpid=" sq(tp) "; session=" sq(id) "; agent=" sq(agent) "; ended=" sq(L["ended"])
      print "auto=" sq(L["auto"]) "; failed=" sq(L["failed"]) "; shell=" sq(L["shell"]) "; line=" sq(line)
    }'
}

# Every hc call here retries a while: as the core restarts, a terminal answers "lost, waiting
# for its new shell" until its new shell is up, which is when this runs.
hc_try() {
  i=0
  while :; do
    out=$("$hc" "$@" 2>/dev/null) && return 0
    i=$((i + 1)); [ $i -lt 40 ] || return 1
    sleep 0.25
  done
}

job() {
  t=$1 me=$2 kind=$3
  hc_try get "$t" --json || { log "no answer from hc"; return 0; }
  tpid= session= agent= ended= auto= failed= shell= line=
  eval "$(printf '%s\n' "$out" | read_record "$kind")"
  # The terminal's program as hc sees it: the shell (Windows can put a launcher in between).
  [ -n "$tpid" ] || tpid=$me
  [ -n "$session" ] || { log "no session on record"; return 0; }
  # The person ended it (the agent's integration marks that): forget it, as the mod does.
  if [ "$ended" = "$session" ]; then
    hc_try label "$t" recover.agent= recover.session= recover.cwd= recover.flags= recover.dir= recover.file= \
      recover.pid= recover.shell= recover.at= recover.resumed= recover.failed= recover.ended=
    log "forgot $agent $session (ended)"; return 0
  fi
  [ "$auto" != off ] || { log "auto resume is off"; return 0; }
  [ -z "$failed" ] || { log "the last resume failed; left to Resume"; return 0; }
  [ "$shell" != "$tpid" ] || { log "already this shell's"; return 0; }
  [ -n "$line" ] || { log "can't write a $kind resume line for $agent $session"; return 0; }
  # Claim it before typing anything: from now on the terminal isn't lost, to anyone.
  hc_try label "$t" "recover.shell=$tpid" "recover.resumed=$(date +%s)000" recover.failed= \
    || { log "couldn't claim it"; return 0; }
  # Give the shell its profile, then type into it, as a sender with no terminal of its own:
  # from one, hc would wrap the line as a note (<hc from=…>) once the terminal ran an agent.
  sleep "${RECOVER_SETTLE:-1.5}"
  unset HC_TERMINAL_ID HC_SCOPE
  if hc_try send "$t" "$line"; then log "resumed $agent $session: $line"
  else log "hc send failed for $agent $session"; fi
}

if [ "${1:-}" = --job ]; then
  [ $# -ge 4 ] || exit 0
  find_hc "${5:-}" || exit 0
  job "$2" "$3" "$4" </dev/null >/dev/null 2>&1
  exit 0
fi

[ $# -gt 0 ] || set -- "${SHELL:-/bin/sh}"
# A shell that isn't there (or this script, given as its own shell) would be a terminal that
# can't open, retried forever: fall back to sh.
case $1 in */recover-shell.sh | recover-shell.sh) set -- /bin/sh ;; esac
command -v "$1" >/dev/null 2>&1 || set -- /bin/sh
if [ -n "${HC_TERMINAL_ID:-}" ] && find_hc; then
  job "$HC_TERMINAL_ID" $$ "$(shell_kind "$1")" </dev/null >/dev/null 2>&1 &
fi
exec "$@"
