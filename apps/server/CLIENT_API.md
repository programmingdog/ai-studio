# 客户端 API v1

基础地址：`http://localhost:3101/api/v1`。受保护接口统一携带：

```http
Authorization: Bearer <access_token>
Content-Type: application/json
```

访问令牌有效期 2 小时，刷新令牌有效期 30 天。刷新与退出都会立即撤销旧会话。

## 注册与登录

- `POST /auth/register/email`：`{ "email", "password", "display_name?" }`
- `POST /auth/register/phone`：`{ "phone", "password", "display_name?" }`
- `POST /auth/login`：`{ "identifier", "password", "device_name?" }`
- `POST /auth/refresh`：`{ "refresh_token", "device_name?" }`
- `POST /auth/logout`：需要登录

密码必须为 8～128 个字符，且同时包含字母与数字。注册和登录成功返回 `access_token`、`refresh_token`、`expires_in` 与用户资料。

微信扫码流程：

1. `POST /auth/wechat/qr-sessions` 获取 `login_url`、`state` 和过期时间。
2. 客户端展示 `login_url` 对应二维码，并轮询 `GET /auth/wechat/qr-sessions/status?state=...`。
3. 微信回调 `GET /auth/wechat/callback?code=...&state=...` 完成创建或绑定用户。
4. 状态成为 `COMPLETED` 时，轮询响应只发放一次登录令牌。

## 用户资料

- `GET /users/me`
- `PATCH /users/me`

可修改 `display_name`、`avatar_url`、`bio`、`email`、`phone` 和 `new_password`。修改登录凭据时必须传 `current_password`；头像仅接受 HTTPS URL。

## 积分与购买

- `GET /credits/packages`：公开读取启用套餐。
- `GET /credits/balance`：返回 `balance`、`held`、`available`。
- `GET /credits/purchases`：读取当前用户最近 100 条积分购买记录。
- `GET /credits/consumptions`：读取当前用户最近 100 条积分消耗记录。
- `POST /credits/purchases`：`{ "package_id", "idempotency_key" }`，返回 Native 支付 `code_url`。
- `GET /credits/purchases/:purchaseId`：轮询支付状态。
- `POST /payments/wechat/notify`：微信支付通知地址，不供客户端直接调用。

同一用户重复提交相同 `idempotency_key` 会返回原订单；若换成其他套餐则返回冲突。支付回调完成平台签名验证、AES-GCM 解密、商户/AppID/金额/币种校验后，在一个数据库事务中幂等发放积分。

## 模型目录与任务转发

- `GET /client-config/models`：公开读取客户端可选模型、能力、参数规则及积分价格。
- `GET /client-config/prompts?channel=stable`：公开读取服务端当前发布的客户端默认提示词；客户端本地手动覆盖优先。
- `POST /tasks`：创建模型任务。
- `POST /tasks/video-understanding/url`：把公网 HTTPS 视频 URL 交给后台默认视频理解模型。
- `POST /tasks/video-understanding/upload`：以 `multipart/form-data` 上传客户端压缩后的视频（字段名 `video`，最大 15MB），交给后台默认视频理解模型。
- `GET /tasks`：最近 100 条任务元数据。
- `GET /tasks/:taskId`：读取单条任务元数据。
- `POST /tasks/:taskId/query`：向供应商查询异步任务，并返回供应商响应。

创建任务示例：

```json
{
  "local_task_id": "可选的客户端 UUID",
  "idempotency_key": "客户端生成且单次业务唯一",
  "provider_model_id": "从 /client-config/models 获取",
  "payload": {
    "prompt": "任务提示词",
    "reference_images": ["https://example.com/reference.png"],
    "seconds": 10
  }
}
```

服务端按模型配置选择供应商和数据库中的启用 API Key，客户端传入的 `model`/`model_id` 会被忽略。非视频模型按次预占积分，视频生成按请求的 `seconds`/`duration` 乘以每秒积分；成功后结算，创建失败或供应商明确失败时释放预占。

Gemini 视频理解既接受原生 `contents`，也接受简化字段 `video_uri`、`mime_type`、`media_resolution` 和 `prompt`。默认提示会同时分析视频画面、人物对话台词、关键事件与音频信息。

桌面客户端的链接视频流程调用 `/tasks/video-understanding/url`，只传解析所得公网 URL，不再下载视频；本地视频流程先使用 FFmpeg 压缩为不超过 14MB 的 MP4，再调用 `/tasks/video-understanding/upload`。两个专用接口都会自动选择后台“AI 默认大模型配置”中的默认视频理解模型，并要求该模型、供应商和至少一个 API Key 均处于启用状态。

任务表只保存任务 ID、状态、用量和积分等元数据。请求提示词、媒体、供应商完整响应和生成结果不会写入服务器数据库；创建与查询接口会把当次 `provider_response` 原样转回客户端（超大文本响应会截断到安全上限）。
