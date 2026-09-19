import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const repositoryRoot = resolve(desktopRoot, "../..");
const tauriRoot = join(desktopRoot, "src-tauri");
const binariesRoot = join(tauriRoot, "binaries");
const developmentMode = process.argv.includes("--dev");
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

const ffmpegLicenseDestination = join(binariesRoot, "FFMPEG_LICENSE.txt");
const ffmpegBuildReadmeDestination = join(binariesRoot, "FFMPEG_BUILD_README.txt");
const ffmpegOnPath = pathCommand(`ffmpeg${extension}`);
const ffmpegInstallRoot = ffmpegOnPath ? resolve(dirname(ffmpegOnPath), "..") : "";
const ffmpegLicenseSource = [
  distributionDir ? join(distributionDir, "LICENSE") : "",
  distributionDir ? join(distributionDir, "LICENSE.txt") : "",
  join(tauriRoot, "vendor", "ffmpeg", targetTriple, "LICENSE"),
  join(tauriRoot, "vendor", "ffmpeg", targetTriple, "LICENSE.txt"),
  ffmpegInstallRoot ? join(ffmpegInstallRoot, "LICENSE") : "",
  ffmpegInstallRoot ? join(ffmpegInstallRoot, "LICENSE.txt") : "",
].filter(Boolean).find((candidate) =>
  existsSync(candidate) && statSync(candidate).isFile() && statSync(candidate).size > 1_000
);
if (!existsSync(ffmpegLicenseDestination) || statSync(ffmpegLicenseDestination).size <= 1_000) {
  if (!ffmpegLicenseSource) {
    throw new Error([
      `缺少 ${targetTriple} FFmpeg 发行包的 LICENSE 文件。`,
      `请将许可证放入 src-tauri/vendor/ffmpeg/${targetTriple}/，`,
      `或通过 AIVS_FFMPEG_DIST_DIR 指向包含 FFmpeg、FFprobe 和 LICENSE 的目录。`,
    ].join("\n"));
  }
  copyFileSync(ffmpegLicenseSource, ffmpegLicenseDestination);
  console.log(`[media] ${ffmpegLicenseSource} -> ${ffmpegLicenseDestination}`);
}
writeFileSync(ffmpegBuildReadmeDestination, [
  "Bundled FFmpeg utilities",
  `Target: ${targetTriple}`,
  `Executables: ffmpeg${extension}, ffprobe${extension}`,
  "Project: https://ffmpeg.org/",
  "License: see FFMPEG_LICENSE.txt in this application resource directory.",
  "Build configuration and version: run the bundled ffmpeg executable with -version.",
  "",
].join("\n"));

const ytDlpDistributionDir = process.env.AIVS_YTDLP_DIST_DIR ? resolve(process.env.AIVS_YTDLP_DIST_DIR) : "";
const ytDlpFilename = `yt-dlp${extension}`;
const ytDlpDestination = join(binariesRoot, `yt-dlp-${targetTriple}${extension}`);
const validYtDlp = (path) => {
  if (!existsSync(path) || !statSync(path).isFile()) return false;
  if (!developmentMode) return statSync(path).size > 1_000_000;
  try {
    execFileSync(path, ["--version"], { stdio: "ignore", timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
};
if (validYtDlp(ytDlpDestination)) {
  if (!windowsTarget) chmodSync(ytDlpDestination, 0o755);
  console.log(`[media] ${basename(ytDlpDestination)} 已就绪`);
} else {
  const candidates = [
    ytDlpDistributionDir ? join(ytDlpDistributionDir, ytDlpFilename) : "",
    join(tauriRoot, "vendor", "yt-dlp", targetTriple, ytDlpFilename),
    join(repositoryRoot, "binaries", "yt-dlp", ytDlpFilename),
    pathCommand(ytDlpFilename),
  ].filter(Boolean);
  const source = candidates.find(validYtDlp);
  if (!source) {
    throw new Error([
      developmentMode
        ? `缺少 ${targetTriple} 对应的可执行 ${ytDlpFilename}，无法启动调试客户端。`
        : `缺少 ${targetTriple} 对应的独立版 ${ytDlpFilename}，无法构建完整安装包。`,
      `请将目标平台的 yt-dlp 放入 src-tauri/vendor/yt-dlp/${targetTriple}/，`,
      `或通过 AIVS_YTDLP_DIST_DIR 指向包含该程序的目录${developmentMode ? "；调试模式也会自动查找 PATH。" : "。"}`,
    ].join("\n"));
  }
  copyFileSync(source, ytDlpDestination);
  if (!windowsTarget) chmodSync(ytDlpDestination, 0o755);
  console.log(`[media] ${source} -> ${ytDlpDestination}`);
}
