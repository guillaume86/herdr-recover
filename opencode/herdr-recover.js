// herdr-recover for OpenCode: remember the session on its Herdr terminal.
//
// OpenCode loads this file from ~/.config/opencode/plugins/. In the OpenCode a
// terminal runs (its TUI: not `opencode run`, `serve`, `web` or `attach`), the
// root session last created or written to becomes the terminal's record, as
// `recover.*` labels on its herdr-core terminal (`hc label $HC_TERMINAL_ID …`).
// The Recover mod in the Herdr app types `opencode --session <id>` into the
// terminal's new shell after a restart or a reboot.
//
// It never gets in OpenCode's way: outside a herdr terminal it does nothing,
// and a failing `hc` is ignored.

import { execFile } from "node:child_process";

const HC = process.env.RECOVER_HC || "hc";
// The launch flags a resume should get back, with how many values each takes.
const CARRY = { "--model": 1, "-m": 1, "--agent": 1, "--auto": 0 };
// Subcommands that aren't the terminal's own TUI.
const NOT_TUI = new Set([
  "run", "serve", "web", "attach", "acp", "mcp", "completion", "debug", "providers", "auth", "agent",
  "upgrade", "uninstall", "models", "stats", "export", "import", "github", "session", "plugin", "plug", "db",
]);
const validId = (id) => typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id);

function hc(args) {
  return new Promise((resolve) => {
    execFile(HC, args, { timeout: 10_000, windowsHide: true }, (error, stdout) => resolve(error ? null : stdout));
  });
}

/** OpenCode's own arguments: argv[0] is the runtime, argv[1] the program. */
const args = () => process.argv.slice(2);

function ownsTerminal() {
  const words = args();
  if (words.some((w) => w === "--attach" || w.startsWith("--attach="))) return false;
  // The first word that isn't an option, skipping the values of options that take one.
  const valued = new Set(["--log-level", "--port", "--hostname", "--mdns-domain", "--cors", "-m", "--model", "-s", "--session", "--prompt", "--agent"]);
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w === "--") break;
    if (w.startsWith("-")) { if (valued.has(w)) i++; continue; }
    return !NOT_TUI.has(w);
  }
  return true;
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
    ? { cwd, shell: t.pid, pid: process.pid, failed: "" }
    : {
      agent: "opencode", session, cwd, flags: JSON.stringify(carried(args())), dir: "", file: "",
      shell: t.pid, pid: process.pid, at: Date.now(), resumed: "", failed: "",
    };
  await hc(["label", terminal, ...Object.entries(labels).map(([k, v]) => `recover.${k}=${v ?? ""}`)]);
}

export const HerdrRecover = async ({ directory }) => {
  const terminal = process.env.HC_TERMINAL_ID;
  if (!terminal || !ownsTerminal()) return {};
  let current = null;
  let chain = Promise.resolve();
  return {
    event: async ({ event }) => {
      if (event?.type !== "session.created" && event?.type !== "session.updated") return;
      const info = event.properties?.info;
      // Sub-agents' sessions have a parent: the terminal's record is the root's.
      if (!info?.id || info.parentID || info.id === current || !validId(info.id)) return;
      current = info.id;
      const cwd = info.directory || directory || process.cwd();
      chain = chain.then(() => record(terminal, info.id, cwd)).catch(() => {});
      await chain;
    },
  };
};
