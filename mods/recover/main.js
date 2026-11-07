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
// Two copies of the mod run: a status-bar block (with a count) and the dialog
// (`mod.open:recover`, Ctrl+Shift+R), which lists the sessions and offers
// Resume, Auto and Forget. Either copy keeps the list while it is up, so the
// dialog works even without the block in the layout.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { hc, exec, run, theme, terminals, focused, home, props, closeOverlay, notify, shared, setShared, window as appWindow, readTextFile, machines, settings } from "herdr";
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
const MAX_SHARE = 0.85;
const CHROME_H = 130;
const NOTE_H = 56;
// The bar's side padding: 8 a side, so the item sits 16 px from its neighbours like a native one.
const PAD = 8;

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

function listMaxH(withNote) {
  let height = null;
  try { height = window.viewport_size()?.height; } catch { /* no window yet */ }
  if (!Number.isFinite(height) || height <= 0) return null;
  return Math.max(160, Math.floor(height * MAX_SHARE) - CHROME_H - (withNote ? NOTE_H : 0));
}

function tilde(path, h) {
  if (!path || !h) return path;
  const sep = /^[A-Za-z]:/.test(h) ? "\\" : "/";
  return path === h ? "~" : path.startsWith(h + sep) ? "~" + path.slice(h.length) : path;
}

function button(t, id, label, onClick, { kind = "outline", hint = null, disabled = false } = {}) {
  const solid = kind === "solid";
  return h_flex().id(id).flex_none().h(28).px(10).gap(6).items_center().justify_center().rounded(7).text_size(12)
    .when(kind === "outline", (el) => el.border_1().border_color(t.border))
    .when(solid && !disabled, (el) => el.bg(t.solid).text_color(t.solid_foreground))
    .when(!solid, (el) => el.text_color(disabled ? t.dim : t.foreground))
    .when(disabled, (el) => el.opacity(0.5))
    .when(!disabled, (el) => el.cursor_pointer().hover((s) => (solid ? s.opacity(0.9) : s.bg(t.hover))))
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .on_click((e, cx) => { if (!disabled) onClick(e, cx); })
    .child(label)
    .when(Boolean(hint), (el) => el.child(div().text_size(10.5).text_color(solid ? t.solid_foreground : t.dim).opacity(0.7).child(hint)));
}

const heading = (t, text) => div().mt(16).mb(8).text_size(10.5).font_medium().text_color(t.dim).child(text);

function badge(t, state) {
  const s = STATE[state];
  if (!s) return div();
  return h_flex().flex_none().gap(5).items_center().text_size(11).text_color(s.color(t))
    .child(div().size(6).rounded(3).bg(s.color(t)))
    .child(s.word);
}

export default class Recover extends View {
  init(_props, cx) {
    this.dialog = Boolean(props()?.overlay);
    this.fitted = 0;
    this.note = null;
    this.busy = false;
    this.focus = this.dialog ? focused()?.terminal ?? null : null;
    if (this.dialog) {
      this.handle = cx.focus_handle();
      this.handle.focus();
      cx.timer.after(120, () => this.handle.focus());
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
    return this.dialog ? this.renderDialog(cx) : this.renderBar();
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

  // Styled like the native status items: a history icon, 13 px, in their muted grey, the counts
  // on hover; dim and faded with nothing on record. The theme's warning colors and a count beside the icon
  // when a restart took sessions a resume didn't bring back.
  renderBar() {
    const t = theme();
    const m = mem();
    // Interrupted sessions wait in the dialog; the bar counts what a restart took.
    const needs = m.entries.filter((e) => e.state === "lost" || e.state === "failed");
    const running = m.entries.filter((e) => e.state === "running");
    const edge = props()?.border;
    const count = needs.length
      ? `${needs.length} to recover · ${running.length} running`
      : m.entries.length ? `${m.entries.length} remembered` : "No agent session on record";
    const tip = m.entries.length
      ? [count, ...m.entries.map((e) => `${e.where ?? e.address}: ${STATE[e.state]?.word ?? e.state}`)].join("\n")
      : `${count}. Recover remembers them as they start.`;
    const color = needs.some((e) => e.state === "failed") ? t.ansi1 : needs.length ? t.ansi3 : m.entries.length ? t.muted : t.dim;
    return h_flex().id("recover-bar").size_full().px(PAD).items_center().bg(t.chrome).text_size(11.8).cursor_pointer()
      .when(edge === "top", (el) => el.border_t(1).border_color(t.border))
      .when(edge === "bottom", (el) => el.border_b(1).border_color(t.border))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click(() => run("mod.open", { name: "recover" }))
      .tooltip(tip)
      .child(h_flex().id("content").flex_none().gap(6).items_center()
        .on_size_change((size) => this.fit(size.width))
        .child(svg("mods/recover/history.svg").size(13).flex_none().text_color(color).opacity(m.entries.length ? 1 : 0.6))
        .when(needs.length > 0, (el) => el.child(div().text_color(color).child(String(needs.length)))));
  }

  // ── the dialog ──

  close() { closeOverlay(props().overlay); }

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
      this.close();
      run("pane.focus", { terminal: entry.address });
    });
  }

  setAuto(entry, on, cx) { this.act(cx, () => hc(["label", entry.address, ...labelArgs({ auto: on ? null : "off" })])); }
  forget(entry, cx) { this.act(cx, () => hc(["label", entry.address, ...clearArgs()])); }

  key(e, cx) {
    const k = e.key;
    if (k === "escape") { cx.stop_propagation(); this.close(); return; }
    if (k === "r") { cx.spawn(async (cx) => { await scan({ setup: true }).catch(() => {}); cx.notify(); }); return; }
    const entry = this.current();
    if (k === "enter" && entry && NEEDS_YOU.has(entry.state)) this.resumeNow(entry, cx);
  }

  folder(entry) {
    const h = entry.on ? null : home();
    const shown = entry.on && entry.rec.cwd ? entry.rec.cwd.replace(/^\/home\/[^/]+(?=\/|$)/, "~") : tilde(entry.rec.cwd, h);
    return entry.on ? `${entry.on}: ${shown}` : shown;
  }

  focusedCard(t) {
    const entry = this.current();
    const dim = (text) => div().text_size(12).text_color(t.dim).child(text);
    if (!this.focus) return dim("No terminal is focused.");
    if (!entry) {
      // An agent running there that nobody recorded: say so, with where the hook goes.
      const term = terminals().find((x) => x.address === this.focus);
      const app = agentForApp(term?.report?.app ?? term?.status?.app);
      if (app && term?.program?.agent) return dim(`${AGENTS[app].name} is running here, but Recover has no record of it: it was started before the hook was installed, or the hook isn't installed on ${splitAddress(this.focus).on ?? "this computer"}. It is remembered from its next start.`);
      return dim(mem().at ? "No agent session on record for the focused terminal." : "Looking…");
    }
    const { rec, state } = entry;
    const agent = AGENTS[rec.agent];
    const flags = rec.flags?.length ? rec.flags.join(" ") : null;
    return v_flex().gap(12).p(14).rounded(12).bg(t.raised).border_1().border_color(t.border)
      .child(h_flex().gap(8).items_center()
        .child(div().text_size(14).font_semibold().text_color(t.foreground).child(agent?.name ?? rec.agent))
        .child(div().text_size(11.5).text_color(t.dim).font_family("JetBrains Mono").child(shortId(rec.session)))
        .child(div().flex_1())
        .child(badge(t, state)))
      .child(v_flex().gap(4).text_size(12).text_color(t.muted)
        .when(Boolean(rec.cwd), (el) => el.child(div().truncate().child(this.folder(entry))))
        .when(Boolean(flags), (el) => el.child(div().truncate().text_color(t.dim).font_family("JetBrains Mono").text_size(10.5).child(flags)))
        .when(state === "failed", (el) => el.child(div().text_color(t.dim).child("The last resume didn't bring the agent up. Check the terminal, then try again.")))
        .when(entry.busy, (el) => el.child(div().text_color(t.dim).child("Another program is running in this terminal; quit it to resume here."))))
      .child(h_flex().gap(6).flex_wrap()
        .when(NEEDS_YOU.has(state), (el) => el
          .child(button(t, "resume-here", this.busy ? "Resuming…" : "Resume", (_e, cx) => this.resumeNow(entry, cx), { kind: "solid", hint: "↵", disabled: this.busy || entry.busy }))
          .child(button(t, "forget-here", "Forget", (_e, cx) => this.forget(entry, cx), { disabled: this.busy })))
        .child(button(t, "auto-here", rec.auto ? "Auto resume: on" : "Auto resume: off", (_e, cx) => this.setAuto(entry, !rec.auto, cx), { kind: "ghost" })));
  }

  row(t, entry, i) {
    const { rec, state } = entry;
    const agent = AGENTS[rec.agent];
    const needs = NEEDS_YOU.has(state);
    return h_flex().id(`row-${i}`).h(48).px(12).gap(12).items_center().rounded(10).cursor_pointer()
      .when(needs, (el) => el.bg(t.raised))
      .hover((s) => s.bg(t.hover))
      .on_click(() => { this.close(); run("pane.focus", { terminal: entry.address }); })
      .child(v_flex().flex_1().min_w(0)
        .child(h_flex().gap(6).items_center()
          .child(div().text_size(13).font_medium().text_color(t.foreground).child(agent?.name ?? rec.agent))
          .child(div().text_size(11).text_color(t.dim).font_family("JetBrains Mono").child(shortId(rec.session))))
        .child(div().truncate().text_size(11).text_color(t.dim)
          .child([entry.on, entry.where ?? entry.address, rec.resumed ? `resumed ${ago(rec.resumed)}` : null].filter(Boolean).join(" · "))))
      .child(badge(t, state))
      .child(button(t, `auto-${i}`, rec.auto ? "Auto" : "Auto off", (_e, cx) => this.setAuto(entry, !rec.auto, cx), { kind: "ghost" }))
      .when(needs, (el) => el.child(button(t, `resume-${i}`, "Resume", (_e, cx) => this.resumeNow(entry, cx), { kind: "solid", disabled: this.busy || entry.busy })));
  }

  setupLine(t) {
    const hooks = mem().hooks ?? {};
    const places = Object.keys(hooks);
    if (!places.length) return div();
    const mark = (ok) => div().text_color(ok ? t.ansi2 : ok === null ? t.dim : t.ansi1).child(ok ? "✓" : ok === null ? "?" : "✕");
    const missing = [];
    const line = (place) => {
      const name = place || "this computer";
      const agents = hooks[place];
      const row = h_flex().gap(8).items_center().flex_wrap().child(div().text_color(t.muted).child(`${name}:`));
      if (agents === null || typeof agents !== "object") return row.child(mark(null));
      const keys = Object.keys(agents).filter((k) => k !== "core");
      if (!agents.core) missing.push(`herdr-core's shell on ${name}`);
      const core = h_flex().gap(4).items_center().text_color(agents.core ? t.muted : t.ansi1).child(mark(agents.core)).child("resumes");
      if (!keys.length) return row.child(core).child(div().text_color(t.dim).child("no agent here"));
      for (const k of keys) if (!agents[k]) missing.push(`${AGENTS[k]?.name ?? k} on ${name}`);
      return row.child(core).children(keys.map((k) => h_flex().gap(4).items_center().text_color(agents[k] ? t.muted : t.ansi1)
        .child(mark(agents[k])).child(AGENTS[k]?.name ?? k)));
    };
    const rows = places.map(line);
    return v_flex().gap(6).text_size(11)
      .children(rows)
      .when(missing.length > 0, (el) => el.child(div().text_color(t.dim)
        .child(`Not set up: ${missing.join(", ")}. In a terminal there, sh install.sh from a clone of guillaume86/herdr-recover.`)));
  }

  renderDialog() {
    const t = theme();
    const entries = this.entries();
    const others = entries.filter((e) => e.address !== this.focus);
    const needs = others.filter((e) => NEEDS_YOU.has(e.state));
    const rest = others.filter((e) => !NEEDS_YOU.has(e.state));
    const listH = listMaxH(Boolean(this.note));
    return v_flex().id("recover").track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx))
      .w_full().bg(t.popover).px(20).pt(18).pb(16)
      .child(h_flex().flex_none().items_center().gap(8)
        .child(div().text_size(16).font_semibold().text_color(t.foreground).child("↻ Recover"))
        .child(div().text_size(11.5).text_color(t.dim).child("Agent sessions, remembered on their terminals, on every machine")))
      .child(div().id("recover-scroll").when(listH !== null, (el) => el.max_h(listH)).overflow_y_scrollbar()
        .child(heading(t, "FOCUSED TERMINAL"))
        .child(this.focusedCard(t))
        .when(needs.length > 0, (el) => el.child(heading(t, "NEED YOU")).child(v_flex().gap(4).children(needs.map((e, i) => this.row(t, e, `n${i}`)))))
        .when(rest.length > 0, (el) => el.child(heading(t, "OTHER SESSIONS")).child(v_flex().gap(4).children(rest.map((e, i) => this.row(t, e, `r${i}`))))))
      .when(Boolean(this.note), (el) => el.child(div().flex_none().mt(8).p(8).rounded(6).bg(t.raised).text_size(11.5)
        .text_color(this.note.level === "error" ? t.ansi1 : t.muted).child(this.note.text)))
      .child(div().flex_none().mt(16).pt(12).border_t_1().border_color(t.border).child(this.setupLine(t)));
  }
}
