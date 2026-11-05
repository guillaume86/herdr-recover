import { test } from "node:test";
import assert from "node:assert/strict";
import {
  agentOf, agentForApp, carriedFlags, readRecord, labelArgs, clearArgs, stateOf, decide,
  resumeLine, shellKind, parseSessionFiles, winArgv, splitAddress, validId, KEYS,
} from "../mods/recover/lib/core.js";

const ID = "03f81d7c-f3fb-4095-b4fa-845fe178921c";
const labels = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [`recover.${k}`, String(v)]));
const rec = (o = {}) => readRecord(labels({ agent: "claude", session: ID, cwd: "/w", shell: 100, ...o }));

test("agents are known by their command, with or without a path or .exe", () => {
  assert.equal(agentOf(["claude"]), "claude");
  assert.equal(agentOf(["/home/u/.local/bin/claude", "--model", "x"]), "claude");
  assert.equal(agentOf(["C:\\Users\\u\\.local\\bin\\claude.exe"]), "claude");
  assert.equal(agentOf(["bash"]), null);
  assert.equal(agentForApp("claude-code"), "claude");
  assert.equal(agentForApp("pi"), null);
});

test("only the flags a resume accepts are carried, with their values", () => {
  assert.deepEqual(
    carriedFlags("claude", ["claude", "--model", "opus", "fix the bug", "--dangerously-skip-permissions", "--add-dir", "a", "b", "--resume", "x", "-p"]),
    ["--model", "opus", "--dangerously-skip-permissions", "--add-dir", "a", "b"],
  );
  assert.deepEqual(carriedFlags("claude", ["claude", "--model=sonnet"]), ["--model=sonnet"]);
  // A flag whose value is missing or another flag is dropped, not glued to the next word.
  assert.deepEqual(carriedFlags("claude", ["claude", "--model", "--verbose"]), []);
});

test("labels read back as a record; auto stays on unless turned off", () => {
  const r = readRecord(labels({ agent: "claude", session: ID, cwd: "C:\\w", flags: '["--model","x"]', shell: 42, resumed: 7 }));
  assert.equal(r.session, ID);
  assert.equal(r.cwd, "C:\\w");
  assert.deepEqual(r.flags, ["--model", "x"]);
  assert.equal(r.shell, 42);
  assert.equal(r.resumed, 7);
  assert.equal(r.failed, null);
  assert.equal(r.auto, true);
  assert.equal(readRecord(labels({ session: ID, auto: "off" })).auto, false);
  assert.equal(readRecord({}), null);
  assert.deepEqual(readRecord(labels({ session: ID, flags: "not json" })).flags, []);
});

test("clearing removes every label but the person's auto choice", () => {
  const args = clearArgs();
  assert.equal(args.length, KEYS.length - 1);
  assert.ok(args.every((a) => a.endsWith("=")));
  assert.ok(!args.some((a) => a.startsWith("recover.auto")));
  assert.deepEqual(labelArgs({ failed: 5, resumed: null }), ["recover.failed=5", "recover.resumed="]);
});

test("state: running, lost to a new shell, interrupted under the same one, failed", () => {
  assert.equal(stateOf(rec(), { live: true, pid: 999 }), "running");
  assert.equal(stateOf(rec(), { live: false, pid: 999 }), "lost");
  assert.equal(stateOf(rec(), { live: false, pid: 100 }), "interrupted");
  assert.equal(stateOf(rec({ failed: 5 }), { live: false, pid: 100 }), "failed");
  assert.equal(stateOf(rec({ failed: 5 }), { live: false, pid: 999 }), "failed");
  assert.equal(stateOf(null, { live: false, pid: 1 }), null);
});

test("decide: a loss is resumed unless auto is off; nothing else is typed by itself", () => {
  assert.equal(decide(rec(), { state: "lost" }), "resume");
  assert.equal(decide(rec({ auto: "off" }), { state: "lost" }), "wait");
  assert.equal(decide(rec(), { state: "running" }), "wait");
  assert.equal(decide(rec(), { state: "interrupted" }), "wait");
  assert.equal(decide(rec(), { state: "failed" }), "wait");
  assert.equal(decide(readRecord(labels({ agent: "claude", session: "bad id;rm" })), { state: "lost" }), "wait");
});

test("decide: a resume that never brought the agent up fails, after the grace period", () => {
  const now = 1_000_000;
  const sent = rec({ resumed: now - 5_000 });
  assert.equal(decide(sent, { state: "interrupted", now, cameBack: false }), "wait", "still starting");
  const late = rec({ resumed: now - 30_000 });
  assert.equal(decide(late, { state: "interrupted", now, cameBack: false }), "fail");
  assert.equal(decide(late, { state: "interrupted", now, cameBack: true }), "wait", "it came up, then was quit");
  assert.equal(decide(late, { state: "interrupted", now, cameBack: null }), "fail", "unknown, recent: failed");
  const old = rec({ resumed: now - 10 * 60_000 });
  assert.equal(decide(old, { state: "interrupted", now, cameBack: null }), "wait", "unknown, long ago: not a failure to report now");
});

test("resume line for POSIX shells: cd, then the agent, quoted", () => {
  const r = rec({ cwd: "/home/u/my work", flags: '["--model","opus"]' });
  assert.equal(resumeLine(r, "posix"), `cd -- '/home/u/my work' && claude --model opus --resume ${ID}`);
  const withDir = rec({ dir: "/home/u/.claude-work" });
  assert.equal(resumeLine(withDir, "posix"), `cd -- /w && env CLAUDE_CONFIG_DIR=/home/u/.claude-work claude --resume ${ID}`);
  assert.equal(resumeLine(rec({ cwd: "" }), "posix"), `claude --resume ${ID}`);
});

test("resume line for PowerShell: literal paths, the call operator, apostrophes doubled", () => {
  const r = rec({ cwd: "C:\\Users\\o'neil\\dev", dir: "C:\\cfg" });
  assert.equal(
    resumeLine(r, "pwsh"),
    `Set-Location -LiteralPath 'C:\\Users\\o''neil\\dev'; $env:CLAUDE_CONFIG_DIR = 'C:\\cfg'; & 'claude' '--resume' '${ID}'`,
  );
});

test("resume line for cmd: refused when a word has a double quote", () => {
  assert.equal(resumeLine(rec({ cwd: "C:\\a b" }), "cmd"), `cd /d "C:\\a b" && claude --resume ${ID}`);
  assert.equal(resumeLine(rec({ cwd: 'C:\\a"b' }), "cmd"), null);
});

test("the shell is known from the terminal's command line", () => {
  assert.equal(shellKind(["pwsh.exe", "-NoExit", "-Command", "..."]), "pwsh");
  assert.equal(shellKind(["C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"]), "pwsh");
  assert.equal(shellKind(["cmd.exe"]), "cmd");
  assert.equal(shellKind(["/bin/bash"]), "posix");
  assert.equal(shellKind([]), "posix");
});

test("Claude Code's session files are read from their concatenation", () => {
  const text = `{"pid":63156,"sessionId":"${ID}","cwd":"C:\\\\Users\\\\u","kind":"interactive","peerFeatures":["a","b"]}\n{"pid":1,"sessionId":"x","kind":"print"}\n{broken`;
  const got = parseSessionFiles(text);
  assert.deepEqual(got.map((s) => [s.session, s.pid, s.kind]), [[ID, 63156, "interactive"], ["x", 1, "print"]]);
  assert.equal(got[0].cwd, "C:\\Users\\u");
  assert.deepEqual(parseSessionFiles(""), []);
});

test("a Windows command line splits like the program sees it", () => {
  assert.deepEqual(winArgv(`"C:\\Program Files\\x\\claude.exe" --model opus --add-dir "C:\\a b" c`), ["C:\\Program Files\\x\\claude.exe", "--model", "opus", "--add-dir", "C:\\a b", "c"]);
  assert.deepEqual(winArgv(`claude --append "say \\"hi\\""`), ["claude", "--append", 'say "hi"']);
  assert.deepEqual(winArgv(""), []);
});

test("addresses split into machine and id", () => {
  assert.deepEqual(splitAddress("wsl/t3"), { on: "wsl", id: "t3" });
  assert.deepEqual(splitAddress("t3"), { on: null, id: "t3" });
  assert.ok(validId(ID));
  assert.ok(!validId("-x"));
  assert.ok(!validId("a b"));
});
