// Recover: bring back the coding agent a terminal lost to a restart or a reboot.
//
// The hook (hook/recover-hook.sh) remembers each agent session as labels on
// its herdr-core terminal, on whatever machine the agent runs. This mod, from
// the Herdr app, watches every terminal the app can see (this computer and
// the machines it is connected to), and when one came back as a bare shell
// with a session on record, types the resume command into it, the way the
// Herdr TUI used to. Nothing runs on the other machines but the hook and hc.
//
// Two copies of the mod run: a status-bar block (the watcher, with a count)
// and the dialog (`mod.open:recover`, Ctrl+Shift+R), which lists the sessions
// and offers Resume, Auto and Forget. Either copy does the watching while it
// is up, so the dialog works even without the block in the layout.

import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { hc, exec, run, theme, terminals, focused, home, props, closeOverlay, notify, shared, setShared, window as appWindow, readTextFile } from "herdr";
import {
  AGENTS, PREFIX, agentOf, agentForApp, carriedFlags, readRecord, labelArgs, clearArgs, stateOf, decide, resumeLine, shellKind,
  parseSessionFiles, winArgv, shortId, ago, splitAddress, psQuote,
} from "./lib/core.js";

const TICK_MS = 5000;
// A terminal is resumed only once its new shell has been seen for a whole tick: time for
// the shell to read its profile before the line lands (the tty keeps the input anyway).
const STATE_KEY = "recover.state";
const HOOK_MARK = "herdr-recover";
const MAX_SHARE = 0.85;
const CHROME_H = 130;
const NOTE_H = 56;

const STATE = {
  running: { word: "Running", color: (t) => t.ansi2 },
  lost: { word: "Lost to a restart", color: (t) => t.ansi3 },
  interrupted: { word: "Interrupted", color: (t) => t.ansi3 },
  failed: { word: "Resume failed", color: (t) => t.ansi1 },
};
const NEEDS_YOU = new Set(["lost", "interrupted", "failed"]);

const isWindows = () => { try { return appWindow()?.platform === "windows"; } catch { return false; } };

/** The mod's memory across copies, ticks and app restarts: each terminal's program last tick, when its agent was last seen live. */
function mem() { return { pid: {}, live: {}, flags: {}, entries: [], hooks: {}, at: 0, ...(shared(STATE_KEY) ?? {}) }; }
function remember(m) { setShared(STATE_KEY, m); }

async function getTerminal(address) {
  const r = await hc(["get", address, "--json"]);
  if (r.code !== 0) throw new Error(r.stderr || r.stdout || `hc get ${address} failed`);
  return JSON.parse(r.stdout);
}

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

/** The command line of a Windows process, for the flags the hook couldn't read there. */
async function winCommandLine(pid) {
  try {
    const r = await exec("powershell", ["-NoProfile", "-Command", `(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}").CommandLine`]);
    return r.code === 0 ? r.stdout.trim() : "";
  } catch { return ""; }
}

/** Whether Recover's hook is in a machine's Claude Code settings. Null when unknown. */
async function hookInstalled(on) {
  try {
    if (!on) return (await readTextFile(`${home()}/.claude/settings.json`))?.includes(HOOK_MARK) ?? false;
    const r = await exec("sh", ["-c", 'cat "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/settings.json" 2>/dev/null'], { on });
    return r.stdout.includes(HOOK_MARK);
  } catch { return null; }
}

/**
 * One pass: read every remembered terminal, work out its state, resume what was
 * lost, drop what the person quit, and publish the list for the dialog and the bar.
 */
async function scan({ setup = false } = {}) {
  const m = mem();
  if (m.busy && Date.now() - m.busy < 20_000) return;
  m.busy = Date.now();
  remember(m);
  try {
    const all = terminals().filter((t) => t.state === "live" && t.labels?.[`${PREFIX}session`]);
    const infos = (await Promise.all(all.map((t) => getTerminal(t.address).catch(() => null)))).filter(Boolean);
    // Whether each session's agent runs: its own session file says so. The hook names the
    // file; for a record without one, the machine's session files are listed once.
    const fileLive = new Map(await Promise.all(infos.map(async (t) => {
      const rec = readRecord(t.labels);
      if (!rec?.file) return [t.address, null];
      const text = await readTextFile(rec.file, { on: splitAddress(t.address).on }).catch(() => null);
      return [t.address, Boolean(text && parseSessionFiles(text).some((s) => s.session === rec.session))];
    })));
    const byMachine = new Map();
    for (const t of infos) {
      if (fileLive.get(t.address) !== null) continue;
      const { on } = splitAddress(t.address);
      if (!byMachine.has(on)) byMachine.set(on, []);
      const dir = readRecord(t.labels)?.dir;
      if (dir) byMachine.get(on).push(dir);
    }
    const sessions = new Map(await Promise.all([...byMachine].map(async ([on, dirs]) => [on, await sessionsOn(on, dirs)])));
    const now = Date.now();
    const entries = [];
    const seenPid = {};
    for (const t of infos) {
      const rec = readRecord(t.labels);
      if (!rec) continue;
      const { on, id } = splitAddress(t.address);
      const file = sessions.get(on)?.find((s) => s.session === rec.session) ?? null;
      const fg = t.foreground;
      // Live by the terminal's foreground (Linux, macOS), or by the agent's own session file (everywhere).
      const byFile = fileLive.get(t.address) ?? Boolean(file);
      const live = (fg && fg.pid !== t.pid && agentOf(fg.argv ?? [fg.name]) === rec.agent) || byFile;
      const pid = t.pid ?? null;
      const state = stateOf(rec, { live, pid });
      seenPid[t.address] = pid;
      if (live) m.live[t.address] = now;
      const entry = {
        address: t.address, on, id, rec, state, pid, live,
        where: t.labels?.where ?? null, title: t.title ?? "",
        shell: shellKind(t.argv ?? []),
        busy: Boolean(fg && fg.pid && pid && fg.pid !== pid && !live),
      };
      // Flags the hook couldn't read (Windows has no /proc): once, from the agent's command line.
      // Its pid is in its session file's name (sessions/<pid>.json).
      const agentPid = file?.pid ?? Number(/(\d+)\.json$/.exec(rec.file ?? "")?.[1] ?? 0);
      if (live && agentPid && !rec.flags.length && !on && isWindows() && m.flags[rec.session] !== true) {
        m.flags[rec.session] = true;
        const argv = winArgv(await winCommandLine(agentPid));
        const flags = carriedFlags(rec.agent, argv);
        if (flags.length) await hc(["label", t.address, ...labelArgs({ flags: JSON.stringify(flags) })]);
      }
      // Seen live since the last resume: a later absence is a quit, not a failed resume.
      // Unknown when the mod never saw this terminal live (an app restart since).
      const cameBack = rec.resumed && m.live[t.address] ? m.live[t.address] > rec.resumed : null;
      const action = decide(rec, { state, cameBack, now });
      // Only a shell the mod already saw a tick ago is typed into: it has had time to start.
      if (action === "resume" && m.pid[t.address] === pid && !entry.busy) {
        try { entry.sent = await resume(entry, { auto: true }); }
        catch (e) { entry.error = String(e?.message ?? e); }
        if (entry.sent) notify({ title: "Recover", body: `Resuming ${AGENTS[rec.agent].name} ${shortId(rec.session)} in ${entry.where ?? t.address}.`, level: "info" });
      } else if (action === "fail") {
        await hc(["label", t.address, ...labelArgs({ failed: now })]);
        entry.state = "failed";
        entry.rec = { ...rec, failed: now };
        notify({ title: "Recover", body: `${AGENTS[rec.agent].name} didn't come back in ${entry.where ?? t.address}. Open Recover to retry.`, level: "error" });
      }
      entries.push(entry);
    }
    m.pid = seenPid;
    m.entries = entries;
    m.at = now;
    if (setup) {
      const machines = [...new Set([null, ...infos.map((t) => splitAddress(t.address).on)])];
      m.hooks = Object.fromEntries(await Promise.all(machines.map(async (on) => [on ?? "", await hookInstalled(on)])));
    }
  } finally {
    m.busy = 0;
    remember(m);
  }
}

/** Types the resume line into the terminal. Marks the record first, so a second copy can't send it again. */
async function resume(entry, { auto = false } = {}) {
  const { rec, address, pid } = entry;
  const line = resumeLine(rec, entry.shell);
  if (!line) throw new Error(`Can't write a resume command for ${address}'s shell.`);
  const fresh = await getTerminal(address);
  const now = Date.now();
  const current = readRecord(fresh.labels);
  // Another copy got there first, or the terminal changed under us.
  if (!current || current.session !== rec.session || fresh.pid !== pid) return false;
  if (auto && current.resumed && current.shell === pid && now - current.resumed < 60_000) return false;
  await hc(["label", address, ...labelArgs({ shell: pid, resumed: now, failed: null })]);
  const r = await hc(["send", address, line]);
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
    cx.timer.every(TICK_MS, (cx) => tick(cx, false));
  }

  render(cx) {
    return this.dialog ? this.renderDialog(cx) : this.renderBar();
  }

  // ── the status-bar block ──

  renderBar() {
    const t = theme();
    const m = mem();
    // Interrupted sessions wait in the dialog; the bar counts what a restart took.
    const needs = m.entries.filter((e) => e.state === "lost" || e.state === "failed");
    const running = m.entries.filter((e) => e.state === "running");
    const edge = props()?.border;
    const tip = m.entries.length
      ? m.entries.map((e) => `${e.where ?? e.address}: ${STATE[e.state]?.word ?? e.state}`).join("\n")
      : "No agent session on record. Recover remembers them as they start.";
    const color = needs.some((e) => e.state === "failed") ? t.ansi1 : needs.length ? t.ansi3 : t.dim;
    return h_flex().id("recover-bar").size_full().px(12).gap(6).items_center().bg(t.chrome).text_size(11.8).cursor_pointer()
      .when(edge === "top", (el) => el.border_t(1).border_color(t.border))
      .when(edge === "bottom", (el) => el.border_b(1).border_color(t.border))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click(() => run("mod.open", { name: "recover" }))
      .tooltip(tip)
      .child(div().text_color(color).child("↻"))
      .when(needs.length > 0, (el) => el.child(div().text_color(color).child(`${needs.length} to recover`)))
      .when(!needs.length && running.length > 0, (el) => el.child(div().text_color(t.dim).child(`${running.length} remembered`)));
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
    const names = Object.keys(hooks);
    if (!names.length) return div();
    const part = (name, on) => h_flex().gap(4).text_color(on ? t.muted : on === null ? t.dim : t.ansi1)
      .child(div().text_color(on ? t.ansi2 : on === null ? t.dim : t.ansi1).child(on ? "✓" : on === null ? "?" : "✕"))
      .child(name);
    const missing = names.filter((k) => hooks[k] === false);
    return v_flex().gap(6).text_size(11)
      .child(h_flex().gap(10).items_center()
        .children(names.map((k) => part(`${k || "this computer"} hook`, hooks[k]))))
      .when(missing.length > 0, (el) => el.child(div().text_color(t.dim)
        .child(`Install the hook on ${missing.map((k) => k || "this computer").join(", ")}: in a terminal there, sh install.sh from a copy of this repository.`)));
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
