# 桌面客户端在线升级

客户端使用 Tauri 2 官方 Updater。更新包必须经构建机私钥签名，客户端只内置公钥并校验签名；API 和管理后台都不保存签名私钥。

## 首次准备

1. 在安全环境生成一对 Tauri Updater 签名密钥，例如在 `apps/desktop` 下运行：

   ```powershell
   npm exec tauri signer generate -- -w C:\secure\yingjiang-updater.key
   ```

2. 将私钥文件放入 CI 密钥存储或专用构建机，禁止提交到 Git、网盘或服务器应用目录。
3. 为生产构建提供以下环境变量：

   - `TAURI_SIGNING_PRIVATE_KEY`：私钥内容或私钥文件路径。
   - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`：私钥密码。
   - `AIVS_UPDATER_PUBLIC_KEY`：与私钥对应的公钥完整内容。它会在 Rust 编译时写入客户端。

4. 数据库执行 `npm run db:migrate`，创建 `desktop_releases` 和 `desktop_release_artifacts`。

## 每次发版

1. 同步修改以下三个版本号，必须使用 SemVer，且新版本严格大于线上版本：

   - `apps/desktop/package.json`
   - `apps/desktop/src-tauri/Cargo.toml`
   - `apps/desktop/src-tauri/tauri.conf.json`

2. 使用安全构建环境生成安装包：

   ```powershell
   .\build-windows-installer.bat --no-pause
   ```

3. 将 `bundle/nsis` 下生成的 `.exe` 和同名 `.exe.sig` 上传到只读 HTTPS/CDN 地址。当前 Tauri 版本直接使用已签名的 `.exe` 作为安装包和在线升级包。
4. 在管理后台“设定 → 版本管理”新建草稿：填写版本号、更新说明、灰度比例、更新包 HTTPS 地址，并粘贴 `.exe.sig` 文件完整内容。发布后仍可使用“编辑更新说明”修订文案，客户端下次检查该版本时直接读取后台最新内容。
5. 先在 beta 渠道或小灰度验证，再发布 stable。当前客户端固定检查 stable 渠道；若需要 beta 客户端，应使用独立构建配置，不要让生产用户临时切换渠道。
6. 验证启动检查、下载进度、签名校验、安装重启和旧版本强制升级后，再逐步把灰度比例提高到 100%。

## 发布规则

- 草稿可编辑、可删除；发布后版本号、渠道、兼容门槛、更新包与签名保持锁定，但更新说明可单独修订并记录审计日志。二进制或签名需要修复时必须发布更高版本，避免同一版本安装内容被替换。
- `最低可运行版本` 默认为 `0.0.0`，表示可稍后升级。仅安全漏洞、协议不兼容或数据迁移要求时提高该值；低于门槛的客户端会阻塞使用直到升级成功。
- 灰度分桶使用客户端持久化的随机 ID，同一客户端对同一版本的分桶结果稳定。强制更新版本建议直接使用 100%。
- 更新服务不可用时，可选更新静默跳过并在下次启动重试；已经收到强制更新清单的客户端不会绕过升级。
- CDN 应启用 HTTPS、版本化不可变路径和合理缓存；更新清单 API 使用 `no-store`，更新包可长期缓存。
- 私钥轮换需要过渡版本：先用旧私钥签一个内置新公钥的过渡版本，确认存量客户端完成升级后，再用新私钥签后续版本。不能直接切换，否则旧客户端无法校验更新。
