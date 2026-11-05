// install.sh in a throwaway home: herdr-core's `shell` (kept and given back), and OpenCode 2's
// cli.json, with fake hc and opencode commands. Valid TOML is checked with Python's tomllib.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { sh as shExe, toolPath, shPath, mixedPath, gitRoot, windows } from "./sh.js";

const installer = join(dirname(fileURLToPath(import.meta.url)), "..", "install.sh");
// hc 0.1.18's default PowerShell -Command on Windows (`hc get <t> --json` of a terminal started
// with no `shell` configured): it keeps [Environment]::CurrentDirectory on PowerShell's folder.
const HC_PROMPT = "$global:__hc_prompt = $function:prompt; function global:prompt { $p = & $global:__hc_prompt; " +
  "$l = $ExecutionContext.SessionState.Path.CurrentLocation; if ($l.Provider.Name -eq 'FileSystem') " +
  "{ try { [Environment]::CurrentDirectory = $l.ProviderPath } catch {} }; $p }";
const hasToml = spawnSync("python3", ["-c", "import tomllib"]).status === 0;

function home({ opencode = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "recover-install-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const tool = (n, body) => { writeFileSync(join(bin, n), `#!/bin/sh\n${body}\n`); chmodSync(join(bin, n), 0o755); };
  tool("hc", "exit 0");
  // These cases are Linux's (and macOS's): on Windows, Git Bash says Linux to the installer.
  if (windows) tool("uname", "echo Linux");
  if (opencode) tool("opencode", `echo "opencode v${opencode}"`);
  const env = {
    PATH: toolPath(bin), HOME: dir,
    XDG_CONFIG_HOME: join(dir, "config"), XDG_DATA_HOME: join(dir, "data"), XDG_STATE_HOME: join(dir, "state"),
  };
  const sh = (...args) => {
    const r = spawnSync(shExe, [installer, ...args], { env });
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
    if (hasToml) assert.deepEqual(toml(h.cfg).shell, [shPath(script)]);
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
      assert.deepEqual(parsed.shell, [shPath(join(h.dir, ".local", "bin", "herdr-recover-shell")), "nu", "--login"]);
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
  // On Windows, the real Git Bash. Elsewhere, Git Bash faked: C: is a folder of the test's, and
  // cygpath maps between the two forms.
  const dir = mkdtempSync(join(tmpdir(), "recover-install-win-"));
  try {
    const bin = join(dir, "bin");
    const c = join(dir, "c");
    mkdirSync(bin);
    const tool = (n, body) => { writeFileSync(join(bin, n), `#!/bin/sh\n${body}\n`); chmodSync(join(bin, n), 0o755); };
    tool("hc", "exit 0");
    tool("pwsh.exe", "exit 0");
    let env, home, appdata, git, hc;
    if (windows) {
      home = join(dir, "Jo O'Neil");
      appdata = join(home, "AppData", "Roaming");
      env = { PATH: toolPath(bin), HOME: home, APPDATA: appdata };
      git = gitRoot;
      hc = mixedPath(join(bin, "hc"));
    } else {
      mkdirSync(join(c, "Program Files", "Git", "bin"), { recursive: true });
      writeFileSync(join(c, "Program Files", "Git", "bin", "sh.exe"), "");
      tool("uname", "echo MINGW64_NT-10.0");
      tool("cygpath", `case "$1" in
  -u) printf '%s\\n' "$2" | sed 's#\\\\#/#g; s#^C:#${c}#' ;;
  -m) case "$2" in /) echo "C:/Program Files/Git/" ;; ${c}/*) printf '%s\\n' "$2" | sed 's#^${c}#C:#' ;; *) printf 'C:/msys%s\\n' "$2" ;; esac ;;
esac`);
      home = join(c, "Users", "Jo O'Neil");
      appdata = join(home, "AppData", "Roaming");
      env = { PATH: toolPath(bin), HOME: home, APPDATA: "C:\\Users\\Jo O'Neil\\AppData\\Roaming" };
      git = "C:/Program Files/Git";
      hc = `C:/msys${bin}/hc`;
    }
    const out = spawnSync(shExe, [installer], { env }).stdout.toString();
    assert.match(out, /herdr-core:\n {2}installed/, out);
    const cfg = join(appdata, "herdr-core", "config.toml");
    const script = join(home, ".local", "bin", "herdr-recover-shell");
    assert.ok(existsSync(script));
    if (!hasToml) return;
    const [exe, ...args] = toml(cfg).shell;
    assert.equal(exe, "pwsh.exe");
    // hc's own entry (pwsh.exe -NoExit -Command <its prompt>), which keeps the terminal's folder
    // known to hc, then the job; `cygpath -m /`'s trailing slash doesn't double the one after it.
    assert.deepEqual(args.slice(0, 2), ["-NoExit", "-Command"]);
    assert.equal(args.length, 3);
    const quoted = (p) => p.replaceAll("'", "''");
    const scriptWin = windows ? mixedPath(script) : "C:/Users/Jo O'Neil/.local/bin/herdr-recover-shell";
    assert.equal(args[2], HC_PROMPT + "; " +
      `if ($env:HC_TERMINAL_ID) { try { Start-Process -WindowStyle Hidden -FilePath '${quoted(git)}/bin/sh.exe' ` +
      `-ArgumentList ('"${quoted(scriptWin)}" --job {0} {1} pwsh "${quoted(hc)}"' -f $env:HC_TERMINAL_ID, $PID) } catch {} }`);
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

test("opencode 2: once OpenCode 2 has run, OpenCode 1's leftovers don't hold cli.json back", () => {
  const h = home({ opencode: "2.0.28" });
  try {
    const oc = join(h.dir, "config", "opencode");
    mkdirSync(oc, { recursive: true });
    mkdirSync(join(h.dir, "state", "opencode"), { recursive: true });
    writeFileSync(join(h.dir, "state", "opencode", "kv.json"), '{"skipped_version":"1.0"}\n');
    writeFileSync(join(oc, "service.json"), "{}\n");
    h.sh();
    assert.equal(h.read(join(oc, "cli.json")), '{\n  "plugins": ["./herdr-recover"]\n}\n');
  } finally { h.done(); }
});

test("opencode: a config folder with only another tool's plugin isn't OpenCode", () => {
  const h = home();
  try {
    const plugins = join(h.dir, "config", "opencode", "plugins");
    mkdirSync(plugins, { recursive: true });
    writeFileSync(join(plugins, "paseo-terminal-activity.js"), "// another tool's\n");
    const out = h.sh();
    assert.doesNotMatch(out, /OpenCode:/, out);
    assert.match(out, /No supported agent found here/);
    assert.ok(!existsSync(join(plugins, "herdr-recover.js")));
    assert.doesNotMatch(h.sh("--doctor"), /OpenCode/);
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
