import { test } from "node:test";
import assert from "node:assert/strict";
import {
  agentOf, agentForApp, carriedFlags, readRecord, labelArgs, clearArgs, stateOf, decide,
  resumeLine, shellKind, parseSessionFiles, winArgv, splitAddress, validId, KEYS, isWindowsShell, parseTasklist,
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
  assert.equal(agentForApp("pi"), "pi");
  assert.equal(agentForApp("aider"), null);
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
  assert.equal(stateOf(rec(), { live: true, pid: 100 }), "running");
  assert.equal(stateOf(rec(), { live: false, pid: 999 }), "lost");
  // A killed agent's session file outlives it: in a new shell it is lost, whatever looks live.
  assert.equal(stateOf(rec(), { live: true, pid: 999 }), "lost");
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
  // Claude can take well over 15 s to start on Windows, and after a reboot many start at once.
  const sent = rec({ resumed: now - 40_000 });
  assert.equal(decide(sent, { state: "interrupted", now, cameBack: false }), "wait", "still starting");
  const late = rec({ resumed: now - 90_000 });
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

test("Windows: which terminals run a Windows shell, and tasklist's pids", () => {
  assert.ok(isWindowsShell(["pwsh.exe", "-NoExit"]));
  assert.ok(isWindowsShell(["cmd.exe"]));
  assert.ok(!isWindowsShell(["/bin/bash"]));
  const out = '"claude.exe","33376","Console","1","7.776 Ko"\r\n"Claude.exe","63156","Console","1","468.972 Ko"\r\n"pi.exe","70","Console","1","1 Ko"\r\n';
  assert.deepEqual([...parseTasklist(out)], [[33376, "claude.exe"], [63156, "claude.exe"], [70, "pi.exe"]]);
  assert.equal(parseTasklist("INFO: No tasks are running which match the specified criteria.").size, 0);
});

test("Codex, OpenCode and Pi: known by their command, resumed their own way, with their flags", () => {
  assert.equal(agentOf(["codex", "-m", "gpt-5.5"]), "codex");
  assert.equal(agentOf(["opencode"]), "opencode");
  assert.equal(agentOf(["pi", "--model", "x"]), "pi");
  const at = (agent, flags = "[]") => rec({ agent, cwd: "/w", flags });
  assert.equal(resumeLine(at("codex", '["-m","gpt-5.5"]'), "posix"), `cd -- /w && codex resume -m gpt-5.5 ${ID}`);
  assert.equal(resumeLine(at("opencode", '["--model","opencode/big-pickle"]'), "posix"), `cd -- /w && opencode --model opencode/big-pickle --session ${ID}`);
  assert.equal(resumeLine(at("pi"), "pwsh"), `Set-Location -LiteralPath '/w'; & 'pi' '--session' '${ID}'`);
  // A resumed Codex's command line names the subcommand and the session: neither is carried.
  assert.deepEqual(carriedFlags("codex", ["codex", "resume", "-m", "gpt-5.5", "--yolo", "--search", ID]), ["-m", "gpt-5.5", "--search"]);
  assert.deepEqual(carriedFlags("pi", ["pi", "--model", "claude-haiku-4-5", "--thinking", "high", "--session", ID]), ["--model", "claude-haiku-4-5", "--thinking", "high"]);
  assert.equal(readRecord(labels({ session: ID, pid: 42 })).pid, 42);
});

test("decide: an agent with no end hook, seen gone from its shell, was quit", () => {
  const now = 1_000_000;
  const codex = rec({ agent: "codex" });
  assert.equal(decide(codex, { state: "interrupted", now, goneSince: now - 10_000 }), "forget");
  assert.equal(decide(codex, { state: "interrupted", now, goneSince: now - 2_000 }), "wait", "seen gone only just now");
  assert.equal(decide(codex, { state: "interrupted", now }), "wait", "never seen gone");
  assert.equal(decide(codex, { state: "lost", now, goneSince: now - 10_000 }), "resume", "a new shell: a restart, not a quit");
  // Claude Code's SessionEnd hook tells a quit: a crash there stays, for the dialog.
  assert.equal(decide(rec(), { state: "interrupted", now, goneSince: now - 10_000 }), "wait");
  // A resume on its way isn't a quit; one that came up and then went is.
  assert.equal(decide(rec({ agent: "codex", resumed: now - 5_000 }), { state: "interrupted", now, goneSince: now - 10_000 }), "wait");
  assert.equal(decide(rec({ agent: "codex", resumed: now - 90_000 }), { state: "interrupted", now, cameBack: true, goneSince: now - 10_000 }), "forget");
  assert.equal(decide(rec({ agent: "codex", resumed: now - 90_000 }), { state: "interrupted", now, cameBack: false, goneSince: now - 10_000 }), "fail");
});

test("addresses split into machine and id", () => {
  assert.deepEqual(splitAddress("wsl/t3"), { on: "wsl", id: "t3" });
  assert.deepEqual(splitAddress("t3"), { on: null, id: "t3" });
  assert.ok(validId(ID));
  assert.ok(!validId("-x"));
  assert.ok(!validId("a b"));
});
