// herdr-recover for Pi: remember the session on its Herdr terminal.
//
// Installed as a Pi package (`pi install git:github.com/guillaume86/herdr-recover`).
// In the interactive Pi a terminal runs, the session it opens becomes the
// terminal's record once it has a file on disk, as `recover.*` labels on its
// herdr-core terminal (`hc label $HC_TERMINAL_ID …`). The Recover mod in the
// Herdr app types `pi --session <id>` into the terminal's new shell after a
// restart or a reboot.
//
// It never gets in Pi's way: outside a herdr terminal it does nothing, and a
// failing `hc` is ignored.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";

const HC = process.env.RECOVER_HC || "hc";
// The launch flags a resume should get back, with how many values each takes.
const CARRY: Record<string, number> = { "--provider": 1, "--model": 1, "--thinking": 1, "--models": 1, "--approve": 0, "-a": 0 };
const validId = (id: unknown): id is string => typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id);

function hc(args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(HC, args, { timeout: 10_000, windowsHide: true }, (error, stdout) => resolve(error ? null : String(stdout)));
  });
}

function carried(words: string[]): string[] {
  const out: string[] = [];
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

async function record(terminal: string, session: string, cwd: string): Promise<void> {
  let t: any = null;
  try { t = JSON.parse((await hc(["get", terminal, "--json"])) ?? ""); } catch { return; }
  if (!t?.pid) return;
  const same = t.labels?.["recover.session"] === session;
  const labels: Record<string, unknown> = same
    ? { cwd, shell: t.pid, pid: process.pid, failed: "", ended: "" }
    : {
      // argv[0] is the runtime, argv[1] the program.
      agent: "pi", session, cwd, flags: JSON.stringify(carried(process.argv.slice(2))), dir: "", file: "",
      shell: t.pid, pid: process.pid, at: Date.now(), resumed: "", failed: "", ended: "",
    };
  await hc(["label", terminal, ...Object.entries(labels).map(([k, v]) => `recover.${k}=${v ?? ""}`)]);
}

export default function (pi: any) {
  const terminal = process.env.HC_TERMINAL_ID;
  if (!terminal) return;
  let recorded: string | null = null;
  let chain: Promise<void> = Promise.resolve();

  // A session is worth resuming once its file exists: at its start when it had one
  // (a resume, a fork), or at its first prompt.
  const note = (ctx: any) => {
    if (ctx?.mode !== "tui") return; // print, json and rpc runs aren't the terminal's
    const manager = ctx.sessionManager;
    const id = manager?.getSessionId?.();
    const file = manager?.getSessionFile?.();
    if (!validId(id) || !file || id === recorded) return; // an ephemeral (--no-session) one has no file
    recorded = id;
    chain = chain.then(() => record(terminal, id, ctx.cwd ?? manager?.getCwd?.() ?? process.cwd())).catch(() => {});
    return chain;
  };

  pi.on("session_start", async (_event: any, ctx: any) => {
    const file = ctx?.sessionManager?.getSessionFile?.();
    if (file && existsSync(file)) await note(ctx);
  });
  pi.on("agent_start", async (_event: any, ctx: any) => { await note(ctx); });
}
