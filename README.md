# ↻ herdr-recover

Bring back the coding agent a [Herdr](https://herdr.dev) terminal lost to a restart or a
reboot, **on every machine with herdr-core** (this computer, a WSL distro, a server), with no
app or client running. Claude Code, Codex, OpenCode and Pi. Windows included (with Git Bash).

Herdr keeps terminals through app restarts and updates. When the machine reboots or
herdr-core stops, kept terminals come back as fresh shells in the same folder, but the
agent that ran there is gone. Recover remembers which session each terminal held and,
when the terminal comes back as a new shell, types the command that resumes it, with the
same flags. A session you quit stays quit.

Status: **v2 (branch).** herdr-core itself now does the resuming, through the shell it
starts, so the Herdr app is optional. Tested on Linux against a separate herdr-core 0.1.18
(core stop, core and holder killed, shells killed, a slow profile): Claude Code (a stand-in
running the real hook) and OpenCode 2.0.28 came back on their sessions with their flags, and
an OpenCode session quit by hand was forgotten. The Windows path (PowerShell starting the
job through Git Bash) is written and unit-tested but not yet run on Windows. See
[Limits](#limits).

| Agent | Recover comes as | Resumes with | A quit is told by | Windows |
|---|---|---|---|---|
| Claude Code | a plugin (hooks) | `claude … --resume <id>` | its SessionEnd hook | yes |
| Codex | a plugin (hook) | `codex resume … <id>` | the app only (see Limits) | no |
| OpenCode 2 | a TUI plugin | `opencode … --session <id>` | the plugin, at exit | untested |
| Pi | a package (extension) | `pi … --session <id>` | the extension, at shutdown | untested |

## How it differs from Revive

[herdr-revive](https://github.com/dmazlum/herdr-revive) and
[herdr-agent-resume](https://github.com/thuanlm215/herdr-agent-resume) resume from the
shell: a block in `.zshrc`/`.bashrc` asks, as the recovered shell starts, whether there is
something to resume. That needs a block per shell, a runtime (node, python) on every
machine, and it can't work in PowerShell.

Recover does it the way the Herdr TUI did, **by typing the resume command into the restored
shell**, and from herdr-core itself: the shell herdr-core starts is a small script that
becomes your shell and types the line. Typing into a shell works the same in bash, zsh,
fish and PowerShell. What each machine needs is hc, that script, and a hook or plugin in
each agent, installed the agent's own way.

| | Revive | Recover |
|---|---|---|
| Who resumes | the shell's rc file | herdr-core's shell (a script it starts) |
| Windows (PowerShell) terminals | no | yes (with Git Bash) |
| Remote / WSL terminals | no (my branch: yes, with node there) | yes |
| Needs on each agent machine | node, an rc block, hooks | `hc`, sh and awk, the agent's plugin |
| Works while the app is closed | yes | yes |

## Install

With a coding agent, paste this to it:

```text
Install https://github.com/guillaume86/herdr-recover, following its README.
```

By hand, on **every machine whose agents should come back** (this computer, each WSL distro,
each server; on Windows, from Git Bash):

```sh
git clone https://github.com/guillaume86/herdr-recover
sh herdr-recover/install.sh            # --doctor: what is set up; --uninstall: take it out
```

It sets up two things:

- **herdr-core's shell.** `hook/recover-shell.sh` is copied to
  `~/.local/share/herdr-recover/`, and herdr-core's `config.toml`
  (`~/.config/herdr-core/`, on Windows `%APPDATA%\herdr-core\`) gets
  `shell = ["…/recover-shell.sh"]`, in front of the `shell` you had (kept on a
  `# herdr-recover was:` line, and put back by `--uninstall`). On Windows it is PowerShell,
  which starts the script's job through Git Bash. hc reads that file live: new terminals,
  and the shells of lost ones, use it at once, with no restart.
- **Each agent found here**, its own way, so its own commands update and remove it:

```sh
# Claude Code (in Claude Code itself: /plugin install herdr-recover --marketplace guillaume86/herdr-recover)
claude plugin marketplace add guillaume86/herdr-recover
claude plugin install herdr-recover@herdr-recover

# Codex (Linux, macOS): the next time it starts, Codex asks to trust the new hook
codex plugin marketplace add guillaume86/herdr-recover
codex plugin add herdr-recover@herdr-recover

# Pi
pi install git:github.com/guillaume86/herdr-recover

# OpenCode 2: a TUI plugin, listed in cli.json
mkdir -p ~/.config/opencode/herdr-recover
cp herdr-recover/opencode/tui.js ~/.config/opencode/herdr-recover/tui.js
#   then add "./herdr-recover" to "plugins" in ~/.config/opencode/cli.json
# (OpenCode 1: herdr-recover/opencode/herdr-recover.js in ~/.config/opencode/plugins/)
```

The agents' hooks need `hc` on their PATH (`RECOVER_HC` overrides). Updates:
`claude plugin update herdr-recover@herdr-recover`, `codex plugin marketplace upgrade
herdr-recover`, `pi update`, and `install.sh` again for herdr-core's shell and OpenCode.

Sessions already running are remembered from their next start (or `/resume`).

### The Herdr app (optional)

The `recover` mod shows the remembered sessions of every terminal the app sees, on every
machine: which run, which a restart took, which a resume didn't bring back, and which died
under a shell that lived on (nothing resumes those by itself). Its dialog offers Resume,
Forget and an Auto toggle per terminal, and shows what is set up on each machine. On the
computer that runs the Herdr app:

1. Copy `mods/recover` to `~/.config/herdr-app/mods/recover` and run
   `herdr-app check ~/.config/herdr-app/mods/recover`.
2. Put the mod in your layout's status bar (a clone of the shipped layout, since shipped
   ones are replaced at start):

   ```json
   { "id": "recover", "type": "block", "size": { "px": 120 }, "content": { "mod": "recover" } }
   ```

3. Merge [`keys.json`](keys.json): `ctrl-shift-r` opens the dialog.

## Uninstall

With a coding agent, paste this to it:

```text
Uninstall https://github.com/guillaume86/herdr-recover, following its README.
```

By hand, on each machine: `sh install.sh --uninstall` puts herdr-core's `shell` back and
takes out every agent's part. Or for each agent:

```sh
claude plugin uninstall herdr-recover@herdr-recover && claude plugin marketplace remove herdr-recover
codex plugin remove herdr-recover@herdr-recover && codex plugin marketplace remove herdr-recover
pi remove git:github.com/guillaume86/herdr-recover
rm -r ~/.config/opencode/herdr-recover   # and "./herdr-recover" from cli.json's plugins
```

On the computer that runs the Herdr app: delete `~/.config/herdr-app/mods/recover`, the
`recover` block from your layout, and the `mod.open:recover` key from `keys.json`. The
`recover.*` labels left on terminals do nothing and go away with them.

## How it works

1. **Each agent's integration** labels the terminal it runs in (`HC_TERMINAL_ID` is set
   there) with `recover.session`, the folder, the carried flags and the terminal's own
   program pid (`recover.shell`), and marks the session ended (`recover.ended=<id>`) when
   the person quits it:
   - **Claude Code**: a plugin whose `SessionStart` and `SessionEnd` hooks run
     [`hook/recover-hook.sh`](hook/recover-hook.sh) (`sh`, Git Bash on Windows, with `sed`
     and `hc` only). It also records the agent's session file
     (`~/.claude/sessions/<pid>.json`) and reads the flags from `/proc` on Linux. It skips
     `claude -p` runs an agent starts as a tool, and sub-agents. At `SessionEnd`, `/exit`,
     Ctrl+C and `/logout` mark the session ended; a signal (`other`) keeps it. That costs
     one `hc` call: Claude Code gives plugin `SessionEnd` hooks 1.5 s in all.
   - **Codex**: a plugin whose `SessionStart` hook runs the same script. Codex runs hooks
     in a background server its terminals share (see [Limits](#limits)), so the hook only
     labels a terminal where Codex is the program in front and isn't resuming another
     session, and skips threads Codex starts for itself.
   - **OpenCode 2**: [`opencode/tui.js`](opencode/tui.js), a TUI plugin, so it runs in
     the terminal's own TUI whichever server that TUI uses (the shared background service,
     `--standalone`, `--server`). The session the TUI shows (its root, for a sub-agent's) is
     the record. OpenCode exits 0 both when the person quits and on SIGHUP or SIGTERM (a
     closed terminal, a core stop, a shutdown); a listener put ahead of OpenCode's own sees
     those first, so only an exit 0 without one marks the session ended.
   - **Pi**: [`pi/herdr-recover.ts`](pi/herdr-recover.ts), in interactive Pi only,
     records the session once it has a file (at its first prompt, or at its start when
     resumed). Pi's `session_shutdown` says "quit" for SIGHUP and SIGTERM too; the same
     kind of listener tells them apart.
2. **herdr-core's shell** ([`hook/recover-shell.sh`](hook/recover-shell.sh)) is what hc
   starts for every new terminal and, in a kept terminal whose program was lost, for the
   shell that replaces it. It starts one background job and becomes your shell (exec: same
   pid), so a terminal opens as fast as before and a shell starts whatever the job finds.
   The job reads the terminal's labels, waiting out the moment the core still calls the
   terminal lost, and then:
   - a session ended by the person: forgets it (clears the labels);
   - Auto turned off, or a resume marked failed: leaves it to the dialog;
   - otherwise claims the terminal (`recover.shell` = the new shell's pid, so nothing sends
     it twice), waits 1.5 s for the shell's profile, and types the resume line with
     `hc send` (`cd -- '<folder>' && claude … --resume <id>` in sh shells,
     `Set-Location -LiteralPath '<folder>'; & 'claude' … '--resume' '<id>'` in PowerShell),
     as a sender with no terminal of its own, so hc types it as it is.

   It finds hc from the process that started it (hc's own holder), since the core's PATH
   is often bare. On Windows, the configured shell is PowerShell with `-NoExit -Command`:
   the command starts `sh.exe recover-shell.sh --job <terminal> <pid> pwsh <hc>` hidden,
   then PowerShell carries on as your shell.
3. **The mod** (optional, `mods/recover/main.js`) runs in the app's status bar and dialog
   and lists every terminal carrying `recover.session`, on every machine: Running, Lost to
   a restart (until its new shell resumes it), Resume failed (the agent didn't come up
   within 60 seconds of a resume) and Interrupted (the agent died, its shell lived on). It
   forgets a Codex session it sees quit. Resume, Forget and Auto act on the labels.

Labels live on herdr-core's terminal record: they survive core restarts and reboots and
go away with the terminal. `hc get t3 --json` shows them.

## Limits

- **A Codex session you quit comes back after the next restart**, unless the app saw you
  quit it. Codex's `SessionEnd` fires alike for a quit, a kill and an idle unload (its
  reason is always "other"), and Codex has no plugin running in its TUI.
- **Codex shares one background server between its terminals**, and runs hooks there
  with the environment of the terminal that started it. So with several Codex terminals,
  a session started in another one than that is not remembered (Recover's checks keep it
  from landing on the wrong terminal). Run `codex --no-daemon` in herdr terminals for every
  session to be remembered; the flag is carried to the resume.
- **OpenCode 1** gets the plugin file of before: its sessions are resumed, but one you quit
  comes back after a restart unless the app saw you quit it.
- **An agent that died under a shell that lived on** (Interrupted) is not resumed by
  itself: the shell isn't new. The dialog offers Resume, or type it yourself.
- **Nothing happens until something starts the core** after a reboot: the Herdr app
  reconnecting, or any `hc` command. Then the kept terminals get their new shells.
- **Windows is untested**, and Codex isn't supported there.
- **A `shell` set over several lines** in herdr-core's config is left alone by the
  installer: put it on one line first.
- Typing into a shell that is still reading its profile relies on the terminal keeping the
  input, as the Herdr TUI did. A prompt that discards typed-ahead input (zsh instant prompt
  with some settings) can lose the line; the app then reports "Resume failed".
- **Resume in a shell whose agent crashed** (Interrupted, the dialog's Resume) can type
  garbage: the dead agent leaves its terminal modes on (bracketed paste, the kitty
  keyboard), and PowerShell's line editor reads the paste markers as keys. Type the resume
  command yourself there, or open a new tab.

## Development

```sh
npm test    # the rules, recover-shell.sh (against the mod's rules and a fake hc), the
            # OpenCode and Pi plugins, install.sh in a throwaway home, then the hook
```

`herdr-app check mods/recover` loads the mod once. Run the shell tests on Linux too
(`sh test/hook.test.sh` and `node --test` in WSL): `/bin/sh` is dash there, and the flag
reading only runs where `/proc` exists. `RECOVER_SOURCE=$PWD sh install.sh` installs the
integrations from the clone; `claude --plugin-dir .` loads the Claude Code plugin for one
session. To try herdr-core's shell without touching your own core, run a second one: with
`XDG_RUNTIME_DIR` set to a short folder of your own (sockets are limited to 108 bytes, and
no systemd there keeps it a plain process), `XDG_STATE_HOME` and `XDG_CONFIG_HOME` elsewhere,
and `HC_SESSION=test`, `hc` talks to that core only.

## Credits

The flag allowlist and much of the state model come from
[herdr-revive](https://github.com/dmazlum/herdr-revive) (MIT). The resume commands, and
the way of telling a quit from a lost terminal, are the Herdr TUI's (`src/agent_resume.rs`
and its integrations in [herdr](https://github.com/herdrdev/herdr)).

## License

MIT
