// Recover: the coding-agent sessions remembered on terminals, from the Herdr app.
//
// Each agent's integration remembers its session as labels on its herdr-core
// terminal, on whatever machine the agent runs, and herdr-core's shell there
// (hook/recover-shell.sh) types the resume command into a kept terminal's new
// shell after a restart or a reboot. None of that needs the app. This mod, which
// is optional, shows those sessions for every terminal the app can see (this
// computer and the machines it is connected to): which run, which a restart
// took, which a resume didn't bring back, and which died under a shell that
// lived on (Interrupted), which nothing resumes by itself.
//
// Two copies of the mod run: a status-bar block (with a count) and the popup it
// opens above itself, which lists the sessions by machine and offers Resume,
// Forget and an auto-resume switch. The `recover.toggle` command opens or closes
// the popup (bind it in keys.json if you want a key; none is set by default).
// Either copy keeps the list while it is up; without the block in the layout,
// `mod.open:recover` shows the same list in a dialog.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Switch } from "gpui-base";
import { hc, exec, run, theme, terminals, focused, home, props, closeOverlay, openOverlay, nextCommand, notify, shared, setShared, window as appWindow, readTextFile, machines, settings } from "herdr";
import {
  AGENTS, PREFIX, agentOf, agentForApp, carriedFlags, readRecord, labelArgs, clearArgs, stateOf, decide, resumeLine, shellKind,
  isWindowsShell, parseTasklist,
  parseSessionFiles, winArgv, shortId, ago, splitAddress, psQuote,
} from "./lib/core.js";

// How often the list asks the machines what runs (tasklist, session files), and so notices
// resumes that didn't come up.
const SLOW_MS = 5000;
const STATE_KEY = "recover.state";
const HOOK_MARK = "herdr-recover";
// The bar item's content sits in a pill (PILL_X a side) that lights up on hover and stays pressed
// while the popup is open, like the tab bar's Files / Changes buttons. PAD + PILL_X = 8 keeps the
// icon 16 px from its neighbours; PILL_H 21 in a 30 px bar sits on whole pixels at 100, 110, 120 %.
const PAD = 2, PILL_X = 6, PILL_H = 21;
// The popup: a card above the bar item, right-aligned with it (from the recover.toggle command, with
// no press to anchor on, a dialog in the middle of the window). POPUP_OPEN holds its overlay id while
// it is up, for the bar's pressed look and the command's toggle; POPUP_CLOSED when it last closed,
// since the press that closes a popup also reaches the bar, whose click would open it again.
const POPUP_W = 380, GAP = 6, SAME_PRESS = 250;
const POPUP_OPEN = "recover.popup";
const POPUP_CLOSED = "recover.popup-closed";
// The card's height is estimated before it opens: its fixed parts, a session row, a machine heading.
// Measured at 100 % with some slack: the box above the card is transparent, so too much costs nothing.
const CARD_CHROME = 112, ROW_H = 50, GROUP_H = 44, SETUP_LINE_H = 40;
// A session row's second line starts under its name: the 7 px dot and the 8 px gap before the name.
const INDENT = 15;

const STATE = {
  running: { word: "Running", color: (t) => t.ansi2 },
  lost: { word: "Lost to a restart", color: (t) => t.ansi3 },
  interrupted: { word: "Interrupted", color: (t) => t.ansi3 },
  failed: { word: "Resume failed", color: (t) => t.ansi1 },
};
const NEEDS_YOU = new Set(["lost", "interrupted", "failed"]);

const isWindows = () => { try { return appWindow()?.platform === "windows"; } catch { return false; } };

/**
 * The mod's memory across copies, passes and app restarts: when each agent was last seen
 * live, and the list the bar and the dialog draw.
 */
function mem() { return { live: {}, gone: {}, flags: {}, entries: [], hooks: {}, at: 0, ...(shared(STATE_KEY) ?? {}) }; }
// Setting shared state redraws every mod in the window: only write what changed.
function remember(m) {
  const before = JSON.stringify(shared(STATE_KEY) ?? null);
  if (JSON.stringify(m) !== before) setShared(STATE_KEY, m);
}

/** A terminal as the app knows it now (terminals() carries what `hc get` does). */
const terminalNow = (address) => terminals().find((t) => t.address === address) ?? null;

/** Claude Code's sessions/<pid>.json files on a machine: which sessions are running there, under which pid. */
async function sessionsOn(on, dirs) {
  const extra = [...new Set(dirs.filter(Boolean))];
  let r;
  try {
    if (!on && isWindows()) {
      const roots = [`${home()}\\.claude`, ...extra].map((d) => psQuote(d)).join(", ");
      r = await exec("powershell", ["-NoProfile", "-Command",
        `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); foreach ($d in @(${roots})) { Get-ChildItem -LiteralPath (Join-Path $d 'sessions') -Filter *.json -ErrorAction SilentlyContinue | ForEach-Object { Get-Content -Raw -LiteralPath $_.FullName; '' } }`]);
    } else {
      r = await exec("sh", ["-c", 'for d in "${CLAUDE_CONFIG_DIR:-$HOME/.claude}" "$@"; do cat "$d"/sessions/*.json 2>/dev/null; echo; done', "sessions", ...extra], { on });
    }
  } catch { return null; }
  return r.code === 0 || r.stdout ? parseSessionFiles(r.stdout) : null;
}

/** The processes running on a Windows machine, pid → image (one tasklist, cheaper than PowerShell). */
async function runningPids(on) {
  try {
    const r = await exec("tasklist", ["/FO", "CSV", "/NH"], { on });
    return parseTasklist(r.stdout);
  } catch { return new Map(); }
}

/** The command line of a Windows process, for the flags the hook couldn't read there. */
async function winCommandLine(pid) {
  try {
    const r = await exec("powershell", ["-NoProfile", "-Command", `(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}").CommandLine`]);
    return r.code === 0 ? r.stdout.trim() : "";
  } catch { return ""; }
}

// Which agents a machine has, and whether Recover is set up for each: `agent=1` or `agent=0`
// lines, one per agent whose config folder exists. Claude Code's plugin (or an older install's
// hook) shows in its settings, Codex's in its config, Pi's package in its settings, and
// OpenCode 2's plugin is a folder listed in its cli.json.
const INTEGRATIONS = `
has() { grep -qs ${HOOK_MARK} "$@" && echo 1 || echo 0; }
d=\${CLAUDE_CONFIG_DIR:-$HOME/.claude}; [ -d "$d" ] && echo "claude=$(has "$d/settings.json")"
d=\${CODEX_HOME:-$HOME/.codex}; [ -d "$d" ] && echo "codex=$(has "$d/config.toml" "$d/hooks.json")"
d=\${OPENCODE_CONFIG_DIR:-\${XDG_CONFIG_HOME:-$HOME/.config}/opencode}; [ -d "$d" ] && echo "opencode=$([ -f "$d/${HOOK_MARK}/tui.js" ] && grep -qsF '"./${HOOK_MARK}"' "$d/cli.json" && echo 1 || echo 0)"
d=\${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}; [ -d "$d" ] && echo "pi=$(has "$d/settings.json")"
echo "core=$(has "\${XDG_CONFIG_HOME:-$HOME/.config}/herdr-core/config.toml" "\${APPDATA:-/nonexistent}/herdr-core/config.toml")"
true`;

/**
 * { agent: true|false } for the agents a machine has, and `core`: whether its herdr-core
 * runs Recover's shell (which does the resuming there). Null when unknown.
 */
async function integrations(on) {
  try {
    if (!on && isWindows()) {
      // Here only Claude Code: Recover's other integrations are tested on Linux and macOS.
      const text = await readTextFile(`${home()}/.claude/settings.json`).catch(() => null);
      const core = await readTextFile(`${home()}/AppData/Roaming/herdr-core/config.toml`).catch(() => null);
      return { ...(text === null ? {} : { claude: text.includes(HOOK_MARK) }), core: Boolean(core?.includes(HOOK_MARK)) };
    }
    const r = await exec("sh", ["-c", INTEGRATIONS], { on });
    const found = [...r.stdout.matchAll(/^(\w+)=([01])$/gm)];
    return {
      ...Object.fromEntries(found.filter((m) => AGENTS[m[1]]).map((m) => [m[1], m[2] === "1"])),
      core: found.some((m) => m[1] === "core" && m[2] === "1"),
    };
  } catch { return null; }
}

/**
 * One pass: read every remembered terminal, work out its state, resume what was
 * lost, drop what the person quit, and publish the list for the dialog and the bar.
 */
async function scan({ setup = false } = {}) {
  let m = mem();
  if (m.busy && Date.now() - m.busy < 20_000) return;
  m.busy = Date.now();
  remember(m);
  try {
    const infos = terminals().filter((t) => t.state === "live" && t.labels?.[`${PREFIX}session`]);
    // Where hc sees the program in front (Linux, macOS), that alone says whether the agent runs.
    // In a Windows shell it never does: there the agent's session file must name the session
    // (the hook records which file) and its pid must be a running agent. A killed agent leaves
    // its file behind, so the file alone proves nothing. Only terminals still on the shell the
    // session ran under are asked: in a new shell the agent is gone whatever the files say.
    const asked = infos.filter((t) => {
      const rec = readRecord(t.labels);
      return rec && isWindowsShell(t.argv ?? []) && (rec.shell === null || rec.shell === t.pid);
    });
    const winFile = new Map(await Promise.all(asked.map(async (t) => {
      const rec = readRecord(t.labels);
      const on = splitAddress(t.address).on;
      // Other agents' plugins name their process: its pid running is enough.
      if (rec.agent !== "claude") return [t.address, null];
      if (rec.file) {
        const text = await readTextFile(rec.file, { on }).catch(() => null);
        return [t.address, parseSessionFiles(text).find((s) => s.session === rec.session) ?? null];
      }
      // A record without its file (an older hook): the machine's session files, listed.
      return [t.address, (await sessionsOn(on, rec.dir ? [rec.dir] : []))?.find((s) => s.session === rec.session) ?? null];
    })));
    const machinesAsked = [...new Set(asked.map((t) => splitAddress(t.address).on))];
    const agentPids = new Map(await Promise.all(machinesAsked.map(async (on) => [on, await runningPids(on)])));
    const now = Date.now();
    m = { ...mem(), busy: m.busy };
    const entries = [];
    for (const t of infos) {
      const rec = readRecord(t.labels);
      if (!rec) continue;
      const { on, id } = splitAddress(t.address);
      const fg = t.foreground;
      const file = winFile.get(t.address) ?? null;
      const windows = isWindowsShell(t.argv ?? []);
      const pids = agentPids.get(on);
      const live = windows
        ? Boolean(rec.agent === "claude" ? file?.pid && pids?.get(file.pid) === AGENTS.claude.image : rec.pid && pids?.has(rec.pid))
        : Boolean(fg && fg.pid !== t.pid && agentOf(fg.argv ?? [fg.name]) === rec.agent);
      const pid = t.pid ?? null;
      const state = stateOf(rec, { live, pid });
      if (live) m.live[t.address] = now;
      // When the agent was first seen gone from the shell it ran under, for this session.
      const gone = m.gone[t.address];
      if (state === "interrupted") {
        if (!gone || gone.session !== rec.session || gone.pid !== pid) m.gone[t.address] = { session: rec.session, pid, at: now };
      } else delete m.gone[t.address];
      // It came up after all (a slow start marked failed): the mark goes, without waiting for the hook.
      if (live && rec.failed && rec.shell === pid) {
        await hc(["label", t.address, ...labelArgs({ failed: null })]).catch(() => null);
        rec.failed = null;
      }
      const entry = {
        address: t.address, on, id, rec, state, pid, live,
        where: t.labels?.where ?? null, title: t.title ?? "",
        shell: shellKind(t.argv ?? []),
        busy: Boolean(fg && fg.pid && pid && fg.pid !== pid && !live),
      };
      // Flags the hook didn't record: where hc shows the agent in front (Linux, macOS), from its
      // command line there, which costs nothing. In a Windows shell, once, from the agent's
      // process (Claude Code: its pid is in its session file's name, sessions/<pid>.json).
      if (live && !rec.flags.length && !windows && fg?.argv?.length) {
        const flags = carriedFlags(rec.agent, fg.argv);
        if (flags.length) {
          await hc(["label", t.address, ...labelArgs({ flags: JSON.stringify(flags) })]).catch(() => null);
          rec.flags = flags;
        }
      }
      const agentPid = rec.pid ?? file?.pid ?? Number(/(\d+)\.json$/.exec(rec.file ?? "")?.[1] ?? 0);
      if (live && agentPid && !rec.flags.length && windows && !on && isWindows() && m.flags[rec.session] !== true) {
        m.flags[rec.session] = true;
        const argv = winArgv(await winCommandLine(agentPid));
        const flags = carriedFlags(rec.agent, argv);
        if (flags.length) await hc(["label", t.address, ...labelArgs({ flags: JSON.stringify(flags) })]);
      }
      // Seen live since the last resume: a later absence is a quit, not a failed resume.
      // Unknown when the mod never saw this terminal live (an app restart since).
      const cameBack = rec.resumed && m.live[t.address] ? m.live[t.address] > rec.resumed : null;
      // herdr-core's shell resumes what a restart took: this only notices resumes that never
      // came up, and the sessions of agents with no way to say they were quit.
      const action = decide(rec, { state, cameBack, now, goneSince: m.gone[t.address]?.at ?? null });
      if (action === "forget") {
        await hc(["label", t.address, ...clearArgs()]).catch(() => null);
        delete m.gone[t.address];
        continue;
      }
      if (action === "fail") {
        await hc(["label", t.address, ...labelArgs({ failed: now })]);
        entry.state = "failed";
        entry.rec = { ...rec, failed: now };
        notify({ title: "Recover", body: `${AGENTS[rec.agent].name} didn't come back in ${entry.where ?? t.address}. Open Recover to retry.`, level: "error" });
      }
      entries.push(entry);
    }
    m.entries = entries;
    m.at = now;
    const known = new Set(infos.map((t) => t.address));
    for (const address of Object.keys(m.gone)) if (!known.has(address)) delete m.gone[address];
    if (setup) {
      // This computer and every machine the app reaches now, plus any a record is on.
      let reachable = [];
      try { reachable = machines().filter((x) => x.name && x.layout !== "unavailable").map((x) => x.name); } catch { /* none */ }
      const places = [...new Set([null, ...reachable, ...infos.map((t) => splitAddress(t.address).on)])];
      m.hooks = Object.fromEntries(await Promise.all(places.map(async (on) => [on ?? "", await integrations(on)])));
    }
  } finally {
    m.busy = 0;
    remember(m);
  }
}

/** Types the resume line into the terminal. Marks the record first: the terminal is no longer lost. */
async function resume(entry) {
  const { rec, address, pid } = entry;
  const line = resumeLine(rec, entry.shell);
  if (!line) throw new Error(`Can't write a resume command for ${address}'s shell.`);
  const fresh = terminalNow(address);
  const current = readRecord(fresh?.labels);
  // The terminal changed under us: another program, another session.
  if (!current || current.session !== rec.session || fresh.pid !== pid) return false;
  await hc(["label", address, ...labelArgs({ shell: pid, resumed: Date.now(), failed: null })]);
  // Sent from the terminal's own machine. From here, a send to a terminal that ever reported
  // agent status (it stays latched after the agent dies) is wrapped as a note from another
  // machine, `<hc from="…/ppid:…">line</hc>`, which the shell can't run. A local sender with
  // no terminal of its own is no agent, so its text is typed as it is.
  const r = entry.on ? await exec("hc", ["send", entry.id, line], { on: entry.on }) : await hc(["send", address, line]);
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || `hc send ${address} failed`);
  return true;
}

function tilde(path, h) {
  if (!path || !h) return path;
  const sep = /^[A-Za-z]:/.test(h) ? "\\" : "/";
  return path === h ? "~" : path.startsWith(h + sep) ? "~" + path.slice(h.length) : path;
}

// A small text button, as in the Tunnels popup: dim, lit on hover.
function ghost(t, id, label, tip, onClick, { color = null, disabled = false } = {}) {
  return div().id(id).flex_none().px(5).py(1).rounded(4).text_color(disabled ? t.dim : color ?? t.dim)
    .when(disabled, (el) => el.opacity(0.5))
    .when(!disabled, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover).text_color(color ?? t.foreground)))
    .when(Boolean(tip), (el) => el.tooltip(tip))
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .on_click((e, cx) => { if (!disabled) onClick(e, cx); })
    .child(label);
}

// The Tunnels popup's switch. A Switch takes no tooltip, so the wrapper has it.
function toggle(t, id, on, tip, onChange, disabled = false) {
  return div().id(`${id}-tip`).flex_none().tooltip(tip)
    .child(Switch.new(id).checked(on).disabled(disabled).on_change((checked, cx) => onChange(cx, checked))
      .child(h_flex().w(26).h(14).px(2).rounded(7).items_center().bg(on ? t.accent : t.border).opacity(disabled ? 0.5 : 1)
        .cursor_pointer().when(on, (s) => s.justify_end())
        .child(div().size(10).rounded(5).bg(on ? t.accent_foreground : t.surface))));
}

/** The sessions by machine: this computer first, then the others by name; in each, those that need you first. */
function groups(entries) {
  const by = new Map();
  for (const e of entries) {
    const key = e.on ?? "";
    if (!by.has(key)) by.set(key, []);
    by.get(key).push(e);
  }
  const rank = (e) => (NEEDS_YOU.has(e.state) ? 0 : 1);
  return [...by.entries()]
    .sort(([a], [b]) => (a === "" ? -1 : b === "" ? 1 : a.localeCompare(b)))
    .map(([on, list]) => ({ on: on || null, list: [...list].sort((a, b) => rank(a) - rank(b)) }));
}

/** The counts the bar's tooltip and the popup share. */
function counts(entries) {
  const needs = entries.filter((e) => e.state === "lost" || e.state === "failed").length;
  const waiting = entries.filter((e) => e.state === "interrupted").length;
  const running = entries.filter((e) => e.state === "running").length;
  return [needs && `${needs} to recover`, waiting && `${waiting} interrupted`, running && `${running} running`].filter(Boolean).join(" · ");
}

export default class Recover extends View {
  init(_props, cx) {
    this.dialog = Boolean(props()?.overlay);
    // Opened by the bar or recover.toggle, the card draws its own frame; by mod.open, Herdr's dialog frames it.
    this.framed = props()?.popup === true;
    this.fitted = 0;
    this.note = null;
    this.busy = false;
    this.refreshing = false;
    this.anchor = null;
    this.pressed = 0;
    this.focus = this.dialog ? focused()?.terminal ?? null : null;
    if (this.dialog) {
      setShared(POPUP_OPEN, props().overlay);
      this.handle = cx.focus_handle();
      this.handle.focus();
      cx.timer.after(120, () => this.handle.focus());
    } else {
      // A popup never outlives the app: an id left over from a crash is cleared when the bar starts.
      if (shared(POPUP_OPEN)) setShared(POPUP_OPEN, null);
      // `recover.toggle` (a key someone binds in keys.json, the palette, `herdr-app do`) opens the
      // popup, or closes it when it is up.
      cx.spawn(async (cx) => {
        for (;;) {
          const command = await nextCommand();
          if (command !== "toggle" && command !== "open") continue;
          const open = shared(POPUP_OPEN);
          if (typeof open === "string" && open) {
            closeOverlay(open);
            setShared(POPUP_OPEN, null);
          } else this.open(true);
          cx.notify();
        }
      });
    }
    const tick = (cx, setup) => cx.spawn(async (cx) => {
      try { await scan({ setup }); }
      catch (e) { if (this.dialog) this.note = { level: "error", text: String(e?.message ?? e), from: "scan" }; }
      cx.notify();
    });
    tick(cx, true);
    cx.timer.every(SLOW_MS, (cx) => tick(cx, false));
  }

  render(cx) {
    return this.dialog ? this.renderPopup(cx) : this.renderBar();
  }

  // ── the status-bar block ──

  /** The block takes its content's width (measured zoomed; the layout is at zoom 1). `fit: false` keeps it. */
  fit(width) {
    if (props()?.fit === false) return;
    const px = Math.ceil(width / (Number(settings()?.zoom) || 1)) + 2 * PAD;
    if (px === this.fitted) return;
    this.fitted = px;
    run("layout.resize", { id: String(props()?.block ?? "recover"), px });
  }

  /** How tall the card wants to be, from what it will list. */
  wantedHeight() {
    const m = mem();
    const setupLines = Object.keys(m.hooks ?? {}).length ? 1 : 0;
    const list = m.entries.length ? groups(m.entries).length * GROUP_H + m.entries.length * ROW_H : 24;
    return CARD_CHROME + list + setupLines * SETUP_LINE_H;
  }

  /** Above the bar item, right-aligned with it, pinned to the bottom of a generous box; from a command, centred. */
  open(fromCommand = false) {
    const b = fromCommand ? null : this.anchor;
    const z = Number(settings()?.zoom) || 1;
    const want = this.wantedHeight();
    const height = b ? Math.min(want, b.y / z - GAP) : want;
    const at = b ? { x: Math.max(0, b.x + b.width - (POPUP_W + GAP) * z), y: b.y - (height + GAP) * z } : undefined;
    openOverlay({ mod: "recover", kind: b ? "popup" : "dialog", frame: "none", width: POPUP_W, height, ...(at && { at }), props: { popup: true, height } });
  }

  /** The press that closes the popup also reaches the bar, whose click would open it straight away. */
  toggle() {
    const closed = Number(shared(POPUP_CLOSED)) || 0;
    if (Math.abs(closed - this.pressed) >= SAME_PRESS) this.open();
  }

  // Styled like the native status items: a history icon, 13 px, in their muted grey, the counts
  // on hover; dim and faded with nothing on record. The theme's warning colors and a count beside the icon
  // when a restart took sessions a resume didn't bring back.
  renderBar() {
    const t = theme();
    const m = mem();
    // Interrupted sessions wait in the popup; the bar counts what a restart took.
    const needs = m.entries.filter((e) => e.state === "lost" || e.state === "failed");
    const edge = props()?.border;
    const openId = shared(POPUP_OPEN);
    const open = typeof openId === "string" && openId !== "";
    const count = m.entries.length ? counts(m.entries) : "No agent session on record";
    const tip = m.entries.length
      ? [count, ...m.entries.map((e) => `${e.where ?? e.address}: ${STATE[e.state]?.word ?? e.state}`)].join("\n")
      : `${count}. Recover remembers them as they start.`;
    const color = needs.some((e) => e.state === "failed") ? t.ansi1 : needs.length ? t.ansi3 : m.entries.length ? t.muted : t.dim;
    return h_flex().id("recover-bar").size_full().px(PAD).items_center().bg(t.chrome).text_size(11.8).cursor_pointer()
      .when(edge === "top", (el) => el.border_t(1).border_color(t.border))
      .when(edge === "bottom", (el) => el.border_b(1).border_color(t.border))
      .on_mouse_down("left", (e, cx) => { this.anchor = e.bounds ?? null; this.pressed = Date.now(); cx.stop_propagation(); })
      .on_click(() => this.toggle())
      .tooltip(tip)
      .child(h_flex().id("content").flex_none().h(PILL_H).px(PILL_X).rounded(6).gap(6).items_center()
        .when(open, (el) => el.bg(t.selected))
        .hover((s) => s.bg(t.hover))
        .on_size_change((size) => this.fit(size.width))
        .child(svg("mods/recover/history.svg").size(13).flex_none().text_color(open && color === t.muted ? t.foreground : color).opacity(m.entries.length ? 1 : 0.6))
        .when(needs.length > 0, (el) => el.child(div().text_color(color).child(String(needs.length)))));
  }

  // ── the popup ──

  /** Herdr calls this when the popup goes, however it was closed. */
  close() {
    if (!this.dialog) return;
    setShared(POPUP_CLOSED, Date.now());
    if (shared(POPUP_OPEN) === props().overlay) setShared(POPUP_OPEN, null);
  }

  dismiss() { closeOverlay(props().overlay); }

  entries() { return mem().entries; }
  current() { return this.entries().find((e) => e.address === this.focus) ?? null; }

  act(cx, work) {
    if (this.busy) return;
    this.busy = true;
    this.note = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try { await work(); }
      catch (e) { this.note = { level: "error", text: String(e?.message ?? e) }; }
      this.busy = false;
      try { await scan(); } catch { /* shown next tick */ }
      cx.notify();
    });
  }

  resumeNow(entry, cx) {
    this.act(cx, async () => {
      if (entry.live) throw new Error(`${AGENTS[entry.rec.agent].name} is already running in ${entry.address}.`);
      if (entry.busy) throw new Error(`${entry.address} is busy with another program. Quit it first.`);
      if (!(await resume(entry))) throw new Error(`${entry.address} changed; refreshed the list instead.`);
      this.dismiss();
      run("pane.focus", { terminal: entry.address });
    });
  }

  setAuto(entry, on, cx) { this.act(cx, () => hc(["label", entry.address, ...labelArgs({ auto: on ? null : "off" })])); }
  forget(entry, cx) { this.act(cx, () => hc(["label", entry.address, ...clearArgs()])); }

  refresh(cx) {
    if (this.refreshing) return;
    this.refreshing = true;
    cx.notify();
    cx.spawn(async (cx) => {
      await scan({ setup: true }).catch(() => {});
      this.refreshing = false;
      cx.notify();
    });
  }

  key(e, cx) {
    const k = e.key;
    if (k === "escape") { cx.stop_propagation(); this.dismiss(); return; }
    if (k === "r") { this.refresh(cx); return; }
    const entry = this.current();
    if (k === "enter" && entry && NEEDS_YOU.has(entry.state)) this.resumeNow(entry, cx);
  }

  folder(entry) {
    const h = entry.on ? null : home();
    return entry.on && entry.rec.cwd ? entry.rec.cwd.replace(/^\/home\/[^/]+(?=\/|$)/, "~") : tilde(entry.rec.cwd, h);
  }

  /** One session: a status dot, the agent and its session, its actions; under it, where it runs. */
  row(t, entry, i) {
    const { rec, state } = entry;
    const agent = AGENTS[rec.agent];
    const needs = NEEDS_YOU.has(state);
    const here = entry.address === this.focus;
    const s = STATE[state];
    const flags = rec.flags?.length ? rec.flags.join(" ") : null;
    const detail = [
      needs ? s?.word : null,
      this.folder(entry),
      entry.where ?? entry.address,
      rec.resumed ? `resumed ${ago(rec.resumed)}` : null,
    ].filter(Boolean).join(" · ");
    const why = state === "failed" ? "The last resume didn't bring the agent up. Check the terminal, then try again."
      : entry.busy ? "Another program is running in this terminal; quit it to resume here."
      : null;
    const title = h_flex().gap(8).items_center()
      .child(div().size(7).rounded(4).flex_none().bg(s ? s.color(t) : t.dim))
      .child(div().flex_none().text_color(t.foreground).child(agent?.name ?? rec.agent))
      .child(div().id(`sid-${i}`).flex_none().font_family("Geist Mono").text_size(11).text_color(t.dim)
        .tooltip(flags ? `${rec.session}\n${flags}` : rec.session).child(shortId(rec.session)))
      .when(here, (el) => el.child(div().flex_none().px(5).rounded(4).border(1).border_color(t.border).text_size(10.5).text_color(t.muted).child("focused")))
      .child(div().flex_1())
      .when(needs, (el) => el
        .child(ghost(t, `resume-${i}`, this.busy ? "Resuming…" : here ? "Resume ↵" : "Resume", `Type the resume command into ${entry.address}`,
          (_e, cx) => this.resumeNow(entry, cx), { color: t.accent, disabled: this.busy || entry.busy }))
        .child(ghost(t, `forget-${i}`, "✕", "Forget this session", (_e, cx) => this.forget(entry, cx), { disabled: this.busy })))
      .child(ghost(t, `go-${i}`, "›_", `Show ${entry.address}`, () => { this.dismiss(); run("pane.focus", { terminal: entry.address }); }))
      .child(toggle(t, `auto-${i}`, Boolean(rec.auto), rec.auto ? "Resumes by itself after a restart" : "Waits for you after a restart",
        (cx, on) => this.setAuto(entry, on, cx), this.busy));
    return v_flex().id(`row-${i}`).gap(2).px(6).py(4).rounded(6)
      .when(here, (el) => el.bg(t.raised))
      .child(title)
      .child(div().id(`detail-${i}`).pl(INDENT).truncate().text_size(11).text_color(t.dim).tooltip(detail).child(detail))
      .when(Boolean(why), (el) => el.child(div().pl(INDENT).text_size(11).text_color(t.dim).child(why)));
  }

  /** A machine and its sessions, under a thin line like the Tunnels popup's machines. */
  group(t, g, gi) {
    const name = g.on ?? "This computer";
    return v_flex().id(`group-${gi}`).gap(2).pt(10).border_t(1).border_color(t.border)
      .child(h_flex().gap(6).items_center().px(6).pb(2)
        .child(svg(`mods/workspace-chrome/${g.on ? "server" : "monitor"}.svg`).size(12).flex_none().text_color(t.dim))
        .child(div().text_size(11).font_medium().text_color(t.muted).child(name))
        .child(div().flex_1())
        .child(div().text_size(11).text_color(t.dim).child(counts(g.list))))
      .children(g.list.map((e, i) => this.row(t, e, `${gi}-${i}`)));
  }

  /** Whether each machine is set up, in one line; the details on hover, what is missing below. */
  setup(t) {
    const hooks = mem().hooks ?? {};
    const places = Object.keys(hooks).sort((a, b) => (a === "" ? -1 : b === "" ? 1 : a.localeCompare(b)));
    if (!places.length) return null;
    const missing = [];
    const marks = places.map((place, i) => {
      const name = place || "this computer";
      const agents = hooks[place];
      if (agents === null || typeof agents !== "object") {
        return h_flex().id(`setup-${i}`).gap(4).items_center().tooltip(`${name}: couldn't ask`)
          .child(div().text_color(t.dim).child("?")).child(div().text_color(t.dim).child(name));
      }
      const keys = Object.keys(agents).filter((k) => k !== "core");
      const gaps = [...(agents.core ? [] : ["herdr-core's shell"]), ...keys.filter((k) => !agents[k]).map((k) => AGENTS[k]?.name ?? k)];
      for (const g of gaps) missing.push(`${g} on ${name}`);
      const ok = gaps.length === 0;
      const tip = [`${name}: ${agents.core ? "herdr-core resumes" : "herdr-core doesn't resume"}`,
        ...keys.map((k) => `${AGENTS[k]?.name ?? k}: ${agents[k] ? "set up" : "not set up"}`)].join("\n");
      return h_flex().id(`setup-${i}`).gap(4).items_center().tooltip(tip)
        .child(div().text_color(ok ? t.ansi2 : t.ansi1).child(ok ? "✓" : "✕"))
        .child(div().text_color(ok ? t.muted : t.ansi1).child(name));
    });
    return v_flex().gap(6).pt(10).border_t(1).border_color(t.border).text_size(11)
      .child(h_flex().gap(12).items_center().flex_wrap().child(div().text_color(t.dim).child("Set up")).children(marks))
      .when(missing.length > 0, (el) => el.child(div().text_color(t.dim)
        .child(`Not set up: ${missing.join(", ")}. In a terminal there: sh install.sh from a clone of guillaume86/herdr-recover.`)));
  }

  renderPopup() {
    const t = theme();
    const m = mem();
    const entries = m.entries;
    const height = Number(props()?.height) || this.wantedHeight();
    const header = h_flex().justify_between().items_center()
      .child(h_flex().gap(8).items_center()
        .child(svg("mods/recover/history.svg").size(15).text_color(t.foreground))
        .child(div().text_size(13).font_semibold().text_color(t.foreground).child("Recover")))
      .child(this.refreshing || !m.at
        ? div().px(6).py(2).text_color(t.dim).child("Looking…")
        : ghost(t, "refresh", "Refresh", "Look again on every machine (r)", (_e, cx) => this.refresh(cx)));

    const notes = [];
    if (this.note) notes.push(div().text_size(11).text_color(this.note.level === "error" ? t.ansi1 : t.muted).child(this.note.text));
    // The focused terminal runs an agent nobody recorded: say so, with where the hook goes.
    if (this.focus && !this.current()) {
      const term = terminals().find((x) => x.address === this.focus);
      const app = agentForApp(term?.report?.app ?? term?.status?.app);
      if (app && term?.program?.agent) notes.push(div().text_size(11).text_color(t.dim)
        .child(`${AGENTS[app].name} in the focused terminal has no record: it started before the hook was installed, or the hook isn't installed on ${splitAddress(this.focus).on ?? "this computer"}. It is remembered from its next start.`));
    }
    if (m.at && !entries.length) notes.push(div().text_color(t.dim).child("No agent session on record. Recover remembers them as they start."));

    const gs = groups(entries);
    const list = gs.map((g, gi) => this.group(t, g, gi));
    const room = height - CARD_CHROME;
    const listWanted = gs.length * GROUP_H + entries.length * ROW_H;
    // A scroll area in an auto-height column measures as nothing, so the list scrolls in a fixed
    // height only when it doesn't fit; otherwise it simply takes its content's height.
    const body = listWanted > room
      ? v_flex().id("sessions").h(Math.max(80, room)).gap(10).overflow_y_scrollbar().children(list)
      : v_flex().id("sessions").gap(10).children(list);

    const card = v_flex().id("recover").track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx))
      .w_full().p(14).gap(10).text_size(12).text_color(t.muted).bg(t.popover)
      .when(this.framed, (el) => el.max_h(height).border(1).border_color(t.border).rounded(8))
      .child(header)
      .children(notes)
      .when(gs.length > 0, (el) => el.child(body))
      .children([this.setup(t)].filter(Boolean));
    // Pinned to the bottom of its box, so it grows upward from just above the bar.
    return this.framed ? v_flex().w_full().h(height).justify_end().child(card) : card;
  }
}
