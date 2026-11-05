# v2 handoff: verify on Windows and WSL, finish, merge

Branch `v2`. Written 2026-11-05 on msi-gui-ubuntu (Linux) for a session on the owner's Windows
laptop, which runs the Herdr app (herdr-app, with the v1 `recover` mod) and its own herdr-core,
and has WSL. Goal: Windows and WSL tests, review, finish, merge into `main`. Delete this file in
the merge.

## What v2 is

herdr-core (hc 0.1.18) has no hooks, but it starts a configurable `shell` for every new
terminal **and** for the shell that replaces a kept terminal's lost program. v2 makes that
shell `hook/recover-shell.sh`: it starts a background job, then `exec`s the real shell. The
job reads the terminal's `recover.*` labels, claims the terminal (`recover.shell` = new pid)
and `hc send`s the resume line. So resuming needs no app/client; the Herdr app mod is now
optional and display-only (Resume/Forget/Auto by hand).

Decisions taken with the owner:
- Starting the core at boot is **not** wanted: the client reconnecting starts it, that's enough.
- Quits must be detected without the client: agent plugins mark `recover.ended=<id>`.
- Windows support via Git Bash is fine.
- The mod no longer auto-resumes (avoids double sends); it shows status.

## Done and verified on Linux

`npm test`: 70 node tests + `test/hook.test.sh`, all passing. New suites:
- `test/shell.test.js`: recover-shell.sh's resume lines equal `lib/core.js` `resumeLine()`
  for posix/pwsh/cmd, in awk, mawk, gawk and busybox awk; the job against a fake hc (claim,
  send, retries while the core says "lost, waiting for its new shell", ended → forget,
  auto off, failed, unknown agent, Windows launcher pid).
- `test/plugins.test.js`: OpenCode 2 TUI plugin and Pi extension in child processes: quit →
  `recover.ended`, SIGHUP/SIGTERM (agent then exits 0 / says "quit") → not ended, crash → not ended.
- `test/install.test.js`: core `shell` wrap/keep/restore, multi-line refusal, the Windows
  PowerShell entry (faked uname/cygpath, parsed with tomllib), OpenCode cli.json edits.

End to end against a **separate** hc core (recipe in README › Development), with
`install.sh` writing that core's config:
- fake Claude (real hook) and real OpenCode 2.0.28 (`--standalone`, a dead local model so no
  API call): `hc server stop`/start → both resumed on their sessions with flags; OpenCode
  reopened on the session route.
- OpenCode quit with Ctrl+C → `recover.ended` set → after the shell was lost, the job forgot
  it (labels cleared) instead of resuming.
- Earlier rounds: shell SIGKILL, core+holder SIGKILL, 4 s profile, coexistence with the
  mod's rules (claim lands ~4 ms after the shell appears; the mod waited 1.5 s).

## Verify on Windows (Git Bash + PowerShell)

Safety first: the core rereads config.toml live, so a broken entry stops **new** terminals from
opening; existing ones keep running. Keep one terminal open. To undo:
`sh install.sh --uninstall` from Git Bash (puts back the `shell` there was), or delete the two
`# herdr-recover` lines from `%APPDATA%\herdr-core\config.toml`. Before step 1 you can try the
entry by hand: run the `pwsh.exe … -Command "…"` from step 2 in an existing terminal and check
PowerShell starts and stays.

0. Update the app mod: replace the app's `mods/recover` folder with this branch's (delete the
   old one first, so removed files go), run `herdr-app check <folder>`, keep the layout block
   and the ctrl-shift-r key (README › The Herdr app). Ask the owner before removing other mods.
1. In Git Bash: `git clone … && cd herdr-recover && git switch v2`, then
   `RECOVER_SOURCE=$PWD sh install.sh` and `sh install.sh --doctor`.
2. Open `%APPDATA%\herdr-core\config.toml`. Expect a `# herdr-recover was:` line if a
   `shell` existed, and
   `shell = ["pwsh.exe", "-NoLogo", "-NoExit", "-Command", "if ($env:HC_TERMINAL_ID) { try { Start-Process -WindowStyle Hidden -FilePath 'C:/Program Files/Git/bin/sh.exe' -ArgumentList ('\"C:/Users/<you>/.local/bin/herdr-recover-shell\" --job {0} {1} pwsh \"<hc path>\"' -f $env:HC_TERMINAL_ID, $PID) } catch {} }"]  # herdr-recover`.
   Check the paths it filled in exist (sh.exe under Git's **bin**, the launcher that sets
   up PATH for /usr/bin tools; `hc` resolved by `command -v hc`).
3. Open a new terminal in the Herdr app. Expect: PowerShell starts as before (profile
   loaded, no window flashes, no error text). `hc get $env:HC_TERMINAL_ID --json`: argv is
   pwsh with the -Command stub; `pid` should equal `$PID` (if not, a launcher sits between:
   the job claims with hc's pid anyway).
4. Start `claude` there; `hc get <t> --json` should show `recover.session`, `recover.shell`
   = the terminal pid (hook unchanged from v1, already tested on Windows).
5. Lose the terminal: `hc server stop` then any `hc` (or kill the pwsh process). Expect the
   new PowerShell to receive
   `Set-Location -LiteralPath '<folder>'; & 'claude' '--resume' '<id>'` ~1.5 s after it
   starts, and Claude to come back. Labels: `recover.resumed` set, `recover.shell` = new pid.
6. Quit Claude with `/exit`, lose the terminal again: expect no resume and the labels gone.
7. Debugging: set a user env var `RECOVER_LOG=C:\Users\<you>\recover.log` (`setx`), restart
   the core so its environment has it; the job logs each decision there. Run the job by hand
   from Git Bash: `sh ~/.local/bin/herdr-recover-shell --job <t> <pid> pwsh "$(command -v hc)"`.

Things that may go wrong there (unverified assumptions):
- `Start-Process` (ShellExecute) passing the environment: the terminal id and pid are passed
  as arguments, but `RECOVER_LOG`/`PATH` come from the environment.
- `-WindowStyle Hidden` with a console program: check nothing flashes; alternative is
  `-NoNewWindow` with output redirected.
- `-NoExit -Command` changing PowerShell's startup (profile order, PSReadLine): compare with
  the shell before.
- The job's `sleep 0.25`, `date +%s`, `awk` come from Git's /usr/bin (the script prepends it
  on MINGW/MSYS).
- Typed-ahead input into PSReadLine while the profile loads (the mod relied on it already).
- OpenCode 2 and Pi on Windows: plugins use `process.kill(pid, signal)` re-raise and
  SIGHUP/SIGTERM listeners; Windows signal semantics differ (untested; they only matter
  for telling a quit apart).
- Also run `herdr-app check mods/recover` (the mod changed: auto-resume removed, a
  "resumes" mark per machine in the dialog's setup line). It was only syntax-checked.

## Test in WSL

For each distro whose terminals the app uses (it is a linked hc machine, Linux path):
1. Clone or update, `git switch v2`, `npm test` (there `/bin/sh` is dash, and `/proc` exists:
   the hook's flag reading and the awk variants run for real). `sh test/hook.test.sh` too.
2. `sh install.sh`, `sh install.sh --doctor`; open a new terminal on that machine from the app:
   it must open into the usual shell (argv `~/.local/bin/herdr-recover-shell`, foreground the shell).
3. Real loss with a real agent: start `claude` (and `opencode` if present) in a terminal there,
   send a prompt so the session exists, then `wsl --shutdown` from Windows (the README's
   untested case) or `hc server stop` inside the distro, then reopen the app. Expect each
   session typed back ~1.5 s after its new shell, on the same session, with its flags.
4. Quit an agent by hand (`/exit`, Ctrl+C), lose the terminal again: expect no resume, labels gone.
5. Old integrations there: OpenCode 1's plugin file under OpenCode 2 (the installer removes it),
   legacy Herdr TUI leftovers (herdr-agent-state hooks, herdr-tui-session / herdr-opencode):
   list them and ask the owner before deleting.

## Finish and merge

- Review the whole diff `main..v2` (correctness first: recover-shell.sh's job, install.sh's
  config editing on Windows and Linux, the two plugins). Fix what you find, with tests.
- Settle the open questions below with the owner.
- README: replace the "Status" paragraph with what was actually tested (Windows, WSL, Linux);
  update the agent table's Windows column; bump `package.json` (owner's call on the number).
- `npm test` green on Windows (Git Bash) and in WSL.
- Delete this file, merge `v2` into `main` (ask the owner: fast-forward or a merge commit),
  push `main`, delete the `v2` branch on GitHub if the owner agrees.
- After the merge, on every machine (the laptop, each WSL distro, and through
  `hc exec --on <machine>` msi-gui-ubuntu, gui-desktop-26-ubuntu, nas): switch the clone to
  `main`, `git pull`, `sh install.sh`, `sh install.sh --doctor`, and
  `claude plugin marketplace update herdr-recover && claude plugin update herdr-recover@herdr-recover`
  so Claude Code's plugin comes from the merged main.

## Open questions for the owner

- **Codex quits**: no in-process signal (SessionEnd reason is always "other", fires on
  unload after a quit *or* a kill; hooks run in the shared daemon with its env). Options: a
  `codex` shim/wrapper that watches the TUI's exit status (0 = quit, signal death = lost),
  or accept the limit (README › Limits). Not done.
- OpenCode 1 still gets the old server plugin with no quit marking. Drop OpenCode 1?
- Version/README status wording ("v2 (branch)"); package.json version unchanged (0.1.0).

## State of the Linux machines (2026-11-05)

v2 is installed (commit 4d31a84) on the three machines the laptop's app links:
msi-gui-ubuntu (clone ~/src/herdr-recover), gui-desktop-26-ubuntu (~/dev/herdr-recover) and
the NAS container `herdr` (~/.local/share/herdr-recover; the NAS's web UI is ovis, not the
Herdr app). On each: `~/.config/herdr-core/config.toml` runs
`~/.local/bin/herdr-recover-shell` (a throwaway terminal opened into bash through it), the
Claude Code plugin (from main; its hook is the same in v2), and OpenCode 2's TUI plugin in
`~/.config/opencode/herdr-recover`, listed in cli.json. OpenCode 1's plugin file, installed
there earlier the same day, was removed. No legacy Herdr TUI integrations were left on them.
To update later: `git pull` in the clone, then `sh install.sh`.

## Facts established about hc 0.1.18 (for later work)

- `config.toml` is reread live; `shell` applies to new terminals and keep recovery, also for
  terminals created with an explicit argv. A missing shell executable = `spawn_failed`, retried.
- Recovery shells get `HC_TERMINAL_ID`, `HC_TERMINAL_SOCKET`, the core's (bare) PATH; their
  parent is the holder (`/proc/$PPID/exe` = herdr-core). Labels survive the loss.
- Right after a core start, `hc get/label/send` on a recovering terminal can fail with
  `unavailable: lost, waiting for its new shell` → retry (the job does, 10 s).
- At the new shell's start, `foreground` is already cleared: the pre-loss program can't be
  read (so the legacy TUI's "process exited while the pane lived" rule can't be replayed).
- OSC 7501 status (`ESC ] 7501 ; state=…:app=… ESC \`) stays latched after the agent exits.
- `hc server stop` sends SIGHUP to programs. `hc send` from a process without
  `HC_TERMINAL_ID` types text as is.
