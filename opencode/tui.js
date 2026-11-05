// herdr-recover for OpenCode 2: remember the session on its Herdr terminal, and forget it
// when the person quits.
//
// install.sh copies this file to ~/.config/opencode/herdr-recover/tui.js and lists
// "./herdr-recover" in the `plugins` of ~/.config/opencode/cli.json. OpenCode 2 loads it in
// the terminal's own TUI, whichever server that TUI talks to (the shared background service,
// --standalone, --server), so the terminal it labels is the one the session shows in. The
// session the TUI shows (its root, for a sub-agent's) becomes the terminal's record, as
// `recover.*` labels on its herdr-core terminal (`hc label $HC_TERMINAL_ID …`), and herdr-core's
// shell (hook/recover-shell.sh) types `opencode --session <id>` into the terminal's new shell
// after a restart or a reboot.
//
// OpenCode exits 0 when the person quits and also on SIGHUP or SIGTERM (a closed terminal, a
// core stop, a shutdown). A listener put ahead of OpenCode's own sees those signals first: an
// exit 0 without one is the person's, and marks the session ended. A crash (another exit code)
// or a SIGKILL leaves it to be resumed.
//
// It never gets in OpenCode's way: outside a herdr terminal it does nothing, and a failing `hc`
// is ignored. OpenCode 1 isn't supported.

import { execFile, execFileSync } from "node:child_process";

const HC = process.env.RECOVER_HC || "hc";
// The launch flags a resume should get back, with how many values each takes.
const CARRY = { "--auto": 0, "--standalone": 0, "--server": 1 };
const validId = (id) => typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id);

function hc(args) {
  return new Promise((resolve) => {
    execFile(HC, args, { timeout: 10_000, windowsHide: true }, (error, stdout) => resolve(error ? null : stdout));
  });
}

function carried(words) {
  const out = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const eq = w.indexOf("=");
    const name = eq > 0 ? w.slice(0, eq) : w;
    const n = CARRY[name];
    if (n === undefined) continue;
    if (eq > 0) { out.push(w); continue; }
    const vals = words.slice(i + 1, i + 1 + n);
    if (vals.length < n || vals.some((v) => v.startsWith("-"))) continue;
    out.push(w, ...vals);
    i += n;
  }
  return out;
}

async function record(terminal, session, cwd) {
  const text = await hc(["get", terminal, "--json"]);
  let t = null;
  try { t = JSON.parse(text ?? ""); } catch { return; }
  if (!t?.pid) return;
  const same = t.labels?.["recover.session"] === session;
  const labels = same
    ? { cwd, shell: t.pid, pid: process.pid, failed: "", ended: "" }
    : {
      // argv[0] is the runtime, argv[1] the program.
      agent: "opencode", session, cwd, flags: JSON.stringify(carried(process.argv.slice(2))), dir: "", file: "",
      shell: t.pid, pid: process.pid, at: Date.now(), resumed: "", failed: "", ended: "",
    };
  await hc(["label", terminal, ...Object.entries(labels).map(([k, v]) => `recover.${k}=${v ?? ""}`)]);
}

function setup(api) {
  const terminal = process.env.HC_TERMINAL_ID;
  if (!terminal) return;
  let recorded = null;
  let signaled = false;
  let chain = Promise.resolve();

  for (const signal of ["SIGHUP", "SIGTERM"]) {
    const mark = () => {
      signaled = true;
      // Alone, this listener would keep the signal from ending the process: end it as before.
      if (process.listenerCount(signal) === 1) { process.removeListener(signal, mark); process.kill(process.pid, signal); }
    };
    process.prependListener(signal, mark);
  }
  process.on("exit", (code) => {
    if (code !== 0 || signaled || !recorded) return;
    try { execFileSync(HC, ["label", terminal, `recover.ended=${recorded}`], { timeout: 10_000, stdio: "ignore", windowsHide: true }); } catch { /* hc gone */ }
  });

  // The session a sub-agent's belongs to: the terminal's record is the root's.
  const root = (id) => {
    const seen = new Set();
    while (validId(id) && !seen.has(id)) {
      seen.add(id);
      const parent = api.data.session.get(id)?.parentID;
      if (!parent) return id;
      id = parent;
    }
    return null;
  };
  const sync = () => {
    const route = api.ui.router.current();
    const id = route?.type === "session" ? root(route.sessionID) : null;
    if (!id || id === recorded) return;
    recorded = id;
    const cwd = api.data.session.get(id)?.directory || process.cwd();
    chain = chain.then(() => record(terminal, id, cwd)).catch(() => {});
  };
  sync();
  const poll = setInterval(sync, 500);
  poll.unref?.();
  return () => clearInterval(poll);
}

export default { id: "herdr-recover", setup };
