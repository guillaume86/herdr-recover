// hook/recover-shell.sh: its resume lines match the mod's (lib/core.js) for every shell kind,
// in every awk at hand, and its job does what the rules say against a fake hc.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readRecord, resumeLine } from "../mods/recover/lib/core.js";

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, "..", "hook", "recover-shell.sh");
const ID = "873d75aa-1a3e-4bc5-9340-0efc1adfb1af";
// The curly single quotes, which PowerShell takes for quotes: ‘ ’ ‚ ‛
const [LSQ, RSQ, SLQ, HRQ] = [0x2018, 0x2019, 0x201a, 0x201b].map((c) => String.fromCodePoint(c));

// The awks this machine has: the script must work with whichever one the shell finds.
const awks = ["awk", "mawk", "gawk", "busybox awk", "original-awk"].filter((a) => spawnSync("sh", ["-c", `command -v ${a.split(" ")[0]}`]).status === 0);

function terminal(labels, pid = 4242) {
  return JSON.stringify({
    address: "t3", argv: ["/bin/bash"], cols: 80, cwd: "/", foreground: { argv: ["/bin/bash"], name: "bash", pid },
    identity: "ghostty", keep: true, labels, name: null, parent: null, pid, title: 'a "labels":{ trap', turn: 0,
  });
}

/** The script's read_record, with a given awk: the sh variables it sets. */
function readWith(awk, json, kind) {
  const code = `awk() { command ${awk} "$@"; }; eval "$(sed -n '/^read_record() {/,/^}/p' "$1")"; ` +
    `eval "$(read_record "$2")"; printf '%s\\n%s\\n%s' "$tpid" "$session" "$line"`;
  const [tpid, session, line] = execFileSync("sh", ["-c", code, "sh", script, kind], { input: json }).toString().split("\n");
  return { tpid, session, line };
}

const cases = [
  ["claude basic", { "recover.agent": "claude", "recover.session": ID, "recover.cwd": "/home/u", "recover.flags": "[]" }],
  ["flags, config folder and a quote in the folder", {
    "recover.agent": "claude", "recover.session": ID, "recover.cwd": "/home/g/it's here", "recover.dir": "/home/g/.claude work",
    "recover.flags": JSON.stringify(["--model", "opus", "--permission-mode", "acceptEdits", "--add-dir", "/a b", "x", "--dangerously-skip-permissions"]),
  }],
  ["a flag holding JSON", { "recover.agent": "claude", "recover.session": ID, "recover.cwd": "/x", "recover.flags": JSON.stringify(["--settings", '{"a":1,"b":"c\\\\d"}']) }],
  ["codex with its home", { "recover.agent": "codex", "recover.session": "0199a-thread", "recover.cwd": "/srv/app", "recover.dir": "/home/g/.codex", "recover.flags": JSON.stringify(["-m", "gpt-5", "--no-daemon"]) }],
  ["opencode", { "recover.agent": "opencode", "recover.session": "ses_e53217d2bffesMoBD1pbqfvel9", "recover.cwd": "/home/g/dev/x", "recover.flags": JSON.stringify(["--standalone"]) }],
  ["pi", { "recover.agent": "pi", "recover.session": "pi.sess:1", "recover.cwd": "/p", "recover.flags": "[]" }],
  ["shell metacharacters in the folder", { "recover.agent": "claude", "recover.session": ID, "recover.cwd": '/tmp/a "b" \\c $(x) `y` é!', "recover.flags": "[]" }],
  ["a Windows folder", { "recover.agent": "claude", "recover.session": ID, "recover.cwd": "C:\\Users\\Jo O'Neil\\dev", "recover.dir": "C:\\Users\\Jo\\.claude", "recover.flags": "[]" }],
  ["no folder", { "recover.agent": "claude", "recover.session": ID }],
  ["unreadable flags", { "recover.agent": "claude", "recover.session": ID, "recover.cwd": "/x", "recover.flags": "nope" }],
  ["an unknown agent", { "recover.agent": "aider", "recover.session": ID, "recover.cwd": "/x" }],
  ["a session id that is an option", { "recover.agent": "claude", "recover.session": "-rf", "recover.cwd": "/x" }],
  ["a session id too long", { "recover.agent": "claude", "recover.session": "a".repeat(129), "recover.cwd": "/x" }],
  ["another label with an escape", { "recover.agent": "claude", "recover.session": ID, "recover.cwd": "/x", "herdr.title": "bell\u0007" }],
  ["no record", { "herdr.space": "sp1", where: "~ / 1" }],
  // PowerShell's quotes include the curly ones: undoubled, the rest of the folder would be code.
  ["curly quotes in the folder", { "recover.agent": "claude", "recover.session": ID, "recover.cwd": `C:\\x\\it${RSQ}s; Write-Output INJECTED; ${RSQ} ${LSQ}a${LSQ} ${SLQ}${HRQ}'${RSQ}`, "recover.flags": "[]" }],
  ["a newline in the folder", { "recover.agent": "claude", "recover.session": ID, "recover.cwd": "/x\ny", "recover.flags": "[]" }],
  ["a tab in a flag", { "recover.agent": "claude", "recover.session": ID, "recover.cwd": "/x", "recover.flags": JSON.stringify(["--add-dir", "a\tb"]) }],
];

for (const awk of awks) {
  for (const kind of ["posix", "pwsh", "cmd", "fish"]) {
    test(`${awk}: ${kind} resume lines match the mod's`, () => {
      for (const [name, labels] of cases) {
        const got = readWith(awk, terminal(labels), kind);
        assert.equal(got.line, resumeLine(readRecord(labels), kind) ?? "", name);
        assert.equal(got.tpid, "4242", name);
      }
    });
  }
  test(`${awk}: a control character is never typed`, () => {
    const labels = { "recover.agent": "claude", "recover.session": ID, "recover.cwd": "/x\u0001y" };
    assert.equal(readWith(awk, terminal(labels), "posix").line, "");
  });
}

test("posix lines come back as the same words in sh", () => {
  for (const [name, labels] of cases) {
    const { line } = readWith("awk", terminal(labels), "posix");
    if (!line) continue;
    const rec = readRecord(labels);
    // Run the line with `cd` and the agent replaced by printers of their arguments. On stdin: on
    // Windows, an argument goes through a command line, which Git Bash splits its own way.
    const out = execFileSync("sh", ["-s"], { input: `cd() { :; }; env() { shift; "$@"; }; claude() { printf '[%s]' claude "$@"; }; codex() { printf '[%s]' codex "$@"; }; opencode() { printf '[%s]' opencode "$@"; }; pi() { printf '[%s]' pi "$@"; }; ${line}\n` }).toString();
    const argv = { claude: ["claude", ...rec.flags, "--resume", rec.session], codex: ["codex", "resume", ...rec.flags, rec.session],
      opencode: ["opencode", ...rec.flags, "--session", rec.session], pi: ["pi", ...rec.flags, "--session", rec.session] }[rec.agent];
    assert.equal(out, argv.map((w) => `[${w}]`).join(""), name);
  }
});

const pwsh = spawnSync("pwsh", ["-NoProfile", "-Command", "exit 0"]).status === 0;

test("pwsh lines come back as the same words in PowerShell", { skip: !pwsh && "no pwsh here" }, () => {
  for (const [name, labels] of cases) {
    const { line } = readWith("awk", terminal(labels), "pwsh");
    if (!line) continue;
    const rec = readRecord(labels);
    // Set-Location and the agent replaced by printers of their arguments (a function comes
    // before a cmdlet); anything else the line ran would print too.
    const code = "[Console]::OutputEncoding = [Text.Encoding]::UTF8; " +
      "function Set-Location { param([string]$LiteralPath) Write-Output \"[cd $LiteralPath]\" }; " +
      ["claude", "codex", "opencode", "pi"].map((a) => `function ${a} { Write-Output '[${a}]'; foreach ($w in $args) { Write-Output "[$w]" } }`).join("; ") +
      "; " + line;
    const r = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(code, "utf16le").toString("base64")]);
    const argv = { claude: ["claude", ...rec.flags, "--resume", rec.session], codex: ["codex", "resume", ...rec.flags, rec.session],
      opencode: ["opencode", ...rec.flags, "--session", rec.session], pi: ["pi", ...rec.flags, "--session", rec.session] }[rec.agent];
    const want = [...(rec.cwd ? [`[cd ${rec.cwd}]`] : []), ...argv.map((w) => `[${w}]`)];
    assert.deepEqual(r.stdout.toString("utf8").split(/\r?\n/).filter(Boolean), want, `${name}\n${r.stderr}`);
  }
});

// The job, against a fake hc that logs its calls and can fail its first `get`s, as hc does
// while the core restarts the terminal.
function runJob(labels, { pid = 4242, me = 4242, kind = "posix", failGets = 0, lostAfterClaim = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "recover-shell-"));
  try {
    writeFileSync(join(dir, "get.json"), terminal(labels, pid));
    writeFileSync(join(dir, "fails"), String(failGets));
    // The claim lands on the record, as hc does; lostAfterClaim: the shell is lost again right
    // after it (another pid).
    writeFileSync(join(dir, "apply.cjs"), `const fs = require("fs"), [f, v] = process.argv.slice(2);
const t = JSON.parse(fs.readFileSync(f, "utf8"));
t.labels["recover.shell"] = v;
if (${lostAfterClaim}) t.pid = 9999;
fs.writeFileSync(f, JSON.stringify(t));
`);
    const hc = join(dir, "hc");
    writeFileSync(hc, `#!/bin/sh
printf '%s\\n' "$*" >> "${dir}/calls"
if [ "$1" = get ]; then
  n=$(cat "${dir}/fails"); if [ "$n" -gt 0 ]; then echo $((n - 1)) > "${dir}/fails"; echo '{"error":{"kind":"unavailable"}}'; exit 1; fi
  cat "${dir}/get.json"
fi
if [ "$1" = label ]; then
  for a in "$@"; do case $a in recover.shell=*) node "${dir}/apply.cjs" "${dir}/get.json" "\${a#recover.shell=}" ;; esac; done
fi
`);
    chmodSync(hc, 0o755);
    spawnSync("sh", [script, "--job", "t3", String(me), kind, hc], { env: { ...process.env, RECOVER_SETTLE: "0", RECOVER_LOG: join(dir, "log") } });
    const read = (f) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), "utf8") : "");
    return { calls: read("calls").trim().split("\n").filter(Boolean), log: read("log") };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const record = { "recover.agent": "claude", "recover.session": ID, "recover.cwd": "/w", "recover.flags": '["--model","opus"]', "recover.shell": "1111" };

test("job: a lost session is claimed, then typed", () => {
  const { calls } = runJob(record);
  assert.equal(calls[0], "get t3 --json");
  assert.match(calls[1], /^label t3 recover\.shell=4242 recover\.resumed=\d+000 recover\.failed=$/);
  // Checked again just before typing: still this shell, still claimed by this job.
  assert.equal(calls[2], "get t3 --json");
  assert.equal(calls[3], `send t3 cd -- /w && claude --model opus --resume ${ID}`);
  assert.equal(calls.length, 4);
});

test("job: a shell lost again before the line is typed gets nothing (its successor's job types it)", () => {
  const { calls, log } = runJob(record, { lostAfterClaim: true });
  assert.match(calls[1], /^label t3 recover\.shell=4242 /);
  assert.ok(!calls.some((c) => c.startsWith("send")), calls.join("\n"));
  assert.match(log, /moved on/);
});

test("job: it waits out a terminal the core is still restarting", () => {
  const { calls } = runJob(record, { failGets: 3 });
  // Three answered "unavailable", then the read, then the check before typing.
  assert.equal(calls.filter((c) => c.startsWith("get")).length, 5);
  assert.match(calls.at(-1), /^send t3 /);
});

test("job: PowerShell gets a PowerShell line", () => {
  const { calls } = runJob({ ...record, "recover.cwd": "C:\\Users\\u\\dev" }, { kind: "pwsh" });
  assert.equal(calls.at(-1), `send t3 Set-Location -LiteralPath 'C:\\Users\\u\\dev'; & 'claude' '--model' 'opus' '--resume' '${ID}'`);
});

test("job: the claim names the terminal's program as hc sees it", () => {
  // On Windows a launcher can stand between hc and the shell whose $PID started the job.
  const { calls } = runJob(record, { pid: 5000, me: 5001 });
  assert.match(calls[1], /recover\.shell=5000 /);
});

test("job: a session the person ended is forgotten, not resumed", () => {
  const { calls, log } = runJob({ ...record, "recover.ended": ID });
  assert.match(calls[1], /^label t3 recover\.agent= recover\.session= .*recover\.ended=$/);
  assert.doesNotMatch(calls[1], /recover\.auto=/);
  assert.equal(calls.length, 2);
  assert.match(log, /forgot claude/);
});

test("job: an end mark for another session doesn't stop this one", () => {
  const { calls } = runJob({ ...record, "recover.ended": "11111111-2222-3333-4444-555555555555" });
  assert.match(calls.at(-1), /^send t3 /);
});

for (const [name, labels, why] of [
  ["auto resume off", { ...record, "recover.auto": "off" }, /auto resume is off/],
  ["a resume that failed", { ...record, "recover.failed": "1793899508000" }, /failed/],
  ["already this shell's", { ...record, "recover.shell": "4242" }, /already this shell/],
  ["no record", { where: "~ / 1" }, /no session on record/],
  ["an unknown agent", { ...record, "recover.agent": "aider" }, /can't write/],
]) {
  test(`job: nothing typed for ${name}`, () => {
    const { calls, log } = runJob(labels);
    assert.deepEqual(calls, ["get t3 --json"]);
    assert.match(log, why);
  });
}

test("the shell: it becomes the shell it was given, or sh when that one is missing", () => {
  const env = { ...process.env, HC_TERMINAL_ID: "" };
  assert.equal(execFileSync("sh", [script, "sh", "-c", "echo hello"], { env }).toString(), "hello\n");
  assert.equal(execFileSync("sh", [script, "/nonexistent/shell", "-c", "echo hi"], { env, input: "echo fallback\n" }).toString(), "fallback\n");
});
