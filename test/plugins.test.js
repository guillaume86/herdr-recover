// The OpenCode 2 and Pi integrations, each in a process of its own as the agent would run it,
// against a fake hc: what they record, and that only the person's quit marks the session ended.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Runs `body` (an ES module) with a fake hc; returns the hc calls and how the process ended. */
function run(body) {
  const dir = mkdtempSync(join(tmpdir(), "recover-plugin-"));
  try {
    const hc = join(dir, "hc");
    writeFileSync(hc, `#!/bin/sh
printf '%s\\n' "$*" >> "${dir}/calls"
[ "$1" = get ] && printf '{"address":"t3","labels":{},"parent":null,"pid":4242,"state":"live"}\\n'
exit 0
`);
    chmodSync(hc, 0o755);
    writeFileSync(join(dir, "session.jsonl"), "{}\n");
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", body.replaceAll("$SESSION_FILE", join(dir, "session.jsonl"))], {
      env: { ...process.env, HC_TERMINAL_ID: "t3", RECOVER_HC: hc }, timeout: 20_000,
    });
    const calls = existsSync(join(dir, "calls")) ? readFileSync(join(dir, "calls"), "utf8").trim().split("\n") : [];
    return { calls, status: r.status, signal: r.signal, stderr: r.stderr.toString() };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const sleep = "const sleep = (ms) => new Promise((r) => setTimeout(r, ms));";

// OpenCode 2's TUI: its own SIGHUP and SIGTERM handlers exit 0 after cleaning up.
const opencode = (end, { route = "ses_root", ownHandlers = true } = {}) => `
  import plugin from ${JSON.stringify(pathToFileURL(join(root, "opencode", "tui.js")).href)};
  ${sleep}
  if (${ownHandlers}) for (const s of ["SIGHUP", "SIGTERM"]) process.on(s, () => setTimeout(() => process.exit(0), 20));
  const sessions = { ses_root: { directory: "/w" }, ses_child: { parentID: "ses_root", directory: "/w" } };
  const api = { ui: { router: { current: () => ({ type: "session", sessionID: ${JSON.stringify(route)} }) } },
    data: { session: { get: (id) => sessions[id] } } };
  plugin.setup(api);
  await sleep(400);
  ${end}
  await sleep(2000);
`;

test("opencode: the shown session is recorded on its terminal", () => {
  const { calls } = run(opencode("process.exit(0);"));
  assert.equal(calls[0], "get t3 --json");
  assert.match(calls[1], /^label t3 recover\.agent=opencode recover\.session=ses_root recover\.cwd=\/w recover\.flags=\[\] .*recover\.shell=4242 /);
});

test("opencode: a sub-agent's session records its root", () => {
  const { calls } = run(opencode("process.exit(0);", { route: "ses_child" }));
  assert.match(calls[1], /recover\.session=ses_root /);
});

test("opencode: the person's quit marks it ended", () => {
  const { calls, status } = run(opencode("process.exit(0);"));
  assert.equal(status, 0);
  assert.equal(calls.at(-1), "label t3 recover.ended=ses_root");
});

for (const signal of ["SIGHUP", "SIGTERM"]) {
  test(`opencode: ${signal}, though OpenCode then exits 0, leaves it to be resumed`, () => {
    const { calls, status } = run(opencode(`process.kill(process.pid, "${signal}");`));
    assert.equal(status, 0);
    assert.ok(!calls.some((c) => /recover\.ended=\S/.test(c)), calls.join("\n"));
  });
}

test("opencode: a crash leaves it to be resumed", () => {
  const { calls, status } = run(opencode("process.exit(1);"));
  assert.equal(status, 1);
  assert.ok(!calls.some((c) => /recover\.ended=\S/.test(c)));
});

test("opencode: without handlers of OpenCode's own, a signal still ends the process", () => {
  const { signal } = run(opencode(`process.kill(process.pid, "SIGHUP");`, { ownHandlers: false }));
  assert.equal(signal, "SIGHUP");
});

// Pi: its TUI handles SIGHUP and SIGTERM by awaiting the session's abort, then saying
// session_shutdown with reason "quit", then exiting 0 (interactive-mode.ts).
const pi = (end, mode = "tui") => `
  import extension from ${JSON.stringify(pathToFileURL(join(root, "pi", "herdr-recover.ts")).href)};
  ${sleep}
  const handlers = {};
  const fire = async (name, event, ctx) => { for (const f of handlers[name] ?? []) await f(event, ctx); };
  const ctx = { mode: ${JSON.stringify(mode)}, cwd: "/w", sessionManager: { getSessionId: () => "pi-sess-1", getSessionFile: () => "$SESSION_FILE" } };
  extension({ on: (name, f) => (handlers[name] ??= []).push(f) });
  for (const s of ["SIGHUP", "SIGTERM"]) process.prependListener(s, async () => { await sleep(20); await fire("session_shutdown", { reason: "quit" }, ctx); process.exit(0); });
  await fire("session_start", { reason: "startup" }, ctx);
  await sleep(300);
  ${end}
  await sleep(2000);
`;

const piRuns = spawnSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(pathToFileURL(join(root, "pi", "herdr-recover.ts")).href)})`]).status === 0;

test("pi: the session is recorded, and the person's quit marks it ended", { skip: !piRuns && "this Node can't load .ts" }, () => {
  const { calls } = run(pi(`await fire("session_shutdown", { reason: "quit" }, ctx); process.exit(0);`));
  assert.match(calls[1], /^label t3 recover\.agent=pi recover\.session=pi-sess-1 recover\.cwd=\/w /);
  assert.equal(calls.at(-1), "label t3 recover.ended=pi-sess-1");
});

for (const signal of ["SIGHUP", "SIGTERM"]) {
  test(`pi: ${signal}, though Pi then says "quit", leaves it to be resumed`, { skip: !piRuns && "this Node can't load .ts" }, () => {
    const { calls, status } = run(pi(`process.kill(process.pid, "${signal}");`));
    assert.equal(status, 0);
    assert.ok(calls.some((c) => c.includes("recover.session=pi-sess-1")));
    assert.ok(!calls.some((c) => /recover\.ended=\S/.test(c)), calls.join("\n"));
  });
}

test("pi: switching to another session doesn't end the record", { skip: !piRuns && "this Node can't load .ts" }, () => {
  const { calls } = run(pi(`await fire("session_shutdown", { reason: "new" }, ctx); process.exit(0);`));
  assert.ok(!calls.some((c) => /recover\.ended=\S/.test(c)));
});

test("pi: a print run is not the terminal's", { skip: !piRuns && "this Node can't load .ts" }, () => {
  const { calls } = run(pi(`await fire("session_shutdown", { reason: "quit" }, ctx); process.exit(0);`, "print"));
  assert.deepEqual(calls, []);
});
