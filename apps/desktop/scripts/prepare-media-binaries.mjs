import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const repositoryRoot = resolve(desktopRoot, "../..");
const tauriRoot = join(desktopRoot, "src-tauri");
const binariesRoot = join(tauriRoot, "binaries");
const targetTriple = process.env.AIVS_TARGET_TRIPLE || execFileSync("rustc", ["--print", "host-tuple"], { encoding: "utf8" }).trim();
const windowsTarget = targetTriple.includes("windows");
const macTarget = targetTriple.includes("apple-darwin");
if (!windowsTarget && !macTarget) throw new Error(`当前仅配置 Windows 和 macOS 媒体工具：${targetTriple}`);

const extension = windowsTarget ? ".exe" : "";
const distributionDir = process.env.AIVS_FFMPEG_DIST_DIR ? resolve(process.env.AIVS_FFMPEG_DIST_DIR) : "";
mkdirSync(binariesRoot, { recursive: true });

function pathCommand(tool) {
  try {
    const command = windowsTarget ? "where.exe" : "which";
    const output = execFileSync(command, [tool], { encoding: "utf8" }).trim().split(/\r?\n/)[0];
    return output || "";
  } catch {
    return "";
  }
}

for (const tool of ["ffmpeg", "ffprobe"]) {
  const filename = `${tool}${extension}`;
  const destination = join(binariesRoot, `${tool}-${targetTriple}${extension}`);
  if (existsSync(destination) && statSync(destination).size > 1_000_000) {
    if (!windowsTarget) chmodSync(destination, 0o755);
    console.log(`[media] ${basename(destination)} 已就绪`);
    continue;
  }
  const candidates = [
    distributionDir ? join(distributionDir, filename) : "",
    join(tauriRoot, "vendor", "ffmpeg", targetTriple, filename),
    pathCommand(filename),
  ].filter(Boolean);
  const source = candidates.find((candidate) =>
    existsSync(candidate) && statSync(candidate).isFile() && statSync(candidate).size > 1_000_000
  );
  if (!source) {
    throw new Error([
      `缺少 ${targetTriple} 对应的 ${filename}，无法构建完整安装包。`,
      `请将目标平台的 FFmpeg 与 FFprobe 放入 src-tauri/vendor/ffmpeg/${targetTriple}/，`,
      `或通过 AIVS_FFMPEG_DIST_DIR 指向包含这两个程序的目录。`,
      `macOS 需要在对应 Intel/Apple Silicon 构建机上准备可执行文件。`,
    ].join("\n"));
  }
  copyFileSync(source, destination);
  if (!windowsTarget) chmodSync(destination, 0o755);
  console.log(`[media] ${source} -> ${destination}`);
}

const ytDlpDistributionDir = process.env.AIVS_YTDLP_DIST_DIR ? resolve(process.env.AIVS_YTDLP_DIST_DIR) : "";
const ytDlpFilename = `yt-dlp${extension}`;
const ytDlpDestination = join(binariesRoot, `yt-dlp-${targetTriple}${extension}`);
if (existsSync(ytDlpDestination) && statSync(ytDlpDestination).size > 1_000_000) {
  if (!windowsTarget) chmodSync(ytDlpDestination, 0o755);
  console.log(`[media] ${basename(ytDlpDestination)} 已就绪`);
} else {
  const candidates = [
    ytDlpDistributionDir ? join(ytDlpDistributionDir, ytDlpFilename) : "",
    join(tauriRoot, "vendor", "yt-dlp", targetTriple, ytDlpFilename),
    join(repositoryRoot, "binaries", "yt-dlp", ytDlpFilename),
    pathCommand(ytDlpFilename),
  ].filter(Boolean);
  const source = candidates.find((candidate) =>
    existsSync(candidate) && statSync(candidate).isFile() && statSync(candidate).size > 1_000_000
  );
  if (!source) {
    throw new Error([
      `缺少 ${targetTriple} 对应的 ${ytDlpFilename}，无法构建完整安装包。`,
      `请将目标平台的 yt-dlp 放入 src-tauri/vendor/yt-dlp/${targetTriple}/，`,
      `或通过 AIVS_YTDLP_DIST_DIR 指向包含该程序的目录。`,
    ].join("\n"));
  }
  copyFileSync(source, ytDlpDestination);
  if (!windowsTarget) chmodSync(ytDlpDestination, 0o755);
  console.log(`[media] ${source} -> ${ytDlpDestination}`);
}
