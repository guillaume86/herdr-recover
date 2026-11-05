// Running the sh scripts from the tests, on Linux and macOS and on Windows (from Git Bash).
import { spawnSync } from "node:child_process";
import { dirname } from "node:path";

export const windows = process.platform === "win32";

// sh itself: on Windows, Git Bash's, by its full path (a PATH given to a child is searched by
// Node only in Windows form), with its POSIX tools beside it in usr\bin.
export const sh = windows ? spawnSync("sh", ["-c", 'cygpath -w "$(command -v sh)"']).stdout.toString().trim() || "sh" : "sh";

/** A PATH of `bin` (fake commands) and the POSIX tools, in the form sh takes it from Node. */
export const toolPath = (bin) => (windows ? `${bin};${dirname(sh)}` : `${bin}:/usr/bin:/bin`);

/** A path as sh shows it (/c/Users/… on Windows, where Git Bash maps HOME and PATH so). */
export const shPath = (p) => (windows ? p.replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`).replaceAll("\\", "/") : p);

/** A path as Windows programs take it with forward slashes (cygpath -m): C:/Users/… */
export const mixedPath = (p) => p.replaceAll("\\", "/");

/** Git's root in that form (`cygpath -m /`), on Windows. */
export const gitRoot = windows ? spawnSync(sh, ["-c", "cygpath -m /"]).stdout.toString().trim().replace(/\/$/, "") : null;
