// install.sh in a throwaway home: herdr-core's `shell` (kept and given back), and OpenCode 2's
// cli.json, with fake hc and opencode commands. Valid TOML is checked with Python's tomllib.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const installer = join(dirname(fileURLToPath(import.meta.url)), "..", "install.sh");
const hasToml = spawnSync("python3", ["-c", "import tomllib"]).status === 0;

function home({ opencode = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "recover-install-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const tool = (n, body) => { writeFileSync(join(bin, n), `#!/bin/sh\n${body}\n`); chmodSync(join(bin, n), 0o755); };
  tool("hc", "exit 0");
  if (opencode) tool("opencode", `echo "opencode v${opencode}"`);
  const env = {
    PATH: `${bin}:/usr/bin:/bin`, HOME: dir,
    XDG_CONFIG_HOME: join(dir, "config"), XDG_DATA_HOME: join(dir, "data"), XDG_STATE_HOME: join(dir, "state"),
  };
  const sh = (...args) => {
    const r = spawnSync("sh", [installer, ...args], { env });
    return r.stdout.toString() + r.stderr.toString();
  };
  const cfg = join(dir, "config", "herdr-core", "config.toml");
  const read = (f) => (existsSync(f) ? readFileSync(f, "utf8") : null);
  return { dir, env, sh, cfg, read, done: () => rmSync(dir, { recursive: true, force: true }) };
}

function toml(file) {
  const r = spawnSync("python3", ["-c", "import tomllib,json,sys; print(json.dumps(tomllib.load(open(sys.argv[1],'rb'))))", file]);
  assert.equal(r.status, 0, r.stderr.toString());
  return JSON.parse(r.stdout.toString());
}

test("herdr-core: a fresh config gets the shell, and uninstall takes it out", () => {
  const h = home();
  try {
    assert.match(h.sh(), /herdr-core:\n {2}installed/);
    const script = join(h.dir, ".local", "bin", "herdr-recover-shell");
    assert.ok(existsSync(script));
    if (hasToml) assert.deepEqual(toml(h.cfg).shell, [script]);
    assert.match(h.sh("--doctor"), /herdr-core: shell set up/);
    h.sh("--uninstall");
    assert.equal(h.read(h.cfg), null);
    assert.ok(!existsSync(script));
    assert.match(h.sh("--doctor"), /herdr-core: not set up/);
  } finally { h.done(); }
});

test("herdr-core: a shell already set is run by Recover's, and given back", () => {
  const h = home();
  try {
    mkdirSync(dirname(h.cfg), { recursive: true });
    const before = 'notes = false\nshell = ["nu", "--login"]\n\n[ssh]\nx = 1\n';
    writeFileSync(h.cfg, before);
    h.sh();
    if (hasToml) {
      const parsed = toml(h.cfg);
      assert.deepEqual(parsed.shell, [join(h.dir, ".local", "bin", "herdr-recover-shell"), "nu", "--login"]);
      assert.equal(parsed.notes, false);
      assert.deepEqual(parsed.ssh, { x: 1 });
    }
    // Again: the shell there was is still the one kept, not Recover's.
    h.sh();
    assert.equal((h.read(h.cfg).match(/was: shell = \["nu", "--login"\]/g) ?? []).length, 1);
    if (hasToml) assert.equal(toml(h.cfg).shell.length, 3);
    h.sh("--uninstall");
    const after = h.read(h.cfg);
    assert.match(after, /^shell = \["nu", "--login"\]$/m);
    assert.doesNotMatch(after, /herdr-recover/);
    assert.match(after, /notes = false/);
    assert.match(after, /\[ssh\]\nx = 1/);
  } finally { h.done(); }
});

test("herdr-core: a shell over several lines is left alone", () => {
  const h = home();
  try {
    mkdirSync(dirname(h.cfg), { recursive: true });
    writeFileSync(h.cfg, 'shell = [\n  "nu",\n]\n');
    assert.match(h.sh(), /several lines/);
    assert.equal(h.read(h.cfg), 'shell = [\n  "nu",\n]\n');
  } finally { h.done(); }
});

test("herdr-core on Windows: PowerShell starts the job through Git Bash", () => {
  // Git Bash, faked: C: is a folder of the test's, and cygpath maps between the two forms.
  const dir = mkdtempSync(join(tmpdir(), "recover-install-win-"));
  try {
    const bin = join(dir, "bin");
    const c = join(dir, "c");
    mkdirSync(bin);
    mkdirSync(join(c, "Program Files", "Git", "bin"), { recursive: true });
    writeFileSync(join(c, "Program Files", "Git", "bin", "sh.exe"), "");
    const tool = (n, body) => { writeFileSync(join(bin, n), `#!/bin/sh\n${body}\n`); chmodSync(join(bin, n), 0o755); };
    tool("uname", "echo MINGW64_NT-10.0");
    tool("hc", "exit 0");
    tool("pwsh.exe", "exit 0");
    tool("cygpath", `case "$1" in
  -u) printf '%s\\n' "$2" | sed 's#\\\\#/#g; s#^C:#${c}#' ;;
  -m) case "$2" in /) echo "C:/Program Files/Git" ;; ${c}/*) printf '%s\\n' "$2" | sed 's#^${c}#C:#' ;; *) printf 'C:/msys%s\\n' "$2" ;; esac ;;
esac`);
    const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: join(c, "Users", "Jo O'Neil"), APPDATA: "C:\\Users\\Jo O'Neil\\AppData\\Roaming" };
    const out = spawnSync("sh", [installer], { env }).stdout.toString();
    assert.match(out, /herdr-core:\n {2}installed/, out);
    const cfg = join(c, "Users", "Jo O'Neil", "AppData", "Roaming", "herdr-core", "config.toml");
    assert.ok(existsSync(join(c, "Users", "Jo O'Neil", ".local", "bin", "herdr-recover-shell")));
    if (!hasToml) return;
    const [exe, ...args] = toml(cfg).shell;
    assert.equal(exe, "pwsh.exe");
    assert.deepEqual(args.slice(0, 3), ["-NoLogo", "-NoExit", "-Command"]);
    assert.equal(args[3], "if ($env:HC_TERMINAL_ID) { try { Start-Process -WindowStyle Hidden -FilePath 'C:/Program Files/Git/bin/sh.exe' " +
      `-ArgumentList ('"C:/Users/Jo O''Neil/.local/bin/herdr-recover-shell" --job {0} {1} pwsh "C:/msys${bin}/hc"' -f $env:HC_TERMINAL_ID, $PID) } catch {} }`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("opencode 2: the TUI plugin is listed in cli.json, OpenCode 1's file removed", () => {
  const h = home({ opencode: "2.0.28" });
  try {
    const oc = join(h.dir, "config", "opencode");
    mkdirSync(join(oc, "plugins"), { recursive: true });
    writeFileSync(join(oc, "plugins", "herdr-recover.js"), "// v1\n");
    writeFileSync(join(oc, "cli.json"), '{\n  // mine\n  "theme": "x",\n  "plugins": ["./other"]\n}\n');
    h.sh();
    assert.ok(existsSync(join(oc, "herdr-recover", "tui.js")));
    assert.ok(!existsSync(join(oc, "plugins", "herdr-recover.js")));
    assert.equal(h.read(join(oc, "cli.json")), '{\n  // mine\n  "theme": "x",\n  "plugins": ["./herdr-recover", "./other"]\n}\n');
    assert.match(h.sh("--doctor"), /OpenCode: TUI plugin installed/);
    h.sh("--uninstall");
    assert.equal(h.read(join(oc, "cli.json")), '{\n  // mine\n  "theme": "x",\n  "plugins": ["./other"]\n}\n');
    assert.ok(!existsSync(join(oc, "herdr-recover")));
  } finally { h.done(); }
});

for (const [name, before, after] of [
  ["no cli.json", null, '{\n  "plugins": ["./herdr-recover"]\n}\n'],
  ["an empty object", "{}\n", '{\n  "plugins": ["./herdr-recover"]\n}\n'],
  ["an empty plugins list", '{ "plugins": [] }\n', '{ "plugins": ["./herdr-recover"] }\n'],
  ["other settings only", '{\n  "theme": "x"\n}\n', '{\n  "plugins": ["./herdr-recover"],\n  "theme": "x"\n}\n'],
]) {
  test(`opencode 2: cli.json with ${name}`, () => {
    const h = home({ opencode: "2.0.28" });
    try {
      const oc = join(h.dir, "config", "opencode");
      mkdirSync(oc, { recursive: true });
      if (before !== null) writeFileSync(join(oc, "cli.json"), before);
      h.sh();
      assert.equal(h.read(join(oc, "cli.json")), after);
      h.sh();
      assert.equal(h.read(join(oc, "cli.json")), after, "a second run changes nothing");
    } finally { h.done(); }
  });
}

test("opencode 2: no cli.json while OpenCode 1's settings wait to be moved into it", () => {
  const h = home({ opencode: "2.0.28" });
  try {
    const oc = join(h.dir, "config", "opencode");
    mkdirSync(oc, { recursive: true });
    writeFileSync(join(oc, "tui.json"), "{}\n");
    assert.match(h.sh(), /start OpenCode once/);
    assert.ok(!existsSync(join(oc, "cli.json")));
  } finally { h.done(); }
});

test("opencode 1: the plugin file, as before", () => {
  const h = home({ opencode: "1.14.2" });
  try {
    h.sh();
    assert.ok(existsSync(join(h.dir, "config", "opencode", "plugins", "herdr-recover.js")));
    assert.ok(!existsSync(join(h.dir, "config", "opencode", "cli.json")));
  } finally { h.done(); }
});
