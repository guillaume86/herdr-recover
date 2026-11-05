# ↻ herdr-recover

Bring back the coding agent a [Herdr](https://herdr.dev) terminal lost to a restart or a
reboot, **on this computer and on the machines it is connected to** (a WSL distro, a
server), from the Herdr app. Windows included.

Herdr keeps terminals through app restarts and updates. When the machine reboots or
herdr-core stops, kept terminals come back as fresh shells in the same folder, but the
agent that ran there is gone. Recover remembers which session each terminal held and,
when the terminal comes back as a new shell, types the command that resumes it, with the
same flags.

Status: **v0.1, Claude Code only.** Tested end to end on Windows + WSL: a WSL terminal whose
shell was killed (a real hc loss and recovery) came back on its conversation with its
flags, and on Windows a fresh PowerShell carrying a lost session got it back. Not yet
tried through a full reboot. See [Limits](#limits).

## How it differs from Revive

[herdr-revive](https://github.com/dmazlum/herdr-revive) and
[herdr-agent-resume](https://github.com/thuanlm215/herdr-agent-resume) resume from the
shell: a block in `.zshrc`/`.bashrc` asks, as the recovered shell starts, whether there is
something to resume. That needs a block per shell, a runtime (node, python) on every
machine, and it can't work in PowerShell.

Recover does it the way the Herdr TUI did: **the app types the resume command into the
restored shell.** Typing into a shell works the same in bash, zsh, fish and PowerShell, on
every OS, and a shell on another machine is just an `hc send wsl/t3 …` away. What each
machine needs is only the hook that remembers the session, written in `sh` (Git Bash on
Windows, which Claude Code runs hooks with), using `sed` and `hc`.

| | Revive | Recover |
|---|---|---|
| Who resumes | the shell's rc file | the Herdr app (a mod) |
| Windows (PowerShell) terminals | no | yes |
| Remote / WSL terminals | no (my branch: yes, with node there) | yes |
| Needs on each agent machine | node, an rc block, hooks | `sh`, `hc`, hooks |
| Works while the app is closed | yes | no: it resumes when the app opens |

The last row matters less than it seems: after a reboot the terminals only come back once
something starts the core, and for a WSL distro or a remote machine that is the app
reconnecting.

## Install

On **every machine whose agents should come back** (this computer, each WSL distro, each
server), in a terminal there:

```sh
git clone <this repo> herdr-recover   # or copy it there
sh herdr-recover/install.sh
```

On Windows, run it from Git Bash. It copies the hook to
`~/.local/share/herdr-recover/recover-hook.sh` and adds it to Claude Code's
`~/.claude/settings.json` as a `SessionStart` and a `SessionEnd` hook, after the hooks
already there (the original file is kept as `settings.json.recover-backup`). Editing the
JSON needs `python3` or `jq` at install time; the hook needs neither.
`sh install.sh --doctor` says what is installed; `--uninstall` takes it out.

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

## How it works

1. **The hook** (`hook/recover-hook.sh`) runs at Claude Code's `SessionStart` in a herdr
   terminal (`HC_TERMINAL_ID` is set) and labels the terminal: `recover.session`, the
   folder, the carried flags (read from `/proc` on Linux; on Windows the mod reads them
   once from the agent's command line), the agent's session file
   (`~/.claude/sessions/<pid>.json`), and the terminal's own program pid
   (`recover.shell`). It skips sessions that aren't interactive (a `claude -p` an agent
   runs as a tool inherits `HC_TERMINAL_ID`) and sub-agents. At `SessionEnd`, `/exit`,
   Ctrl+C and `/logout` forget the session; a signal (`other`) keeps it; `/clear` and
   `/resume` leave it to the next `SessionStart`. The `SessionStart` hook is installed
   with `"async": true`, so Claude doesn't wait for it: under Git Bash every process
   start can cost hundreds of milliseconds, so the hook parses JSON with one `sed` per
   document and otherwise uses shell builtins.
2. **The mod** (`mods/recover/main.js`) runs in the app's status bar (and in its dialog),
   in two passes over every terminal the app sees, on every machine, that carries
   `recover.session`. Every second it looks for losses in what the app already knows
   (`terminals()`: no process starts, nothing that waits on a core that is down), and
   resumes them all at once, 1.5 s after each new shell appears. Every 5 seconds it asks the
   machines what runs, for the list and for resumes that didn't come up:
   - **Lost**: the terminal's program is no longer the one recorded: a new shell after a
     restart. Whatever files the old agent left, it can't be running in the new shell.
     Once that shell has been up 1.5 s, the mod types the resume line into it
     with `hc send` (`cd -- '<folder>' && claude … --resume <id>` in sh shells,
     `Set-Location -LiteralPath '<folder>'; & 'claude' … '--resume' '<id>'` in
     PowerShell), claiming the terminal first so no other copy sends it twice. For a
     terminal on another machine, `hc send` runs on that machine (`exec … { on }`): sent
     from here, hc would wrap the line as a note from another machine
     (`<hc from="…">…</hc>`) when the terminal ever reported agent status.
   - **Running**: the agent is the terminal's foreground (Linux, macOS). In a Windows
     shell, hc never sees a child program, so there the agent's session file
     (`sessions/<pid>.json`, which the hook names) must name the session *and* its pid
     must be a running `claude.exe` (`tasklist`): a killed agent leaves its file behind.
   - **Resume failed**: the agent didn't come up within 60 seconds of a resume. A toast
     says so; the dialog offers a retry. A failed session is not tried again by itself;
     if it comes up late after all, the mark goes.
   - **Interrupted**: the agent died but its shell lived on (a crash). Not resumed by
     itself (you were there); the dialog offers Resume and Forget.
3. **The dialog** (`ctrl-shift-r`) lists the focused terminal's session, the ones that need
   you and the rest, with Resume, Forget and an Auto toggle per terminal
   (`recover.auto=off`), and shows which machines have the hook.

Labels live on herdr-core's terminal record: they survive core restarts and reboots and
go away with the terminal. `hc get t3 --json` shows them.

## Limits

- **Claude Code only** for now. The agent table (`AGENTS` in `lib/core.js`, with the
  flag allowlist from herdr-revive) is built to take Codex and others, but each needs its
  hook and its "is it running" signal.
- **Not yet tried through a full reboot or `wsl --shutdown`**, only through single-terminal
  losses (see Status). hc's holder is shared by every terminal on a machine, so a real
  multi-terminal recovery needs a core restart.
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
- The hook needs `hc` on the PATH that Claude Code's hooks get (`RECOVER_HC` overrides).

## Development

```sh
npm test    # unit tests for the rules, then the hook against a fake hc
```

`herdr-app check mods/recover` loads the mod once. Run the hook tests on Linux too
(`sh test/hook.test.sh` in WSL): `/bin/sh` is dash there, and the flag reading only runs
where `/proc` exists.

## Credits

The flag allowlist and much of the state model come from
[herdr-revive](https://github.com/dmazlum/herdr-revive) (MIT). The app-side design is the
Herdr TUI's (`src/app/agent_resume.rs` in [herdr](https://github.com/herdrdev/herdr)).

## License

MIT
