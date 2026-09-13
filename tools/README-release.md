# 本地自动发布助手

入口：`tools/release.ps1`。完整发布说明仍以 [`docs/release-runbook.md`](../docs/release-runbook.md) 为准。

## 仅发布 Windows 客户端（一键运行）

先确认 `tools/release.config.json` 中的服务器、SSH 私钥、管理后台邮箱和 Updater 签名私钥路径正确；这些配置仅需设置一次。首次在本机保存管理后台密码：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools/release.ps1 -Stage SaveAdminCredential
```

密码由当前 Windows 用户的 DPAPI 加密保存在 Git 忽略的 `tools/release.admin-credential`。以后双击仓库根目录的 [`publish-client.bat`](../publish-client.bat)，只需输入目标版本号和 Updater 签名私钥密码（构建密钥）。脚本按当前工作区代码构建、签名、上传、发布到 stable 渠道并设为 100% 灰度，不提交或推送 Git，也不触发 API/管理后台部署。

同版本重新运行会生成新的内容哈希 URL，替换该已发布版本的 Windows 更新包和公开下载地址。新版本号必须高于线上已发布的最高版本。已安装相同版本号的客户端不会收到在线升级提示；需要给它们推送修复时，应使用更高版本号。同版本替换依赖最新的 API `PATCH /admin/desktop-releases/:id/artifact`，首次使用前需先部署包含该接口的 API。

## 首次配置

```powershell
Set-Location C:\code\AIVideoStudio
powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File tools/release.ps1 -Stage Initialize
```

编辑生成的 `tools/release.config.json`，填写：

- `server_host`
- `server_port`
- `admin_email`
- `ssh_key_path`
- `signing_private_key_path`

配置文件不保存密码、Token 或签名私钥内容，并已被 `.gitignore` 忽略。

GitHub Token 建议使用 Fine-grained PAT，仅授权 `programmingdog/ai-studio`，提供 Actions 读写权限和必要的仓库只读权限。

## 完整自动发布

交互模式直接运行发布命令即可。需要使用秘密时，脚本会以隐藏输入方式依次询问 GitHub Token、生产管理员密码和 Updater 签名密码；不会把它们写入配置或发布状态。

也可以直接双击 [`tools/start-release.bat`](start-release.bat)，输入新版本号后按提示执行。命令行方式适合传入更新说明文件和无人值守参数。

如果由受保护的自动化环境以 `-NonInteractive` 运行，则需要由该环境注入：

```powershell
$env:AIVS_GITHUB_TOKEN = "由安全凭据存储注入"
$env:AIVS_ADMIN_PASSWORD = "由安全凭据存储注入"
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = "由安全凭据存储注入"
```

不要把真实值写进 PowerShell 脚本、命令历史或 `release.config.json`。

如果当前工作区包含本次全部待发布代码：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools/release.ps1 `
  -Stage All `
  -Version 0.2.1 `
  -ReleaseNotesFile docs/release-notes/0.2.1.md `
  -CommitAllChanges
```

未提供 `-CommitAllChanges` 时，脚本发现已有改动会要求人工确认；在 `-NonInteractive` 模式下会直接停止。

先检查计划但不执行写操作：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools/release.ps1 `
  -Stage All -Version 0.2.1 -DryRun
```

发布完成后清除会话秘密：

```powershell
Remove-Item Env:\AIVS_GITHUB_TOKEN -ErrorAction SilentlyContinue
Remove-Item Env:\AIVS_ADMIN_PASSWORD -ErrorAction SilentlyContinue
Remove-Item Env:\TAURI_SIGNING_PRIVATE_KEY_PASSWORD -ErrorAction SilentlyContinue
```

## 断点续跑

每个版本的执行状态位于 `release/automation/{版本}/state.json`。修复问题后可从失败阶段继续：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools/release.ps1 -Stage DeployPlatform -Version 0.2.1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools/release.ps1 -Stage BuildClient -Version 0.2.1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools/release.ps1 -Stage UploadClient -Version 0.2.1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools/release.ps1 -Stage PublishClient -Version 0.2.1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools/release.ps1 -Stage Verify -Version 0.2.1
```

小灰度观察完成后放量到 100%：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools/release.ps1 `
  -Stage Promote -Version 0.2.1 -RolloutPercent 100
```

## 环境变量

| 名称 | 用途 |
| --- | --- |
| `AIVS_GITHUB_TOKEN` | 触发并查询 GitHub Actions |
| `AIVS_ADMIN_PASSWORD` | 更新下载配置和在线升级版本 |
| `TAURI_SIGNING_PRIVATE_KEY` | 可选；覆盖配置中的签名私钥路径 |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Tauri Updater 签名密码 |

未设置秘密环境变量时，交互模式会安全提示输入。`-NonInteractive` 模式不会提示，缺少变量时直接失败。
