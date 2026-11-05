# ↻ herdr-recover

Bring back the coding agent a [Herdr](https://herdr.dev) terminal lost to a restart or a
reboot, **on this computer and on the machines it is connected to** (a WSL distro, a
server), from the Herdr app. Claude Code, Codex, OpenCode and Pi. Windows included.

Herdr keeps terminals through app restarts and updates. When the machine reboots or
herdr-core stops, kept terminals come back as fresh shells in the same folder, but the
agent that ran there is gone. Recover remembers which session each terminal held and,
when the terminal comes back as a new shell, types the command that resumes it, with the
same flags.

Status: **v0.2.** Tested end to end on Windows + WSL. In WSL, Claude Code, Codex, OpenCode
and Pi terminals whose shells were killed (a real hc loss and recovery) came back on their
conversations with their flags, and quitting each agent made Recover forget its session.
On Windows, Claude Code: a fresh PowerShell carrying a lost session got it back, and the
whole set came back from an `hc server stop`. Not yet tried through a full reboot. See
[Limits](#limits).

| Agent | Recover comes as | Resumes with | Windows |
|---|---|---|---|
| Claude Code | a plugin (hooks) | `claude … --resume <id>` | yes |
| Codex | a plugin (hook) | `codex resume … <id>` | no |
| OpenCode | a plugin file | `opencode … --session <id>` | untested |
| Pi | a package (extension) | `pi … --session <id>` | untested |

## How it differs from Revive

[herdr-revive](https://github.com/dmazlum/herdr-revive) and
[herdr-agent-resume](https://github.com/thuanlm215/herdr-agent-resume) resume from the
shell: a block in `.zshrc`/`.bashrc` asks, as the recovered shell starts, whether there is
something to resume. That needs a block per shell, a runtime (node, python) on every
machine, and it can't work in PowerShell.

Recover does it the way the Herdr TUI did: **the app types the resume command into the
restored shell.** Typing into a shell works the same in bash, zsh, fish and PowerShell, on
every OS, and a shell on another machine is just an `hc send wsl/t3 …` away. What each
machine needs is only what tells hc which session a terminal holds: a hook or plugin in
each agent, installed the agent's own way.

| | Revive | Recover |
|---|---|---|
| Who resumes | the shell's rc file | the Herdr app (a mod) |
| Windows (PowerShell) terminals | no | yes |
| Remote / WSL terminals | no (my branch: yes, with node there) | yes |
| Needs on each agent machine | node, an rc block, hooks | `hc`, and the agent's plugin |
| Works while the app is closed | yes | no: it resumes when the app opens |

The last row matters less than it seems: after a reboot the terminals only come back once
something starts the core, and for a WSL distro or a remote machine that is the app
reconnecting.

## Install

With a coding agent, paste this to it:

```text
Install https://github.com/guillaume86/herdr-recover, following its README.
```

By hand: on **every machine whose agents should come back** (this computer, each WSL distro, each
server), set up each agent you use there. Each one takes Recover its own way, so its own
commands update and remove it:

```sh
# Claude Code (in Claude Code itself: /plugin install herdr-recover --marketplace guillaume86/herdr-recover)
claude plugin marketplace add guillaume86/herdr-recover
claude plugin install herdr-recover@herdr-recover

# Codex (Linux, macOS): the next time it starts, Codex asks to trust the new hook
codex plugin marketplace add guillaume86/herdr-recover
codex plugin add herdr-recover@herdr-recover

# Pi
pi install git:github.com/guillaume86/herdr-recover

# OpenCode: one plugin file
mkdir -p ~/.config/opencode/plugins
curl -fsSL -o ~/.config/opencode/plugins/herdr-recover.js \
  https://raw.githubusercontent.com/guillaume86/herdr-recover/main/opencode/herdr-recover.js
```

Or let the installer do it for every agent it finds (on Windows, from Git Bash):

```sh
git clone https://github.com/guillaume86/herdr-recover
sh herdr-recover/install.sh            # --doctor: what is set up; --uninstall: take it out
```

The hooks need `hc` on their PATH (`RECOVER_HC` overrides). Updates: `claude plugin update
herdr-recover@herdr-recover`, `codex plugin marketplace upgrade herdr-recover`, `pi update`,
and `install.sh` again for OpenCode.

Then, **on the computer that runs the Herdr app only**:

1. Copy `mods/recover` to `~/.config/herdr-app/mods/recover` and run
   `herdr-app check ~/.config/herdr-app/mods/recover`.
2. Put the mod in your layout's status bar, so it watches while the app is open (a clone
   of the shipped layout, since shipped ones are replaced at start):

   ```json
   { "id": "recover", "type": "block", "size": { "px": 120 }, "content": { "mod": "recover" } }
   ```

3. Merge [`keys.json`](keys.json): `ctrl-shift-r` opens the dialog.

Sessions already running are remembered from their next start (or `/resume`).

## Uninstall

With a coding agent, paste this to it:

```text
Uninstall https://github.com/guillaume86/herdr-recover, following its README.
```

By hand, on each machine, for the agents you set up there (`sh install.sh --uninstall` does
all of them):

```sh
claude plugin uninstall herdr-recover@herdr-recover && claude plugin marketplace remove herdr-recover
codex plugin remove herdr-recover@herdr-recover && codex plugin marketplace remove herdr-recover
pi remove git:github.com/guillaume86/herdr-recover
rm ~/.config/opencode/plugins/herdr-recover.js
```

On the computer that runs the Herdr app: delete `~/.config/herdr-app/mods/recover`, the
`recover` block from your layout, and the `mod.open:recover` key from `keys.json`. The
`recover.*` labels left on terminals do nothing without the mod and go away with them.

## How it works

1. **Each agent's integration** labels the terminal it runs in (`HC_TERMINAL_ID` is set
   there) with `recover.session`, the folder, the carried flags and the terminal's own
   program pid (`recover.shell`):
   - **Claude Code**: a plugin whose `SessionStart` and `SessionEnd` hooks run
     [`hook/recover-hook.sh`](hook/recover-hook.sh) (`sh`, Git Bash on Windows, with `sed`
     and `hc` only). It also records the agent's session file
     (`~/.claude/sessions/<pid>.json`) and reads the flags from `/proc` on Linux (on Windows
     the mod reads them once from the agent's command line). It skips `claude -p` runs an
     agent starts as a tool, and sub-agents. At `SessionEnd`, `/exit`, Ctrl+C and `/logout`
     mark the session ended (`recover.ended=<id>`, which the mod then forgets); a signal
     (`other`) keeps it. That costs one `hc` call and no other process: Claude Code gives
     plugin `SessionEnd` hooks 1.5 s in all, and under Git Bash a process can take a third
     of it. `SessionStart` runs with `"async": true`, so Claude doesn't wait for it.
   - **Codex**: a plugin whose `SessionStart` hook runs the same script. Codex runs hooks
     in a background server its terminals share (see [Limits](#limits)), so the hook only
     labels a terminal where Codex is the program in front and isn't resuming another
     session, and skips threads Codex starts for itself.
   - **OpenCode**: [`opencode/herdr-recover.js`](opencode/herdr-recover.js), loaded by the
     terminal's OpenCode (not `opencode run`, `serve` or `attach`), records the root session
     last created or written to.
   - **Pi**: [`pi/herdr-recover.ts`](pi/herdr-recover.ts), in interactive Pi only, records
     the session once it has a file (at its first prompt, or at its start when resumed).
2. **The mod** (`mods/recover/main.js`) runs in the app's status bar (and in its dialog),
   in two passes over every terminal the app sees, on every machine, that carries
   `recover.session`. Every second it looks for losses in what the app already knows
   (`terminals()`: no process starts, nothing that waits on a core that is down), and
   resumes them all at once, 1.5 s after each new shell appears. Every 5 seconds it asks the
   machines what runs, for the list and for resumes that didn't come up:
   - **Lost**: the terminal's program is no longer the one recorded: a new shell after a
     restart. Once that shell has been up 1.5 s, the mod types the resume line into it
     with `hc send` (`cd -- '<folder>' && claude … --resume <id>` in sh shells,
     `Set-Location -LiteralPath '<folder>'; & 'claude' … '--resume' '<id>'` in
     PowerShell), claiming the terminal first so no other copy sends it twice. For a
     terminal on another machine, `hc send` runs on that machine (`exec … { on }`): sent
     from here, hc would wrap the line as a note from another machine
     (`<hc from="…">…</hc>`) when the terminal ever reported agent status.
   - **Running**: the agent is the terminal's foreground (Linux, macOS); its flags are read
     from there when its integration didn't record them. In a Windows shell, hc never sees
     a child program: there Claude Code's session file (which the hook names) must name the
     session *and* its pid must be a running `claude.exe` (`tasklist`), since a killed agent
     leaves its file behind; for OpenCode and Pi, the pid their plugin recorded must run.
   - **Quit**: Codex, OpenCode and Pi have no end-of-session hook that tells a quit from a
     restart (Codex's `SessionEnd` also fires after 30 idle minutes). When the mod sees one
     of them gone from the shell it ran under for 8 seconds, it forgets the session.
   - **Resume failed**: the agent didn't come up within 60 seconds of a resume. A toast
     says so; the dialog offers a retry. A failed session is not tried again by itself;
     if it comes up late after all, the mark goes.
   - **Interrupted**: Claude Code died but its shell lived on (a crash). Not resumed by
     itself (you were there); the dialog offers Resume and Forget.
3. **The dialog** (`ctrl-shift-r`) lists the focused terminal's session, the ones that need
   you and the rest, with Resume, Forget and an Auto toggle per terminal
   (`recover.auto=off`), and shows which agents are set up on which machine.

Labels live on herdr-core's terminal record: they survive core restarts and reboots and
go away with the terminal. `hc get t3 --json` shows them.

## Limits

- **Codex shares one background server between its terminals**, and runs hooks there
  with the environment of the terminal that started it. So with several Codex terminals,
  a session started in another one than that is not remembered (Recover's checks keep it
  from landing on the wrong terminal; the Herdr TUI's integration has the same gap). Run
  `codex --no-daemon` in herdr terminals for every session to be remembered: each Codex
  then runs its own hooks, and the flag is carried to the resume.
- **A Codex, OpenCode or Pi session quit while the app was closed** is resumed after the
  next restart: only the app sees those agents end.
- **Codex isn't supported on Windows**, and OpenCode and Pi there are untested.
- **Not yet tried through a full reboot or `wsl --shutdown`**, only through losses of a
  few terminals and a core stop. hc gives a WSL distro's kept terminals their new shells
  about a minute after its core starts.
- **Resume in a shell whose agent crashed** (Interrupted, the dialog's Resume) can type
  garbage: the dead agent leaves its terminal modes on (bracketed paste, the kitty
  keyboard), and PowerShell's line editor reads the paste markers as keys. After a
  restart the shell is fresh and this doesn't happen. Until it's fixed, type the resume
  command yourself there, or open a new tab.
- Typing into a shell that is still reading its profile relies on the terminal keeping the
  input, as the Herdr TUI did. A prompt that discards typed-ahead input (zsh instant prompt
  with some settings) can lose the line; the mod then reports "Resume failed".
- Nothing happens while the app is closed. On a headless server you never open the app
  for, nothing is resumed until you do.

## Development

```sh
npm test    # unit tests for the rules, then the hook against a fake hc
```

`herdr-app check mods/recover` loads the mod once. Run the hook tests on Linux too
(`sh test/hook.test.sh` in WSL): `/bin/sh` is dash there, and the flag reading only runs
where `/proc` exists. `RECOVER_SOURCE=$PWD sh install.sh` installs the integrations from
the clone; `claude --plugin-dir .` loads the Claude Code plugin for one session.

## Credits

The flag allowlist and much of the state model come from
[herdr-revive](https://github.com/dmazlum/herdr-revive) (MIT). The app-side design and the
resume commands are the Herdr TUI's (`src/app/agent_resume.rs` in
[herdr](https://github.com/herdrdev/herdr)).

## License

MIT
