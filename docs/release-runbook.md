# AI Video Studio 完整发布操作手册

本文用于每次正式发布 `AI Video Studio（影匠）`，覆盖以下工作：

1. 升级客户端版本。
2. 更新生产环境的管理后台和 API。
3. 构建并签名 Windows 客户端。
4. 发布客户端安装包和在线升级包。
5. 验证新安装、在线升级和服务端功能。

生产环境信息：

- GitHub 仓库：`programmingdog/ai-studio`
- 发布分支：`main`
- 生产站点：`https://ai-studio.yuntianxing.net`
- API 内网端口：`127.0.0.1:3101`
- 管理后台内网端口：`127.0.0.1:3200`
- 服务器部署目录：`/opt/aivs`
- Windows 客户端架构：`x86_64`
- 客户端更新渠道：`stable`

> 必须遵守：先更新后台和 API，确认生产环境健康，再发布客户端在线升级。这样可以避免新客户端调用尚未上线的接口。

---

## 一、只需准备一次的发布环境

已经完成首次部署时，可以直接从“二、每次发布的完整流程”开始。

### 1. Windows 构建机

构建机需要安装：

- Node.js 20 或更高版本，建议与 CI 一致使用 Node.js 24。
- npm。
- Rust MSVC toolchain。
- Python 及项目 Worker 所需依赖。
- Windows C++ 构建工具。

在项目根目录安装依赖：

```powershell
Set-Location C:\code\AIVideoStudio
npm.cmd ci --no-audit --no-fund
```

检查工具链：

```powershell
node --version
npm --version
rustc --version
cargo --version
python --version
```

### 2. Tauri Updater 签名密钥

客户端在线升级包必须使用固定的 Tauri Updater 私钥签名。私钥只保存在安全构建机或 CI 密钥存储中，禁止提交到 Git、上传到业务服务器或粘贴到管理后台。

客户端中只保存对应的公钥：

```text
apps/desktop/.env.production
```

生产构建时需要提供：

- `TAURI_SIGNING_PRIVATE_KEY`：原有签名私钥文件路径或私钥内容。
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`：签名私钥密码。
- `AIVS_UPDATER_PUBLIC_KEY`：与私钥配对的公钥，当前由 `.env.production` 加载。

不要为普通发版重新生成密钥。直接更换签名私钥会导致已安装的旧客户端无法验证新版更新包。

### 3. GitHub 和服务器部署环境

GitHub `production` 环境需要配置：

- `DEPLOY_HOST`
- `DEPLOY_PORT`
- `DEPLOY_USER`
- `DEPLOY_SSH_KEY`
- `DEPLOY_KNOWN_HOSTS`

服务器需要提前具备：

- Docker。
- Docker Compose `2.30.0` 或更高版本。
- `/opt/aivs/shared/api.env`。
- `/opt/aivs/shared/backup.cnf`。
- 可执行的 `/opt/aivs/shared/backup.sh`。
- `aivs-deploy` 用户的 GHCR 只读登录凭据。
- 宝塔 Nginx 对 `3101` 和 `3200` 的反向代理。

首次部署的详细配置见 [`docs/deployment.md`](deployment.md)。

### 4. 安装包存储

生产服务器使用独立的 `/client` 静态目录保存客户端产物：

```text
/var/www/aivs-public/client/{版本号}/
```

该目录用于保存：

- 给新用户下载的 `.exe` 安装包。
- 给旧客户端在线升级的 `.nsis.zip` 更新包。

每个版本使用独立且不可变的子目录，例如：

```text
https://ai-studio.yuntianxing.net/client/0.2.0/yingjiang-0.2.0-x64-setup.exe
https://ai-studio.yuntianxing.net/client/0.2.0/yingjiang-0.2.0-x64-setup.nsis.zip
```

Nginx 直接提供 `/client/` 下的静态文件，现有 `/download` 仍作为公开下载页面使用。发布后禁止覆盖同一 URL 下的文件；修复问题时必须提升版本号并使用新路径。

首次使用时，在服务器以 `root` 创建目录：

```bash
install -d -o aivs-deploy -g aivs-deploy -m 755 \
  /var/www/aivs-public/client
```

然后把 [`deploy/nginx.conf.example`](../deploy/nginx.conf.example) 中的 `/client/` 静态文件规则加入宝塔站点的 HTTPS `server {}`，执行 Nginx 配置检查并重载：

```bash
/www/server/nginx/sbin/nginx -t
/www/server/nginx/sbin/nginx -s reload
```

---

## 二、每次发布的完整流程

按以下顺序执行。任一步失败时停止发布，修复后再继续。

### 自动化入口（推荐）

仓库已提供本地自动发布助手 [`tools/release.ps1`](../tools/release.ps1)，可以自动完成本章的版本升级、检查、提交推送、后台/API 部署、客户端签名构建、上传、后台发布和最终验证。

首次运行：

```powershell
Set-Location C:\code\AIVideoStudio
powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File tools/release.ps1 -Stage Initialize
```

填写生成的 `tools/release.config.json` 后，先执行只读演练：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools/release.ps1 `
  -Stage All -Version 0.2.1 -DryRun
```

完整发布：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools/release.ps1 `
  -Stage All `
  -Version 0.2.1 `
  -ReleaseNotesFile docs/release-notes/0.2.1.md `
  -CommitAllChanges
```

默认配置会自动发布到 `stable` 的 10% 灰度。观察稳定后放量到 100%：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools/release.ps1 `
  -Stage Promote `
  -Version 0.2.1 `
  -RolloutPercent 100
```

脚本使用 `release/automation/{版本号}/state.json` 保存断点状态，失败后可从具体阶段继续。参数、凭据和断点续跑说明见 [`tools/README-release.md`](../tools/README-release.md)。以下手工步骤作为流程解释和自动化失败时的后备操作保留。

### 第 1 步：确定新版本号和发布内容

客户端版本使用 SemVer：

```text
主版本.次版本.修订版本
例如：0.2.0、0.2.1、0.3.0
```

推荐规则：

- 仅修复问题：修订版本加一，例如 `0.2.0 → 0.2.1`。
- 增加向后兼容功能：次版本加一，例如 `0.2.1 → 0.3.0`。
- 存在破坏性变化：主版本加一。

新版本必须严格大于已经发布的最高版本。同一个版本号不能重复发布。

准备本次更新说明，至少记录：

- 新增功能。
- 修复的问题。
- 是否包含数据库迁移。
- 是否需要强制升级。
- 计划使用的初始灰度比例。

### 第 2 步：同步修改客户端的三个版本号

必须同时修改：

```text
apps/desktop/package.json
apps/desktop/src-tauri/Cargo.toml
apps/desktop/src-tauri/tauri.conf.json
```

例如发布 `0.2.1`：

```json
// apps/desktop/package.json
"version": "0.2.1"
```

```toml
# apps/desktop/src-tauri/Cargo.toml
version = "0.2.1"
```

```json
// apps/desktop/src-tauri/tauri.conf.json
"version": "0.2.1"
```

检查三个版本号：

```powershell
Set-Location C:\code\AIVideoStudio

(Get-Content apps/desktop/package.json -Raw | ConvertFrom-Json).version
(Get-Content apps/desktop/src-tauri/tauri.conf.json -Raw | ConvertFrom-Json).version
Select-String apps/desktop/src-tauri/Cargo.toml -Pattern '^version\s*=' | Select-Object -First 1
```

三个输出必须一致。

### 第 3 步：检查生产配置和敏感文件

确认生产 API 地址：

```powershell
Get-Content apps/desktop/.env.production
```

应包含：

```dotenv
VITE_PLATFORM_API_URL=https://ai-studio.yuntianxing.net/api/v1
```

确认服务端和后台的本地密钥文件会被 Git 忽略：

```powershell
git check-ignore apps/server/.env
git check-ignore apps/admin-web/.env.local
```

两条命令必须分别输出对应文件路径。

检查改动：

```powershell
git status --short
git diff --check
git diff --stat
```

禁止提交：

- Tauri Updater 签名私钥。
- 数据库密码、JWT 密钥和供应商密钥。
- SSH 私钥、证书私钥、GHCR Token。
- 数据库备份。
- `node_modules`、本地构建缓存和临时目录。

`apps/desktop/.env.production` 可以提交，但其中只能包含生产 API 地址和 Updater 公钥，不能包含私钥或密码。

### 第 4 步：执行本地发布前检查

安装锁定版本的依赖：

```powershell
npm.cmd ci --no-audit --no-fund
```

运行类型检查：

```powershell
npm.cmd run typecheck
```

构建后台和 API：

```powershell
npm.cmd run build:platform
```

可选运行 Python 测试：

```powershell
npm.cmd run test:python
```

GitHub Actions 还会使用临时 MySQL 执行数据库迁移、全量 Node 测试、Docker 镜像构建和容器健康检查。本地检查通过不代表可以跳过 CI。

### 第 5 步：提交并推送代码

再次查看所有文件，确认它们都属于本次发布：

```powershell
git status --short
git diff --stat
```

暂存并检查：

```powershell
git add -A
git diff --cached --check
git diff --cached --stat
git status --short
```

提交并推送：

```powershell
git commit -m "Release platform and desktop v0.2.1"
git push origin main
```

将示例中的 `0.2.1` 替换为实际版本。

记录本次源代码提交号：

```powershell
git rev-parse HEAD
```

后续客户端安装包、后台和 API 应来自这一个提交。

### 第 6 步：部署管理后台和 API

推送 `main` 会自动触发 `Platform CI and deployment`，但默认只测试和发布镜像，不一定自动部署生产服务器。

在 GitHub 中操作：

1. 打开 `https://github.com/programmingdog/ai-studio/actions`。
2. 选择 `Platform CI and deployment`。
3. 点击 `Run workflow`。
4. Branch 选择 `main`。
5. 勾选 `Deploy to the configured production server after tests`。
6. 点击运行。
7. 等待 `verify → publish → deploy` 全部通过。
8. 如果 `production` 环境要求人工审批，检查提交号后批准。

也可以使用 GitHub CLI：

```powershell
gh workflow run platform.yml --ref main -f deploy=true
gh run watch
```

自动部署会执行：

```text
检查和测试代码
→ 构建后台/API Docker 镜像
→ 推送不可变镜像到 GHCR
→ SSH 连接生产服务器
→ 拉取新镜像
→ 停止旧服务
→ 备份生产数据库
→ 执行数据库迁移
→ 补全缺失的邀请码
→ 启动新服务并等待健康检查
```

生产服务器使用现有数据库。普通发布不要手动执行：

```text
seed-default-configs
bootstrap-admin
```

### 第 7 步：验证后台和 API

部署完成后 SSH 登录服务器，以 `aivs-deploy` 用户执行：

```bash
readlink -f /opt/aivs/current

cd /opt/aivs/current
docker compose --env-file release.env ps
docker compose --env-file release.env logs --tail=100 api admin

curl --fail http://127.0.0.1:3101/api/v1/health
curl --fail http://127.0.0.1:3200/ >/dev/null

ss -lntp | grep -E ':(3101|3200)\b'
```

必须满足：

- `api` 和 `admin` 均为 `healthy`。
- `3101` 和 `3200` 仅监听 `127.0.0.1`。
- 不能监听 `0.0.0.0` 或 `[::]`。
- 数据库迁移日志没有错误。

浏览器打开：

```text
https://ai-studio.yuntianxing.net/
```

检查：

- 管理员能够登录。
- 用户、余额和分销数据仍然存在。
- 管理后台能读取配置。
- 邀请页和下载页能打开。
- 本次新增或修改的后台/API 功能正常。

只有服务端验收通过后，才能发布客户端。

### 第 8 步：加载签名密钥

在安全 Windows 构建机上打开新的 PowerShell：

```powershell
Set-Location C:\code\AIVideoStudio

$env:TAURI_SIGNING_PRIVATE_KEY = "C:\secure\yingjiang-updater.key"
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = Read-Host "请输入签名私钥密码" -MaskInput
```

将私钥路径替换为构建机上的真实安全路径。

执行构建前检查：

```powershell
.\build-windows-installer.bat --check
```

此检查会验证：

- Node.js、Rust、Cargo 和 Python 是否可用。
- 项目依赖是否存在。
- 生产 API 是否为非本机 HTTPS 地址。
- 签名环境变量是否已设置。
- 三个客户端版本号是否一致。

### 第 9 步：构建并签名 Windows 客户端

执行：

```powershell
.\build-windows-installer.bat --no-pause
```

输出目录：

```text
C:\code\AIVideoStudio\apps\desktop\src-tauri\target\release\bundle\nsis
```

查看产物：

```powershell
$bundleDirectory = "C:\code\AIVideoStudio\apps\desktop\src-tauri\target\release\bundle\nsis"
Get-ChildItem -LiteralPath $bundleDirectory |
  Select-Object Name, Length, LastWriteTime
```

应生成：

- `*.exe`：新用户首次安装使用。
- `*.nsis.zip`：已安装客户端在线升级使用。
- 与 `.nsis.zip` 对应的 `.sig`：Updater 签名。

计算并保存 SHA-256：

```powershell
Get-FileHash "$bundleDirectory\*" -Algorithm SHA256
```

确认产物文件名中的版本号是本次新版本，而不是上一次构建留下的旧版本。

构建完成后立即从当前终端删除私钥变量：

```powershell
Remove-Item Env:\TAURI_SIGNING_PRIVATE_KEY
Remove-Item Env:\TAURI_SIGNING_PRIVATE_KEY_PASSWORD
```

### 第 10 步：上传客户端产物

将以下文件上传到本次版本的独立 HTTPS 目录：

- `.exe` 安装包。
- `.nsis.zip` 在线升级包。
- 可选上传 `.sig` 文件用于归档；管理后台实际需要粘贴其内容。

例如：

```text
https://ai-studio.yuntianxing.net/client/0.2.1/yingjiang-0.2.1-x64-setup.exe
https://ai-studio.yuntianxing.net/client/0.2.1/yingjiang-0.2.1-x64-setup.nsis.zip
```

使用部署账号上传时，先创建不可重复的版本目录，再上传文件：

```powershell
$version = "0.2.1"
$server = "替换为服务器IP或部署域名"
$port = 22
$keyPath = "$env:USERPROFILE\.ssh\aivs_github_deploy"
$uploadDirectory = "替换为本次整理好的客户端产物目录"

ssh -i $keyPath -p $port "aivs-deploy@$server" `
  "test ! -e /var/www/aivs-public/client/$version && mkdir -m 755 /var/www/aivs-public/client/$version"

scp -i $keyPath -P $port `
  "$uploadDirectory\*" `
  "aivs-deploy@${server}:/var/www/aivs-public/client/$version/"

ssh -i $keyPath -p $port "aivs-deploy@$server" `
  "chmod 644 /var/www/aivs-public/client/$version/*"
```

`test ! -e` 会阻止覆盖已经存在的版本目录。上传失败时确认该版本是否已经发布；不得为了重传而直接覆盖线上文件。

上传后检查链接：

```powershell
Invoke-WebRequest -Method Head "替换为EXE的HTTPS地址"
Invoke-WebRequest -Method Head "替换为NSIS-ZIP的HTTPS地址"
```

要求：

- 返回成功状态。
- 文件大小与本地产物一致。
- URL 不需要登录、Cookie 或临时授权参数。
- URL 不会在短时间内过期。
- CDN 不会自动解压或修改 `.nsis.zip`。

### 第 11 步：更新公开安装包地址

进入生产管理后台：

```text
设定 → 安装包配置
```

操作：

1. 填写本次 `.exe` 安装包的完整 HTTPS 地址。
2. 开启“Windows 下载”。
3. 保存安装包配置。
4. 打开公开下载页面。
5. 实际下载一次，确认下载的是本次版本。

这里必须填写 `.exe`，不能填写 `.nsis.zip`。

### 第 12 步：创建客户端在线升级版本

进入生产管理后台：

```text
设定 → 客户端版本管理 → 新建版本
```

填写：

| 字段 | 内容 |
| --- | --- |
| 版本号 | 本次客户端版本，例如 `0.2.1` |
| 渠道 | `stable` |
| 更新说明 | 本次功能和修复内容 |
| 灰度比例 | 首次建议 `5` 或 `10` |
| 最低可运行版本 | 普通可选更新填写 `0.0.0` |
| 更新平台 | `Windows x64` |
| HTTPS 更新包地址 | `.nsis.zip` 的地址，不是 `.exe` |
| Updater 签名 | `.sig` 文件的完整内容 |

读取签名内容：

```powershell
Get-Content -Raw "$bundleDirectory\*.sig"
```

先点击“保存草稿”，不要立即全量发布。

注意：

- 当前生产客户端固定检查 `stable` 渠道。
- 使用 `stable` 加小灰度测试，不要把普通生产客户端临时切换到 `beta`。
- 普通更新的最低可运行版本保持 `0.0.0`。
- 只有安全漏洞、接口完全不兼容或数据迁移强制要求时才设置强制升级门槛。

### 第 13 步：验证在线升级并逐步放量

准备一台已经安装旧版本的测试电脑。

先将草稿以较小灰度发布，然后验证：

1. 启动旧版本客户端。
2. 客户端能够发现新版本。
3. 版本号和更新说明正确。
4. 更新包下载进度正常。
5. 签名验证成功。
6. 安装过程正常。
7. 客户端能够重启并显示新版本号。
8. 用户登录状态和本地项目数据没有丢失。
9. 新版本能够正常调用生产 API。
10. 本次新增的客户端功能正常。

如果测试账号没有命中灰度桶，可临时使用多个测试客户端，或者在确认风险可控后逐步提高灰度比例。

建议放量节奏：

```text
5% 或 10% → 观察 → 25% → 观察 → 50% → 观察 → 100%
```

每次提高灰度后关注：

- API 错误率和容器日志。
- 登录、注册和支付问题。
- 更新下载失败或签名失败反馈。
- 客户端启动失败和数据兼容问题。

验证稳定后，将灰度比例调整到 `100%`。

---

## 三、发布完成检查清单

完成后逐项打勾：

- [ ] 新版本号严格大于线上版本。
- [ ] 三个客户端版本号完全一致。
- [ ] 生产 API 地址和 Updater 公钥正确。
- [ ] 没有提交密码、Token 或私钥。
- [ ] `npm.cmd run typecheck` 通过。
- [ ] `npm.cmd run build:platform` 通过。
- [ ] 代码已提交并推送到 `main`。
- [ ] GitHub Actions 的 `verify`、`publish`、`deploy` 全部通过。
- [ ] 生产 API 和后台容器均为 `healthy`。
- [ ] 管理后台和本次 API 功能验收通过。
- [ ] Windows `.exe` 安装包构建成功。
- [ ] `.nsis.zip` 和 `.sig` 生成成功。
- [ ] 安装包及更新包 SHA-256 已记录。
- [ ] `.exe` 和 `.nsis.zip` 的 HTTPS 地址可公开访问。
- [ ] 下载页面已更新为新版 `.exe`。
- [ ] 客户端版本草稿填写的是 `.nsis.zip` 地址。
- [ ] 管理后台中的签名与本次 `.sig` 一致。
- [ ] 旧版本在线升级测试通过。
- [ ] 灰度已经逐步提高到 `100%`。
- [ ] 签名私钥环境变量已经清除。

---

## 四、出现问题时的处理

### 1. GitHub Actions 验证失败

不要部署，也不要发布客户端。查看失败步骤，修复代码后重新提交并运行完整工作流。

### 2. 后台或 API 部署失败

服务器部署脚本会保留发布目录和迁移日志。检查：

```bash
cd /opt/aivs/current
docker compose --env-file release.env ps
docker compose --env-file release.env logs --tail=200 api admin

ls -la /opt/aivs/releases
find /opt/aivs/releases -maxdepth 2 -name migration.log -print
```

数据库迁移可能已经部分提交时，不要直接恢复旧数据库或随意重跑 SQL。先检查迁移日志和数据库状态。

代码回滚仅在确认新旧代码与当前数据库结构兼容时执行：

```bash
bash /opt/aivs/releases/目标旧版本/deploy.sh \
  --rollback 目标旧版本 --schema-compatible
```

该命令只回滚代码，不回滚数据库和密钥。

### 3. 客户端构建失败

先执行：

```powershell
.\build-windows-installer.bat --check
```

常见原因：

- 三个版本号不一致。
- 未加载签名私钥或密码。
- 公钥与私钥不匹配。
- Rust、Python 或 Node.js 不可用。
- Worker 或媒体二进制准备失败。
- 生产 API 地址不是 HTTPS。

失败的安装包和签名不能上传或发布。

### 4. 在线升级签名失败

立即停止该版本的分发，不要修改已经发布版本的文件或 URL。

检查：

- `.sig` 是否来自同一次构建。
- 后台是否粘贴了完整签名内容。
- `.nsis.zip` 上传后是否被修改。
- 构建使用的私钥是否与客户端内置公钥配对。
- 管理后台是否错误填写成 `.exe` 地址。

修复后提升版本号，重新构建、签名并发布新版本。

### 5. 客户端发布后发现严重问题

在管理后台对问题版本执行“停止分发/归档”，阻止尚未升级的客户端继续收到该版本。

不要覆盖旧包。完成修复后：

1. 提升版本号。
2. 重新提交并部署后台/API（如有变化）。
3. 使用原签名私钥重新打包。
4. 上传到新版本目录。
5. 创建新的客户端版本并重新灰度发布。

---

## 五、相关文件

- 完整服务器首次部署说明：[`docs/deployment.md`](deployment.md)
- 客户端在线升级设计说明：[`docs/desktop-updates.md`](desktop-updates.md)
- Windows 构建入口：[`build-windows-installer.bat`](../build-windows-installer.bat)
- GitHub Actions 工作流：[`platform.yml`](../.github/workflows/platform.yml)
- Docker Compose：[`deploy/compose.yml`](../deploy/compose.yml)
- 服务器部署脚本：[`deploy/deploy.sh`](../deploy/deploy.sh)
- Nginx 配置示例：[`deploy/nginx.conf.example`](../deploy/nginx.conf.example)
