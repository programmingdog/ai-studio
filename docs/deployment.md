# 管理后台和服务端：一步一步部署

本文已经按你的环境填写：

- GitHub：`programmingdog/ai-studio`
- 服务器：CentOS 7 + 宝塔
- 数据库：服务器现有的 `ai_studio`，不创建 MySQL 容器
- 域名：`ai-studio.yuntianxing.net`

整体流程：

```text
本地推送代码 → GitHub 自动测试和构建镜像
→ 你手动批准 → GitHub 通过 SSH 通知服务器
→ 服务器拉取镜像、备份现有数据库、升级表结构并启动
```

服务器不执行 `git pull`，也不编译源码。真实密码只放服务器，绝不能提交 GitHub。

## 部署清单

- [ ] 1. 升级 Docker Compose
- [ ] 2. 推送本地项目到 GitHub
- [ ] 3. 创建服务器部署账号和目录
- [ ] 4. 配置 GitHub 专用 SSH 密钥
- [ ] 5. 上传并填写 API 配置
- [ ] 6. 配置并验证数据库备份
- [ ] 7. 让服务器登录 GHCR
- [ ] 8. 填写 GitHub production Secrets
- [ ] 9. 等待第一次 CI 构建通过
- [ ] 10. 手动触发第一次部署
- [ ] 11. 配置宝塔 Nginx
- [ ] 12. 验收

任何一步失败都先停止，不要跳过。

## 第 1 步：升级 Docker Compose

在服务器执行：

```bash
docker version
docker compose version --short
```

要求：

- Docker Engine 24.0.7 可以先用。
- Docker Compose 必须不低于 `2.30.0`。

你原来的 Compose 2.21.0 不符合要求。升级后例如显示：

```text
2.30.3
```

CentOS 7 已停止维护。本次可以临时部署，后续应迁移到 Rocky Linux 9、AlmaLinux 9 或其他受支持系统。

## 第 2 步：推送项目到 GitHub

在 Windows 开发电脑的 PowerShell 执行：

```powershell
Set-Location C:\code\AIVideoStudio

git init
git branch -M main
```

看到 `Initialized empty Git repository` 后，再检查敏感环境文件是否会被忽略：

```powershell
git check-ignore apps/server/.env
git check-ignore apps/admin-web/.env.local
```

两条命令必须分别输出对应文件路径；否则先停止，不能提交代码。

然后连接你的 GitHub 仓库：

```powershell
git remote add origin https://github.com/programmingdog/ai-studio.git
```

如果提示 `origin already exists`：

```powershell
git remote set-url origin https://github.com/programmingdog/ai-studio.git
```

暂存并检查：

```powershell
git add .
git status --short
```

确认列表中没有：

- `apps/server/.env`、`apps/admin-web/.env.local`
- 数据库备份、真实密码、证书和私钥
- `node_modules`、`.codex-tmp`、`binaries`、`release`

第一次使用 Git 时，为当前仓库设置提交身份。邮箱应从 GitHub 的 `Settings → Emails` 复制已验证邮箱或 GitHub 提供的隐私邮箱，不要照抄示例地址：

```powershell
git config user.name "programmingdog"
git config user.email "替换为GitHub中已验证的邮箱或隐私邮箱"

git config --get user.name
git config --get user.email
```

这里不使用 `--global`，因此只影响当前项目。确认输出正确后提交：

```powershell
git commit -m "Add platform deployment pipeline"
git push -u origin main
```

如果新仓库自带 README 导致 push 被拒绝：

```powershell
git pull --rebase origin main
git push -u origin main
```

不要使用 `git push --force`。推送后确认 GitHub 中存在：

```text
.github/workflows/platform.yml
deploy/Dockerfile
deploy/compose.yml
deploy/deploy.sh
```

## 第 3 步：创建部署账号和目录

在服务器使用 root 执行：

```bash
id aivs-deploy >/dev/null 2>&1 || \
  useradd --create-home --shell /bin/bash aivs-deploy

usermod -aG docker aivs-deploy

install -d -o aivs-deploy -g aivs-deploy -m 700 \
  /opt/aivs /opt/aivs/shared /opt/aivs/releases \
  /opt/aivs/incoming /opt/aivs/backups
```

检查：

```bash
id aivs-deploy
ls -ld /opt/aivs /opt/aivs/shared
```

`id` 输出必须包含 `docker` 组。

## 第 4 步：配置 GitHub 专用 SSH 密钥

在 Windows PowerShell 生成密钥：

```powershell
$sshDirectory = Join-Path $env:USERPROFILE ".ssh"
$keyPath = Join-Path $sshDirectory "aivs_github_deploy"
$publicKeyPath = "${keyPath}.pub"

New-Item -ItemType Directory -Force -Path $sshDirectory | Out-Null
ssh-keygen -t ed25519 -f $keyPath -C "github-actions-ai-studio"
```

出现 `Enter passphrase` 和确认提示时都直接按 Enter，生成无口令的专用自动部署密钥。如果提示目标文件已经存在，先停止并确认它是不是之前需要保留的密钥，不要直接覆盖。

将 `服务器地址` 和 `SSH端口` 替换为真实值，上传公钥：

```powershell
scp -P SSH端口 `
  $publicKeyPath `
  root@服务器地址:/tmp/aivs_github_deploy.pub
```

服务器使用 root 执行：

```bash
install -d -o aivs-deploy -g aivs-deploy -m 700 \
  /home/aivs-deploy/.ssh
touch /home/aivs-deploy/.ssh/authorized_keys

grep -qxF "$(cat /tmp/aivs_github_deploy.pub)" \
  /home/aivs-deploy/.ssh/authorized_keys || \
  cat /tmp/aivs_github_deploy.pub >> \
  /home/aivs-deploy/.ssh/authorized_keys

chown aivs-deploy:aivs-deploy \
  /home/aivs-deploy/.ssh/authorized_keys
chmod 600 /home/aivs-deploy/.ssh/authorized_keys
rm -f /tmp/aivs_github_deploy.pub
```

回到 Windows 测试：

```powershell
ssh -i $keyPath `
  -p SSH端口 aivs-deploy@服务器地址
```

登录后执行：

```bash
docker version
docker compose version
exit
```

## 第 5 步：上传并填写 API 配置

Windows 项目目录执行：

```powershell
scp -P SSH端口 `
  deploy/api.env.example `
  deploy/backup.cnf.example `
  deploy/backup.sh `
  aivs-deploy@服务器地址:/opt/aivs/shared/
```

登录服务器，执行：

```bash
cd /opt/aivs/shared
cp api.env.example api.env
cp backup.cnf.example backup.cnf
chmod 600 api.env backup.cnf
chmod 700 backup.sh
vi api.env
```

如果文件是通过宝塔文件管理器上传或编辑，所有者可能变成 `www:www`。这会导致部署账号无法读取密钥。上传和编辑完成后，在 root 终端执行：

```bash
chown aivs-deploy:aivs-deploy \
  /opt/aivs/shared/api.env \
  /opt/aivs/shared/backup.cnf \
  /opt/aivs/shared/backup.sh

chmod 600 /opt/aivs/shared/api.env
chmod 600 /opt/aivs/shared/backup.cnf
chmod 700 /opt/aivs/shared/backup.sh
```

再以 `aivs-deploy` 登录检查，不需要 sudo：

```bash
test -r /opt/aivs/shared/api.env && echo "api.env readable"
test -r /opt/aivs/shared/backup.cnf && echo "backup.cnf readable"
test -x /opt/aivs/shared/backup.sh && echo "backup.sh executable"
```

填写：

```dotenv
DB_HOST=127.0.0.1
DB_PORT=3306
DB_NAME=ai_studio
DB_USER=ai_studio
DB_PASSWORD=已经更换的新数据库密码
DB_CONNECTION_LIMIT=10

JWT_SECRET=至少32字符的随机密钥
JWT_EXPIRES_IN=8h
CREDENTIAL_ENCRYPTION_KEY=现有系统使用的原始加密密钥

ADMIN_ORIGIN=https://ai-studio.yuntianxing.net
CLIENT_ORIGINS=tauri://localhost,http://tauri.localhost,https://tauri.localhost
MAIL_API_TIMEOUT_MS=30000
```

生成 JWT 密钥：

```bash
openssl rand -hex 32
```

重要：

- 之前公开过的数据库密码必须先在宝塔更换。
- `CREDENTIAL_ENCRYPTION_KEY` 必须保留原值，否则已有加密配置可能无法解密。
- 值不要加外层引号，不要执行 `source api.env`。
- `api.env` 不能上传 GitHub。

用应用账号测试现有数据库连接，密码在提示符中输入：

```bash
mysql --protocol=TCP -h 127.0.0.1 -P 3306 \
  -u ai_studio -p -D ai_studio \
  -e 'SELECT DATABASE(), VERSION();'
```

连接失败时先在宝塔检查 `ai_studio` 用户允许的主机和新密码，不能继续部署。

## 第 6 步：配置并测试数据库备份

在宝塔创建 MySQL 备份用户：

```text
用户名：aivs_backup
允许主机：127.0.0.1
数据库：ai_studio
权限：SELECT、SHOW VIEW、TRIGGER
```

也可以在 MySQL 管理终端执行：

```sql
CREATE USER 'aivs_backup'@'127.0.0.1'
IDENTIFIED BY '替换成独立强密码';
GRANT SELECT, SHOW VIEW, TRIGGER ON ai_studio.*
TO 'aivs_backup'@'127.0.0.1';
FLUSH PRIVILEGES;
```

服务器编辑：

```bash
vi /opt/aivs/shared/backup.cnf
```

填写：

```ini
[client]
host=127.0.0.1
port=3306
user=aivs_backup
password="备份账号的独立密码"
protocol=tcp
```

测试：

```bash
mysql --defaults-extra-file=/opt/aivs/shared/backup.cnf \
  -D ai_studio \
  -e 'SELECT DATABASE(), COUNT(*) FROM schema_migrations;'

/opt/aivs/shared/backup.sh
ls -lh /opt/aivs/backups/
```

必须同时看到 `.sql.gz` 和对应的 `.sql.gz.complete`。没有 `.complete` 就不能继续。

## 第 7 步：让服务器登录 GHCR

Classic PAT（Personal Access Token Classic）是 GitHub 生成的一串访问令牌。这里把它当作服务器登录 GHCR 的专用只读密码，只允许拉取 Docker 镜像，不能用来上传或删除镜像。GitHub Packages 当前要求使用 Classic PAT。

按以下步骤创建：

1. 登录 `programmingdog` 账号，打开 <https://github.com/settings/tokens>。
2. 点击 `Generate new token`。
3. 选择 `Generate new token (classic)`，不是 Fine-grained token。
4. `Note` 填写 `ai-studio-server-ghcr-read`。
5. `Expiration` 建议先选 90 天，并设置到期提醒；令牌到期后需要重新创建和登录。
6. 在权限列表中只勾选 `read:packages`（Download packages from GitHub Package Registry）。
7. 不勾选 `write:packages`、`delete:packages`、`admin:*`。如果 GitHub 自动附加了不需要的宽泛权限，取消后再次确认只保留读取镜像所需权限。
8. 点击页面底部 `Generate token`。
9. 立即复制以 `ghp_` 开头的令牌并放进密码管理器；离开页面后 GitHub 不会再次显示完整令牌。

不要把令牌粘贴到聊天、代码、`api.env` 或 GitHub 仓库。它只用于服务器上 `aivs-deploy` 用户的 Docker 登录。

服务器使用 `aivs-deploy` 执行：

```bash
read -r -s -p 'GHCR Token: ' GHCR_PAT
```

此时命令会停在 `GHCR Token:` 后面等待输入。现在才粘贴以 `ghp_` 开头的令牌并按 Enter；输入不会显示在屏幕上。**不要把令牌写在上述命令的末尾**，`GHCR_PAT` 是固定的变量名。

确认变量确实接收到内容（只显示长度，不显示令牌）：

```bash
if [[ -n "${GHCR_PAT:-}" ]]; then
  echo "Token captured, length: ${#GHCR_PAT}"
else
  echo "Token is empty; repeat the read command"
fi

printf '\n'
printf '%s' "$GHCR_PAT" | \
  docker login ghcr.io -u programmingdog --password-stdin
unset GHCR_PAT
```

必须显示：

```text
Login Succeeded
```

不要将 PAT 写进命令参数、脚本或仓库。登录信息会保存在该用户的 `~/.docker/config.json`；限制权限：

```bash
chmod 700 ~/.docker
chmod 600 ~/.docker/config.json
```

令牌到期或被撤销后，部署会在拉镜像阶段失败，但不会修改数据库。创建新令牌后重新执行本步骤即可。

## 第 8 步：配置 GitHub production Secrets

打开：

```text
https://github.com/programmingdog/ai-studio/settings/environments
```

创建 `production` 环境，建议只允许 main 分支并设置人工审批。

在该环境添加：

| Secret | 内容 |
| --- | --- |
| `DEPLOY_HOST` | GitHub Actions 的 SSH 目标；优先填固定公网 IPv4，不带协议和端口。也可填未经过 CDN/代理且直接解析到该服务器的域名 |
| `DEPLOY_PORT` | SSH 端口，如 `22` |
| `DEPLOY_USER` | `aivs-deploy` |
| `DEPLOY_SSH_KEY` | `aivs_github_deploy` 私钥完整内容 |
| `DEPLOY_KNOWN_HOSTS` | 核验过的服务器 SSH 主机记录 |

Windows 读取私钥：

```powershell
$keyPath = Join-Path (Join-Path $env:USERPROFILE ".ssh") "aivs_github_deploy"
Get-Content $keyPath -Raw
```

将包括 `BEGIN/END OPENSSH PRIVATE KEY` 在内的完整内容放入 `DEPLOY_SSH_KEY`。

生成 known_hosts 候选：

```powershell
ssh-keyscan -p SSH端口 服务器地址
```

先在服务器查看真实指纹：

```bash
ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
```

再在 Windows 核对扫描结果：

```powershell
ssh-keyscan -p SSH端口 服务器地址 2>$null |
  ssh-keygen -lf -
```

指纹一致后，才把 `ssh-keyscan` 的完整输出行放进 `DEPLOY_KNOWN_HOSTS`。

`DEPLOY_HOST`、测试 SSH 命令和 `DEPLOY_KNOWN_HOSTS` 必须使用同一个名称。例如 `DEPLOY_HOST` 填 IP，就用该 IP 执行 `ssh-keyscan`；填 `ai-studio.yuntianxing.net`，就用该域名扫描。若域名经过 Cloudflare/CDN 代理，不能用于 SSH，请改用服务器固定公网 IP 或单独的 DNS-only 部署域名。`DEPLOY_HOST` 中不要填写 `https://`、路径或 `:端口`，端口只放 `DEPLOY_PORT`。

最后进入：

```text
Settings → Actions → General → Workflow permissions
```

允许工作流按配置写入 GitHub Packages。不要把数据库、JWT 或加密密钥放到 GitHub Secrets。

## 第 9 步：等待第一次 CI 构建通过

打开：

```text
https://github.com/programmingdog/ai-studio/actions
```

选择 `Platform CI and deployment`。push main 后会自动：

1. 类型检查和生产构建。
2. 在临时 MySQL 中测试所有 SQL 迁移。
3. 运行测试。
4. 构建并启动 API、后台镜像做健康检查。
5. 将同一份已测试镜像发布到 GHCR。

默认不会部署服务器。`verify` 和 `publish` 必须全部绿色。镜像名称为：

```text
ghcr.io/programmingdog/ai-studio-api
ghcr.io/programmingdog/ai-studio-admin
```

## 第 10 步：手动触发第一次部署

在 Actions 中：

1. 打开 `Platform CI and deployment`。
2. 点击 `Run workflow`。
3. Branch 选择 `main`。
4. 勾选 `Deploy to the configured production server after tests`。
5. 运行并等待测试、构建完成。
6. 如果 production 要求审批，点击批准。

GitHub 随后会：

```text
上传本次 compose.yml 和 deploy.sh
→ 拉取固定摘要镜像
→ 停止旧 API/后台
→ 备份现有 ai_studio
→ 更新现有数据库表结构
→ 补全缺少的邀请码
→ 启动并健康检查
```

这里不会创建 MySQL 容器，也不会搬迁数据库。已经执行过的 SQL 迁移会显示 `skip`。

因为你使用现有数据库，不要手动执行：

```text
seed-default-configs
bootstrap-admin
```

部署成功后在服务器检查：

```bash
readlink -f /opt/aivs/current
cd /opt/aivs/current
docker compose --env-file release.env ps
```

`api` 和 `admin` 都应显示 `healthy`。

## 第 11 步：配置宝塔 Nginx

Windows 上传模板：

```powershell
scp -P SSH端口 deploy/nginx.conf.example `
  root@服务器地址:/tmp/aivs-nginx.conf.example
```

在宝塔中：

1. 为 `ai-studio.yuntianxing.net` 创建站点。
2. 申请 HTTPS 证书并强制跳转 HTTPS。
3. 保留宝塔的证书和 ACME 配置。
4. 将模板内容放入该 HTTPS `server {}`。
5. 删除冲突的旧 `location /` 或旧反向代理规则。
6. 测试配置后再重载。

```bash
/www/server/nginx/sbin/nginx -t
/www/server/nginx/sbin/nginx -s reload
```

代理关系：

```text
/api/v1/* → 127.0.0.1:3101
其他页面  → 127.0.0.1:3200
```

3101、3200、3306 不应向公网开放。

## 第 12 步：验收

服务器检查：

```bash
cd /opt/aivs/current
docker compose --env-file release.env ps
docker compose --env-file release.env logs --tail=100 api admin
curl --fail http://127.0.0.1:3101/api/v1/health
curl --fail http://127.0.0.1:3200/ >/dev/null
ss -lntp | grep -E ':(3101|3200)\b'
```

3101 和 3200 必须监听在 `127.0.0.1`，不能是 `0.0.0.0` 或 `[::]`。

浏览器打开：

```text
https://ai-studio.yuntianxing.net/
```

逐项验证：

- 管理员登录。
- 用户余额、上级、直接和间接下级。
- 邮箱登录/注册判断、图形验证码、邮件验证码。
- 微信扫码登录弹窗。
- 邀请页面和下载链接。
- 后台邮件和分销配置仍然存在。

邀请页基础地址应填写：

```text
https://ai-studio.yuntianxing.net/invite
```

## 以后如何更新

以后每次发布只需：

```text
本地提交并 push main
→ 等 verify 和 publish 全绿
→ 手动 Run workflow 并勾选 deploy
→ 批准 production
→ 验收
```

第一次部署不要创建 `ENABLE_AUTODEPLOY`。稳定多次后如需自动部署，再设置仓库变量：

```text
ENABLE_AUTODEPLOY=true
```

## 出错时

查看容器和日志：

```bash
cd /opt/aivs/current
docker compose --env-file release.env ps
docker compose --env-file release.env logs --tail=200 api admin
cat migration.log
ls -lh /opt/aivs/backups/
```

| 错误 | 处理 |
| --- | --- |
| CI 红色 | 不部署，先修复 CI |
| GHCR 拉取失败 | 检查 `docker login ghcr.io` 和 Package 权限 |
| SSH 失败 | 检查 5 个 production Secrets 和防火墙 |
| 备份失败 | 修复 backup.cnf，不能跳过备份 |
| 迁移失败 | 服务会保持停止；查看 migration.log，不要删除 schema_migrations |
| 新镜像不健康 | 先确认数据库结构，不要直接启动旧代码 |

MySQL 的部分 `ALTER TABLE` 会隐式提交，迁移失败不代表表结构一定自动恢复。

只有确认旧代码仍兼容当前数据库结构后，才能回滚到以前成功的发布：

```bash
bash /opt/aivs/current/deploy.sh \
  --rollback '以前成功的release名称' \
  --schema-compatible
```

代码回滚不会恢复数据库，不会撤销订单、分润或付款。

## 验证范围

本地已通过类型检查、生产构建、应用测试、YAML 和 Bash 语法检查。当前 Windows 开发电脑没有 Docker，第一次 push 后仍必须等待 GitHub Actions 在 Linux、临时 MySQL 和 Docker 中完成全部验证，再批准生产部署。
