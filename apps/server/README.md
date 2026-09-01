# AI Video Studio Server

NestJS 模块化单体，所有业务模块共享同一身份、权限、MySQL 事务和审计上下文。

交互式 APIDOC：`http://localhost:3101/api-docs`  
OpenAPI JSON：`http://localhost:3101/api-docs/openapi.json`

## 当前模块

- 管理员登录、RBAC、首次登录强制改密
- 运营概览、用户/任务/支付元数据查询
- 提示词、画风、创意类型和自动化流程的版本化配置、发布与客户端读取
- AI 供应商目录和 Adapter 类型配置
- 使用数据库加密 API Key 执行模型创建/查询测试，并保存脱敏测试记录
- MySQL 5.7 兼容迁移、默认配置初始化和超级管理员引导
- 用户邮箱/手机密码注册登录、微信开放平台扫码登录、可轮换会话和资料维护
- 积分套餐购买、微信 Native 支付回调验签/解密、幂等发放与双分录账本
- AI 任务创建/查询中转、积分预占/结算，以及供应商 API Key 的服务端隔离

服务端禁止保存任务媒体和媒体 Base64。管理员模型测试会保存脱敏后的 JSON/文本响应用于排障，但不会下载或保存响应中的媒体文件。JSON 请求体上限为 2 MB。

## 运行

复制 `.env.example` 的字段到安全的运行时密钥配置中，不要提交真实 `.env`：

```powershell
npm.cmd run db:inspect
npm.cmd run db:migrate
npm.cmd run db:seed-config
npm.cmd run db:bootstrap-admin
npm.cmd run db:sync-wagaai-models
npm.cmd run db:sync-allaiin-models
npm.cmd run dev:server
```

迁移按文件名排序，并把 SHA-256 写入 `schema_migrations`。已执行的迁移如果被修改，运行器会拒绝继续。

`db:sync-wagaai-models` 从数据库读取并解密 WagaAI 的启用 API Key，拉取实时模型、参数、计费摘要与余额。脚本不会从 `.env` 读取供应商 API Key，也不会覆盖后台人工调整过的模型启停状态和积分消耗值。

`db:sync-allaiin-models` 使用相同的数据库加密密钥流程同步 AllAIIn 的模型目录、积分价格和账户余额，也会保留后台人工调整的模型启停状态与积分消耗值。

## 已开放接口

- `GET /api/v1/health`
- `POST /api/v1/admin/auth/login`
- `GET /api/v1/admin/auth/me`
- `POST /api/v1/admin/auth/change-password`
- `GET /api/v1/admin/dashboard/overview`
- `GET|POST /api/v1/admin/configs`
- `GET|PATCH /api/v1/admin/configs/mail`（需要 `configs.manage` 权限）
- `POST /api/v1/admin/configs/:id/versions`
- `POST /api/v1/admin/configs/:id/versions/:versionId/publish`
- `GET|POST /api/v1/admin/providers`
- `PATCH /api/v1/admin/providers/:id`
- `GET|POST /api/v1/admin/providers/:id/credentials`
- `PATCH /api/v1/admin/providers/:id/credentials/:credentialId`
- `GET|POST /api/v1/admin/providers/:id/models`
- `PATCH /api/v1/admin/providers/:id/models/:modelId`
- `POST /api/v1/admin/providers/:id/models/:modelId/tests`
- `GET /api/v1/admin/model-tests`
- `POST /api/v1/admin/model-tests/:testId/query`
- `GET /api/v1/admin/users|tasks|payments|audit-logs`
- `GET /api/v1/client-config/bootstrap`
- `GET /api/v1/client-config/releases/current`
- `GET /api/v1/client-config/models`
- `GET /api/v1/client-config/prompts?channel=stable`
- `POST /api/v1/auth/register/email`
- `POST /api/v1/auth/register/email/captcha`
- `POST /api/v1/auth/register/email/captcha/verify`
- `POST /api/v1/auth/register/email/code`
- `POST /api/v1/auth/register/phone`
- `POST /api/v1/auth/login|refresh|logout`
- `POST /api/v1/auth/wechat/qr-sessions`
- `GET /api/v1/auth/wechat/callback`
- `GET /api/v1/auth/wechat/qr-sessions/status`
- `GET|PATCH /api/v1/users/me`
- `GET /api/v1/credits/packages|balance`
- `POST /api/v1/credits/purchases`（请求必须带唯一的 `idempotency_key`）
- `GET /api/v1/credits/purchases/:purchaseId`
- `POST /api/v1/payments/wechat/notify`
- `POST|GET /api/v1/tasks`
- `GET /api/v1/tasks/:taskId`
- `POST /api/v1/tasks/:taskId/query`

除注册、登录、套餐和客户端模型目录等公开接口外，用户接口使用 `Authorization: Bearer <access_token>`。创建任务必须传 `provider_model_id`、非空 `payload` 和唯一的 `idempotency_key`；视频生成还必须在 `payload` 或 `payload.params` 中传 `seconds`/`duration`，按秒预占并结算积分。

客户端模型目录不返回供应商地址、接口路径、协议配置或 API Key。客户端只把参数和远程媒体 URL 交给任务接口；服务端转发响应但不持久化提示词、媒体文件或完整模型结果。

微信 Native 支付启用前，需要在管理后台同时配置公众号 AppID、商户号、32 字节 APIv3 Key、商户证书/私钥、微信支付平台证书及 HTTPS 支付回调地址。PC 扫码登录另需微信开放平台“网站应用”的 AppID、AppSecret 与 HTTPS 回调地址。

## 邮箱注册验证码

先运行 `npm run db:migrate` 应用 `018_email_registration_verification.sql`、`019_mail_service_config.sql` 和 `020_mail_smtp_transport.sql`，再部署新版 API 与管理后台。020 增加 SMTP 配置字段，保留现有 HTTP 方式、密码和启停状态，不会自动切换或发出邮件。此变更要求更新客户端；旧客户端不传 `email_code` 将无法邮箱注册。手机注册、微信登录和已有账户密码登录不受影响。此功能只验证邮箱注册，不改变已有的资料修改/手机号注册流程。

在管理后台 **设定 → 邮箱配置** 选择 HTTP API 或 SMTP，填写发件邮箱（`MAIL_API_FROM`）、发件邮箱密码（`MAIL_API_PASSWORD`），选择“启用”后保存。配置统一从 MySQL 的 `mail_service_configs` 读取，**不再读取或回退到同名环境变量**；部署旧配置时，请在后台重新填写。保存后后续请求立即生效，不需重启。运行环境仅保留可选 `MAIL_API_TIMEOUT_MS`（默认 30000，上限 60000）：HTTP 请求整体超时，SMTP 分别用于 DNS、连接、问候和 socket 空闲超时，不是 SMTP 全流程总时限。初始配置停用且不包含发件凭据；未配置或停用时返回 503，不会跳过验证码。

- **SMTP（宝塔邮局直连）**：预填主机 `mail.yuntianxing.net`、端口 `25`、加密 `STARTTLS`，认证账号使用完整发件邮箱。先确认邮局开启 SMTP 认证、STARTTLS 且域名证书可信，并确保 API 服务器可出站连接 25 端口。若邮局另开 465，可选择 `SSL/TLS`；587 通常使用 STARTTLS。不要填 POP 110 或 IMAP 143，它们用于收信。不支持关闭证书验证或降级明文认证。
- **HTTP API**：支持 HTTP 和 HTTPS，填写宝塔面板完整地址（对应 `MAIL_API_URL`），包含实际面板端口，例如 `http://211.154.25.178:15686/mail_sys/send_mail_http.json`。HTTP 会明文传输发件邮箱密码、收件地址和验证码内容；入库加密不等于传输加密，请确认网络可信。历史默认值 `https://yuntianxing.net/mail_sys/send_mail_http.json` 只是初始值，并不保证该地址已提供接口。SMTP 主机/端口不能作为 HTTP 发件接口地址。协议或地址修改仍须重新输入密码，不自动升级协议或跟随重定向。

发件密码使用 `CREDENTIAL_ENCRYPTION_KEY` 加密入库，管理接口仅返回 `password_configured`，不会返回密码、密文或密码片段。密码留空保留现有值；修改发件方式、当前方式的服务器地址/端口/加密方式或发件邮箱时必须重新输入密码，防止把原有凭据转发到新地址。仅更新所选方式的服务器配置，未选方式的地址保留。保存需要 `configs.manage` 权限，并在同一事务中写入脱敏审计记录。每次保存携带 `revision`，遇到并发修改返回 409，应重新读取后再编辑。

后台接口 `GET /api/v1/admin/configs/mail` 返回 `api_url/delivery_method/smtp_host/smtp_port/smtp_security/mail_from/password_configured/status/revision/updated_at`。SMTP 的 `PATCH` 示例：`{ "delivery_method": "SMTP", "smtp_host": "mail.yuntianxing.net", "smtp_port": 25, "smtp_security": "STARTTLS", "mail_from": "no-reply@yuntianxing.net", "password": "发件邮箱密码", "status": "ACTIVE", "revision": 0 }`（revision 使用实际读取值）。HTTP 使用 `delivery_method: "HTTP"` 和 `api_url`；省略发件方式及服务器字段时保留数据库现值。接口不会自动发送测试邮件。

HTTP 适配器按根目录 `docs/mail-api/发件接口使用文档.docx` 和 `demo.py`，以 `application/x-www-form-urlencoded` POST 发送 `mail_from/password/mail_to/subject/content/subtype=plain`。旧版成功响应要求 `status === true`；新版包装响应还要求 `code === 0` 且 `data.status === true`，不能把外层请求成功误当成发件成功。禁止跳转、设置请求超时。SMTP 使用 Nodemailer 强制 STARTTLS 或隐式 TLS，仅向一个指定收件人发送纯文本验证码，服务接受收件人及邮件后才激活验证码。两种方式均不自动重试或互相回退，不向客户端返回上游原始错误、密码或验证码内容。SMTP 接受不等于最终投递到收件箱；如仍未收信，需检查邮局队列、退信、垃圾箱及域名邮件认证配置。

HTTP 发生超时、5xx、连接重置、跳转、无效 JSON 或未知响应格式时，发件结果是 `UNCERTAIN`，而不是明确失败：接口返回 503、`code: MAIL_HTTP_DELIVERY_UNCONFIRMED`、`expires_in: 600`、`retry_after_seconds: 60` 和安全 `diagnostic_id`。服务端不自动重发，保存本次验证码的 HMAC 摘要；只有真正收到该不可预测验证码的用户，才能在 10 分钟内按邮箱绑定、最多 5 次、一次性消费等原规则注册。明确的 HTTP 4xx（408 除外）、`status: false`、非零数值 `code` 或 `data.status: false` 才标记 `FAILED` 并清除摘要。每次请求记录脱敏诊断事件（结果、固定原因、HTTP 状态、耗时及响应结构），不记录 URL、邮箱、密码、验证码、原始错误或响应正文。

发件错误返回安全分类码：`MAIL_HTTP_REJECTED`、`MAIL_HTTP_DELIVERY_UNCONFIRMED`、`MAIL_SMTP_CONNECTION_FAILED`、`MAIL_SMTP_AUTH_FAILED`、`MAIL_SMTP_TLS_FAILED`、`MAIL_SMTP_REJECTED` 或 `MAIL_SMTP_FAILED`。分别检查 HTTP 面板响应/脱敏诊断日志、SMTP 网络/端口、账号密码、STARTTLS/证书、发件权限及邮局日志。失败或结果未确认后原图形凭证已消费，重试须重新进行图形验证。此修复无需数据库迁移；应同时更新 API 与客户端。此前已被清除摘要的验证码和诊断邮件中的测试码不会被恢复为有效验证码。

客户端调用顺序（全部为 JSON POST）：

1. `/api/v1/auth/register/email/captcha`：`{ "email": "name@example.com" }`，返回 `captcha_id`、`image_data_url`、`expires_in: 300`。图片中的 5 位字符不区分大小写。
2. `/api/v1/auth/register/email/captcha/verify`：`{ "email": "name@example.com", "captcha_id": "...", "answer": "ABCDE" }`，返回 120 秒有效的 `captcha_token`。凭证绑定邮箱及请求 IP，只能发件一次。
3. `/api/v1/auth/register/email/code`：`{ "email": "name@example.com", "captcha_token": "..." }`。明确成功返回 `sent: true`、`expires_in: 600` 和 `retry_after_seconds: 60`；结果未确认返回上述 503 结构，二者都不返回邮箱验证码。每次重发都必须重新完成图形验证。
4. `/api/v1/auth/register/email`：`{ "email": "name@example.com", "password": "your-password-with-digits", "email_code": "123456", "display_name": "昵称（选填）" }`。注册成功返回原有登录令牌和用户资料；验证码消费与账户创建处于同一个数据库事务。

服务端保存验证码的 HMAC 摘要，不保存原文。图形码及邮箱码最多各尝试 5 次；邮箱码 10 分钟过期，新发送请求会使旧码失效，发送中/失败的码不可注册。限制为：每 IP 图形码 10 次/分钟、图形校验 30 次/分钟、发件请求 10 次/小时、注册校验 30 次/分钟；每邮箱发件 5 次/小时且间隔至少 60 秒；全局发件 200 次/小时。返回 429 时 JSON `retry_after_seconds` 表示应等待的秒数。失败的发件仍计入频控，需重新进行图形验证；服务端后台按索引分批清理过期记录。

验证码（包含发件结果未确认的验证码）和频控均在 MySQL 中共享，多实例必须使用相同的数据库与 `CREDENTIAL_ENCRYPTION_KEY`；轮换该密钥后旧码失效。若 API 置于反向代理后，请按实际代理填写 `TRUST_PROXY` IP/CIDR 白名单（本机 Nginx 可用 `loopback`），代理应覆盖来自外部的 `X-Forwarded-For`。默认不信任该请求头，避免客户端伪造 IP 绕过限流。不要信任所有来源；公网部署还应在网关限制匿名请求体大小和请求速率。

测试：`npm run test:registration --workspace @aivs/server`、`npm run test:mail-config --workspace @aivs/admin-web` 和 `npm run test:registration --workspace @aivs/desktop`。测试模拟邮件响应及事务状态，并通过本地 SMTP 握手验证 STARTTLS 不可用时拒绝明文认证及问候超时；不连接正式邮件服务，不实际发送邮件。
