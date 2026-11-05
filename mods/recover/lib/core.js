// Recover's rules, as plain functions with no I/O: what a terminal's labels
// say, what state a remembered session is in, what the mod should do about
// it, and the line that resumes it in that terminal's shell. The dialog and
// the tests share them.
//
// A session is remembered as `recover.*` labels on its herdr-core terminal,
// written by the agent's SessionStart hook (hook/recover-hook.sh). Labels are
// kept across core restarts and reboots and go away with the terminal.

export const PREFIX = "recover.";
export const KEYS = ["agent", "session", "cwd", "flags", "dir", "file", "pid", "shell", "at", "resumed", "failed", "ended", "auto"];

// What Recover knows of each agent: how it resumes a session, the launch flags a
// resume should get back (with how many values each takes), and how a session the
// person quit is told from one a restart took.
// - Claude Code's SessionEnd hook says why a session ended (`end`).
// - The others have no such hook: a session whose agent the mod sees gone from its
//   terminal, under the same shell, was quit (`forgetOnExit`). One that ended while the
//   app was closed is resumed after a later restart.
// Claude Code's flag table comes from herdr-revive (MIT, github.com/dmazlum/herdr-revive);
// the resume commands match the Herdr TUI's (src/agent_resume.rs in herdrdev/herdr).
export const AGENTS = {
  claude: {
    name: "Claude Code",
    bin: "claude",
    // What the agent reports as `app` in OSC 7501.
    apps: ["claude-code", "claude"],
    resume: (id, flags) => ["claude", ...flags, "--resume", id],
    carry: {
      "--dangerously-skip-permissions": 0,
      "--allow-dangerously-skip-permissions": 0,
      "--permission-mode": 1,
      "--model": 1,
      "--add-dir": 2,
      "--settings": 1,
      "--agent": 1,
    },
    // The agent's config folder, when a session ran under one: where its sessions/ and transcripts are.
    dirVar: "CLAUDE_CONFIG_DIR",
    // SessionEnd reasons: `clear` and `resume` start another session in the same process (its
    // SessionStart records it); `other` is a signal (keep the record); anything else is the person.
    end: (reason) => (reason === "clear" || reason === "resume" ? "ignore" : reason === "other" ? "keep" : "forget"),
    // Windows: the image a live agent runs as (tasklist).
    image: "claude.exe",
  },
  codex: {
    name: "Codex",
    bin: "codex",
    apps: ["codex"],
    resume: (id, flags) => ["codex", "resume", ...flags, id],
    carry: {
      "--model": 1, "-m": 1, "--profile": 1, "-p": 1, "--sandbox": 1, "-s": 1, "--ask-for-approval": 1, "-a": 1,
      "--dangerously-bypass-approvals-and-sandbox": 0, "--approve-for-me": 0, "--search": 0, "--add-dir": 1,
      "--config": 1, "-c": 1, "--enable": 1, "--disable": 1, "--oss": 0, "--local-provider": 1, "--no-daemon": 0,
    },
    dirVar: "CODEX_HOME",
    forgetOnExit: true,
  },
  opencode: {
    name: "OpenCode",
    bin: "opencode",
    apps: ["opencode"],
    resume: (id, flags) => ["opencode", ...flags, "--session", id],
    carry: { "--model": 1, "-m": 1, "--agent": 1, "--auto": 0 },
    forgetOnExit: true,
  },
  pi: {
    name: "Pi",
    bin: "pi",
    apps: ["pi"],
    resume: (id, flags) => ["pi", ...flags, "--session", id],
    carry: { "--provider": 1, "--model": 1, "--thinking": 1, "--models": 1, "--approve": 0, "-a": 0 },
    forgetOnExit: true,
  },
};

export const validId = (id) => typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id);
export const shortId = (id) => (id ? String(id).slice(0, 8) : "");

const base = (word) => String(word ?? "").split(/[\\/]/).pop().replace(/\.exe$/i, "");

/** The agent key for a command line, or null. */
export function agentOf(argv = []) {
  const first = base(argv[0]);
  return Object.keys(AGENTS).find((k) => AGENTS[k].bin === first) ?? null;
}

/** The agent key for an OSC 7501 `app` report, or null. */
export function agentForApp(app) {
  if (!app) return null;
  return Object.keys(AGENTS).find((k) => AGENTS[k].apps.includes(app)) ?? null;
}

/** The launch flags worth carrying to a resume, from the agent's command line. */
export function carriedFlags(key, argv = []) {
  const agent = AGENTS[key];
  if (!agent) return [];
  const out = [];
  const words = argv.slice(1);
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const eq = w.indexOf("=");
    const name = eq > 0 ? w.slice(0, eq) : w;
    const n = agent.carry[name];
    if (n === undefined) continue;
    if (eq > 0) { out.push(w); continue; }
    const vals = words.slice(i + 1, i + 1 + n);
    if (vals.length < n || vals.some((v) => v.startsWith("-"))) continue;
    out.push(w, ...vals);
    i += n;
  }
  return out;
}

const num = (v) => (v === undefined || v === "" || v === null ? null : Number.isFinite(Number(v)) ? Number(v) : null);

/** A terminal's labels as a record, or null when it carries no session. */
export function readRecord(labels) {
  const get = (k) => labels?.[PREFIX + k];
  const session = get("session");
  if (!session) return null;
  let flags = [];
  try {
    const parsed = JSON.parse(get("flags") || "[]");
    if (Array.isArray(parsed)) flags = parsed.map(String);
  } catch { /* a hand-edited label: carry nothing */ }
  return {
    agent: get("agent") || null,
    session,
    cwd: get("cwd") || null,
    flags,
    dir: get("dir") || null,
    // The agent's own session file (Claude Code: sessions/<pid>.json): there while it runs.
    file: get("file") || null,
    // The agent's process, where its plugin knows it (OpenCode, Pi): Windows liveness.
    pid: num(get("pid")),
    shell: num(get("shell")),
    at: num(get("at")),
    resumed: num(get("resumed")),
    failed: num(get("failed")),
    // The session the person ended (Claude Code's SessionEnd): this record's, when they quit it.
    ended: get("ended") || null,
    auto: get("auto") !== "off",
  };
}

/** `k=v` arguments for `hc label`. A null value removes that label. */
export function labelArgs(fields) {
  return Object.entries(fields).map(([k, v]) => `${PREFIX}${k}=${v === null || v === undefined ? "" : v}`);
}

/** Every Recover label, removed. `auto` stays: it is the person's choice for that terminal. */
export const clearArgs = () => labelArgs(Object.fromEntries(KEYS.filter((k) => k !== "auto").map((k) => [k, null])));

/**
 * Where a remembered session stands, from what the mod can see of its terminal:
 * - running      the agent is live in the terminal
 * - lost         the terminal's program was replaced (a restart, a reboot): `pid` is not the one recorded
 * - failed       a resume was tried after this loss and the agent gave up
 * - interrupted  the agent died but the terminal's shell is the one it ran under
 * `live` is whether the agent is seen running there (the terminal's foreground, or
 * its session file); `pid` the terminal's program now.
 */
export function stateOf(rec, { live, pid }) {
  if (!rec) return null;
  // A new program in the terminal: whatever ran under the old one is gone with it, even if
  // files it left say otherwise (a killed agent never removes its session file). The hook
  // and every resume record the program they ran under, so a session restarted by hand
  // doesn't land here.
  if (rec.shell !== null && pid !== null && rec.shell !== pid) return rec.failed ? "failed" : "lost";
  if (live) return "running";
  return rec.failed ? "failed" : "interrupted";
}

/** A terminal running a Windows shell, where hc can't see the program in front of it. */
export const isWindowsShell = (argv = []) => shellKind(argv) !== "posix";

/** The processes in `tasklist /FO CSV /NH` output: pid → image name, lowercased. */
export function parseTasklist(text) {
  const pids = new Map();
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const m = /^"([^"]*)","(\d+)"/.exec(line.trim());
    if (m) pids.set(Number(m[2]), m[1].toLowerCase());
  }
  return pids;
}

/**
 * What the mod does about a terminal on this tick.
 * - resume   send the resume line: only for a loss (a new shell), when nobody turned it off
 * - fail     a resume that was sent never brought the agent up: mark the record failed
 * - forget   an agent with no end-of-session hook was quit: drop the record
 * - wait     nothing to do
 * An agent that died under a shell that lived on (interrupted) is never resumed by
 * itself: the person was there to see it. Claude Code's SessionEnd hook forgets a session
 * the person quit; for the other agents, the mod does when it has seen the agent gone from
 * its shell for `goneMs` (`goneSince`: when it first saw that).
 * `cameBack`: whether the mod saw the agent live after `rec.resumed`. Unknown (null)
 * after an app restart: then a resume still waiting after `graceMs`, and younger than
 * `failWithinMs`, counts as failed; an older one as having worked and been quit since.
 */
export function decide(rec, {
  state, cameBack = null, now = Date.now(), graceMs = 60_000, failWithinMs = 180_000, goneSince = null, goneMs = 8_000,
}) {
  if (!rec || !AGENTS[rec.agent] || !validId(rec.session)) return "wait";
  // The person quit it (Claude Code's SessionEnd hook marks it): gone, before or after a restart.
  if (rec.ended === rec.session) return "forget";
  if (state === "lost") return rec.auto ? "resume" : "wait";
  if (state !== "interrupted") return "wait";
  // A resume on its way, or one that never brought the agent up.
  if (rec.resumed && cameBack !== true) {
    const since = now - rec.resumed;
    if (since < graceMs) return "wait";
    if (cameBack === false || since < failWithinMs) return "fail";
  }
  if (AGENTS[rec.agent].forgetOnExit && goneSince !== null && now - goneSince >= goneMs) return "forget";
  return "wait";
}

/**
 * A Windows command line as its program would see it: words split on spaces,
 * double quotes grouping, `\"` an escaped quote. Enough for an agent's flags.
 */
export function winArgv(line) {
  const out = [];
  let cur = null, quoted = false;
  const s = String(line ?? "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\\" && s[i + 1] === '"') { cur = (cur ?? "") + '"'; i++; continue; }
    if (c === '"') { quoted = !quoted; cur ??= ""; continue; }
    if (!quoted && (c === " " || c === "\t")) { if (cur !== null) { out.push(cur); cur = null; } continue; }
    cur = (cur ?? "") + c;
  }
  if (cur !== null) out.push(cur);
  return out;
}

/** One word for a POSIX shell, quoted only when it needs to be. */
export function shQuote(word) {
  const s = String(word);
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/** One word for PowerShell: a single-quoted literal, apostrophes doubled. */
export const psQuote = (word) => `'${String(word).replace(/'/g, "''")}'`;

/** One word for cmd.exe: double-quoted when needed. cmd has no escape for `"` inside; refuse those. */
export function cmdQuote(word) {
  const s = String(word);
  if (s.includes('"')) return null;
  return /^[A-Za-z0-9_@%+=:,.\\/-]+$/.test(s) ? s : `"${s}"`;
}

/** The shell family a terminal's program belongs to, from its command line. */
export function shellKind(argv = []) {
  const first = base(argv[0]).toLowerCase();
  if (first === "pwsh" || first === "powershell") return "pwsh";
  if (first === "cmd") return "cmd";
  return "posix";
}

/** The agent's command line for a resume, with its config folder when it had one. */
export function resumeArgv(rec) {
  const agent = AGENTS[rec?.agent];
  if (!agent || !validId(rec.session)) return null;
  return agent.resume(rec.session, rec.flags ?? []);
}

/**
 * The line typed into the terminal's shell to bring the session back: go to its
 * folder, then start the agent. Null when it can't be written safely for that shell.
 */
export function resumeLine(rec, kind = "posix") {
  const argv = resumeArgv(rec);
  if (!argv) return null;
  const env = rec.dir && AGENTS[rec.agent].dirVar ? [AGENTS[rec.agent].dirVar, rec.dir] : null;
  if (kind === "pwsh") {
    const parts = [];
    if (rec.cwd) parts.push(`Set-Location -LiteralPath ${psQuote(rec.cwd)}`);
    if (env) parts.push(`$env:${env[0]} = ${psQuote(env[1])}`);
    parts.push(argv.map(psQuote).join(" "));
    // `& 'claude' ...`: a quoted first word needs the call operator.
    parts[parts.length - 1] = "& " + parts[parts.length - 1];
    return parts.join("; ");
  }
  if (kind === "cmd") {
    const words = argv.map(cmdQuote);
    if (words.some((w) => w === null) || (rec.cwd && cmdQuote(rec.cwd) === null)) return null;
    const parts = [];
    if (rec.cwd) parts.push(`cd /d ${cmdQuote(rec.cwd)}`);
    if (env) parts.push(`set "${env[0]}=${env[1]}"`);
    parts.push(words.join(" "));
    return parts.join(" && ");
  }
  const words = (env ? ["env", `${env[0]}=${env[1]}`, ...argv] : argv).map(shQuote).join(" ");
  return `${rec.cwd ? `cd -- ${shQuote(rec.cwd)} && ` : ""}${words}`;
}

/**
 * Claude Code's `sessions/<pid>.json` files, one per interactive process, as
 * the mod reads them off a machine (concatenated). Each is a flat object.
 */
export function parseSessionFiles(text) {
  const out = [];
  for (const m of String(text ?? "").matchAll(/\{[^{}]*\}/g)) {
    try {
      const o = JSON.parse(m[0]);
      if (o && typeof o.sessionId === "string") out.push({ session: o.sessionId, pid: Number(o.pid) || null, cwd: o.cwd ?? null, kind: o.kind ?? null });
    } catch { /* a half-written file: skip it */ }
  }
  return out;
}

/** "3m ago", for a timestamp in ms. */
export function ago(ms, now = Date.now()) {
  if (!ms) return "";
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** `wsl/t3` → { on: "wsl", id: "t3" }; `t3` → { on: null, id: "t3" }. */
export function splitAddress(address) {
  const i = address?.indexOf("/") ?? -1;
  return i > 0 ? { on: address.slice(0, i), id: address.slice(i + 1) } : { on: null, id: address ?? null };
}
