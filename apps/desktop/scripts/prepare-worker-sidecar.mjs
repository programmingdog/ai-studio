import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const repositoryRoot = resolve(desktopRoot, "../..");
const engineRoot = join(repositoryRoot, "python-engine");
const tauriRoot = join(desktopRoot, "src-tauri");
const binariesRoot = join(tauriRoot, "binaries");
const targetRoot = join(tauriRoot, "target", "pyinstaller");
const targetTriple = process.env.AIVS_TARGET_TRIPLE
  || execFileSync("rustc", ["--print", "host-tuple"], { encoding: "utf8" }).trim();
const windowsTarget = targetTriple.includes("windows");
const macTarget = targetTriple.includes("apple-darwin");
if (!windowsTarget && !macTarget) throw new Error(`当前仅配置 Windows 和 macOS Worker：${targetTriple}`);

const extension = windowsTarget ? ".exe" : "";
const destination = join(binariesRoot, `aivs-worker-${targetTriple}${extension}`);
const python = process.env.AIVS_PYTHON || (windowsTarget ? "python" : "python3");

function newestSourceMtime(directory) {
  let newest = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "__pycache__" && entry.name !== "tests") {
        newest = Math.max(newest, newestSourceMtime(path));
      }
    } else if (entry.name.endsWith(".py") || entry.name === "pyproject.toml") {
      newest = Math.max(newest, statSync(path).mtimeMs);
    }
  }
  return newest;
}

mkdirSync(binariesRoot, { recursive: true });
if (
  existsSync(destination)
  && statSync(destination).size > 1_000_000
  && statSync(destination).mtimeMs >= newestSourceMtime(engineRoot)
) {
  if (!windowsTarget) chmodSync(destination, 0o755);
  console.log(`[worker] ${basename(destination)} 已就绪`);
  process.exit(0);
}

const distRoot = join(targetRoot, "dist");
const workRoot = join(targetRoot, "work");
const specRoot = join(targetRoot, "spec");
for (const directory of [distRoot, workRoot, specRoot]) mkdirSync(directory, { recursive: true });

console.log(`[worker] 正在为 ${targetTriple} 构建独立 Worker`);
execFileSync(python, [
  "-m", "PyInstaller",
  "--noconfirm",
  "--clean",
  "--onefile",
  "--name", "aivs-worker",
  "--paths", engineRoot,
  "--hidden-import", "fitz",
  "--hidden-import", "websocket",
  "--hidden-import", "pkg_resources.py2_warn",
  "--distpath", distRoot,
  "--workpath", workRoot,
  "--specpath", specRoot,
  join(engineRoot, "main.py"),
], { cwd: repositoryRoot, stdio: "inherit" });

const built = join(distRoot, `aivs-worker${extension}`);
if (!existsSync(built) || statSync(built).size <= 1_000_000) {
  throw new Error(`PyInstaller 未生成有效 Worker：${built}`);
}
copyFileSync(built, destination);
if (!windowsTarget) chmodSync(destination, 0o755);
console.log(`[worker] ${built} -> ${destination}`);
