import { OpenAPIObject } from "@nestjs/swagger";

type JsonSchema = Record<string, unknown>;
type Parameter = Record<string, unknown>;

const ref = (name: string): JsonSchema => ({ $ref: `#/components/schemas/${name}` });
const arrayOf = (item: JsonSchema): JsonSchema => ({ type: "array", items: item });
const pathId = (name: string, description: string): Parameter => ({
  name,
  in: "path",
  required: true,
  description,
  schema: { type: "string", format: "uuid" },
});
const query = (name: string, description: string, schema: JsonSchema = { type: "string" }, required = false): Parameter => ({
  name,
  in: "query",
  required,
  description,
  schema,
});

function operation(input: {
  id: string;
  tag: string;
  summary: string;
  description?: string;
  security?: boolean;
  body?: JsonSchema;
  bodyContentType?: string;
  parameters?: Parameter[];
  success?: JsonSchema;
  successDescription?: string;
}): Record<string, unknown> {
  return {
    operationId: input.id,
    tags: [input.tag],
    summary: input.summary,
    ...(input.description ? { description: input.description } : {}),
    ...(input.security ? { security: [{ bearerAuth: [] }] } : {}),
    ...(input.parameters?.length ? { parameters: input.parameters } : {}),
    ...(input.body ? {
      requestBody: {
        required: true,
        content: { [input.bodyContentType || "application/json"]: { schema: input.body } },
      },
    } : {}),
    responses: {
      "200": {
        description: input.successDescription || "请求成功",
        content: { "application/json": { schema: input.success || { type: "object", additionalProperties: true } } },
      },
      "400": { description: "请求参数错误", content: { "application/json": { schema: ref("ErrorResponse") } } },
      ...(input.security ? { "401": { description: "未登录、令牌过期或会话已撤销", content: { "application/json": { schema: ref("ErrorResponse") } } } } : {}),
      "403": { description: "权限不足，或当前 IP 已被全局风控规则拦截", content: { "application/json": { schema: ref("ErrorResponse") } } },
      "409": { description: "资源状态或幂等键冲突", content: { "application/json": { schema: ref("ErrorResponse") } } },
      "429": { description: "请求过于频繁，retry_after_seconds 表示等待秒数", content: { "application/json": { schema: ref("ErrorResponse") } } },
      "503": { description: "依赖服务尚未配置、失败或超时", content: { "application/json": { schema: ref("ErrorResponse") } } },
      "500": { description: "服务器内部错误", content: { "application/json": { schema: ref("ErrorResponse") } } },
    },
  };
}

const schemas: Record<string, JsonSchema> = {
  ErrorResponse: {
    type: "object",
    required: ["statusCode", "message"],
    properties: {
      statusCode: { type: "integer", example: 400 },
      message: { oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }], example: "请求参数错误" },
      error: { type: "string", example: "Bad Request" },
      code: { type: "string", description: "机器可读错误码；MAIL_HTTP_DELIVERY_UNCONFIRMED 表示发件结果未确认" },
      delivery_status: { type: "string", enum: ["FAILED", "UNCERTAIN"], description: "HTTP 发件错误时的状态；UNCERTAIN 不代表未送达" },
      diagnostic_id: { type: "string", format: "uuid", description: "可关联服务端脱敏日志的诊断编号" },
      expires_in: { type: "integer", description: "结果未确认时，已收到验证码的有效秒数" },
      retry_after_seconds: { type: "integer", description: "再次请求前等待秒数" },
    },
  },
  Health: {
    type: "object",
    properties: {
      status: { type: "string", example: "ok" },
      service: { type: "string", example: "ai-video-studio-server" },
      database: {
        type: "object",
        properties: { status: { type: "string", example: "ok" }, version: { type: "string", example: "5.7.40-log" } },
      },
      media_storage: { type: "string", example: "disabled" },
      timestamp: { type: "string", format: "date-time" },
    },
  },
  ClientAuthMethods: {
    type: "object",
    required: ["email_enabled", "phone_otp_enabled", "phone_otp_available", "wechat_enabled"],
    properties: {
      email_enabled: { type: "boolean", description: "是否显示邮箱注册登录" },
      phone_otp_enabled: { type: "boolean", description: "是否显示手机验证码注册登录" },
      phone_otp_available: { type: "boolean", description: "服务端是否已接入短信服务" },
      wechat_enabled: { type: "boolean", description: "是否显示微信公众号扫码注册登录" },
    },
  },
  ProductBrand: {
    type: "object",
    required: ["chinese_name", "english_name", "revision"],
    properties: {
      chinese_name: { type: "string", maxLength: 32, example: "影匠" },
      english_name: { type: "string", maxLength: 64, example: "Yingjiang" },
      revision: { type: "integer", minimum: 0 },
      updated_at: { type: "string", format: "date-time" },
    },
  },
  ProductBrandRequest: {
    type: "object",
    required: ["chinese_name", "english_name"],
    properties: {
      chinese_name: { type: "string", minLength: 1, maxLength: 32, example: "影匠" },
      english_name: { type: "string", minLength: 1, maxLength: 64, example: "Yingjiang" },
    },
  },
  DashboardOverview: {
    type: "object",
    required: ["users", "new_users_30d", "active_tasks", "paid_orders", "revenue_fen", "invitations", "commissions", "withdrawals", "payouts", "revenue_trend", "user_growth_trend", "recent", "generated_at"],
    properties: {
      users: { type: "integer" }, new_users_30d: { type: "integer" }, active_tasks: { type: "integer" }, paid_orders: { type: "integer" }, revenue_fen: { type: "integer", description: "累计实收金额，单位分" },
      invitations: { type: "object", additionalProperties: { type: "integer" }, description: "邀请总量、近30天、待首购、已奖励、受限与奖励积分汇总" },
      commissions: { type: "object", additionalProperties: { type: "integer" }, description: "分润笔数、各层级金额、近30天、可用及冻结金额汇总，金额单位分" },
      withdrawals: { type: "object", additionalProperties: { type: "integer" }, description: "提现各状态数量及申请、待处理金额汇总，金额单位分" },
      payouts: { type: "object", additionalProperties: { type: "integer" }, description: "打款累计与近30天笔数、金额汇总，金额单位分" },
      revenue_trend: { type: "array", minItems: 30, maxItems: 30, items: { type: "object", required: ["date", "revenue_fen", "paid_orders"], properties: { date: { type: "string", format: "date" }, revenue_fen: { type: "integer" }, paid_orders: { type: "integer" } } } },
      user_growth_trend: { type: "array", minItems: 30, maxItems: 30, items: { type: "object", required: ["date", "new_users", "total_users"], properties: { date: { type: "string", format: "date" }, new_users: { type: "integer" }, total_users: { type: "integer" } } } },
      recent: { type: "object", description: "邀请、分润、提现与打款各最近3条记录", additionalProperties: { type: "array", items: { type: "object", additionalProperties: true } } },
      generated_at: { type: "string", format: "date-time" },
    },
  },
  IpAccessRule: {
    type: "object",
    required: ["id", "cidr", "address_family", "prefix_length", "note", "enabled", "created_at", "updated_at"],
    properties: {
      id: { type: "string", format: "uuid" },
      cidr: { type: "string", example: "203.0.113.0/24" },
      address_family: { type: "integer", enum: [4, 6] },
      prefix_length: { type: "integer", minimum: 0, maximum: 128 },
      note: { type: "string", maxLength: 200 },
      enabled: { type: "boolean" },
      created_at: { type: "string", format: "date-time" },
      updated_at: { type: "string", format: "date-time" },
    },
  },
  IpAccessRuleRequest: {
    type: "object",
    required: ["cidr", "enabled"],
    properties: {
      cidr: { type: "string", maxLength: 64, description: "单个 IPv4/IPv6 地址或 CIDR 网段" },
      note: { type: "string", maxLength: 200 },
      enabled: { type: "boolean" },
    },
  },
  User: {
    type: "object",
    properties: {
      id: { type: "string", format: "uuid" },
      email: { type: "string", format: "email", nullable: true },
      pid: { type: "string", format: "uuid", nullable: true, readOnly: true, description: "注册时绑定的上级，既有账户不可重新绑定" },
      balance_fen: { type: "integer", minimum: 0, readOnly: true, description: "用户表保存的剩余分润余额，人民币分；等于可用加冻结，已打款金额不计入" },
      invite_code: { type: "string", pattern: "^[A-Z0-9]{8}$", readOnly: true, description: "唯一八位字母数字邀请码" },
      phone: { type: "string", nullable: true, example: "+8613800000000" },
      display_name: { type: "string" },
      avatar_url: { type: "string", format: "uri", nullable: true },
      bio: { type: "string" },
      status: { type: "string", example: "ACTIVE" },
      credit_balance: { type: "number", example: 3000 },
      held_credits: { type: "number", example: 20 },
      available_credits: { type: "number", example: 2980 },
      created_at: { type: "string", format: "date-time" },
      updated_at: { type: "string", format: "date-time" },
    },
  },
  TokenResult: {
    type: "object",
    required: ["access_token", "refresh_token", "token_type", "expires_in", "user"],
    properties: {
      access_token: { type: "string", description: "有效期 2 小时的 JWT" },
      refresh_token: { type: "string", description: "只返回一次的刷新令牌" },
      token_type: { type: "string", example: "Bearer" },
      expires_in: { type: "integer", example: 7200 },
      user: ref("User"),
    },
  },
  EmailRegisterRequest: {
    type: "object",
    required: ["email", "password", "email_code"],
    properties: {
      email: { type: "string", format: "email", maxLength: 191 },
      password: { type: "string", format: "password", minLength: 8, maxLength: 128, description: "必须同时包含字母和数字" },
      email_code: { type: "string", pattern: "^[0-9]{6}$", description: "邮件中收到的 6 位验证码，10 分钟内有效且只能使用一次" },
      display_name: { type: "string", maxLength: 100 },
      invite_code: { type: "string", pattern: "^[A-Za-z0-9]{8}$", description: "可选邀请人代码；仅注册新账户时生效，绑定与奖励在同一事务完成" },
    },
  },
  DistributionConfig: {
    type: "object", required: ["enabled", "direct_rate_bps", "indirect_rate_bps", "minimum_withdrawal_fen", "invitation_reward_credits", "invitation_anti_abuse_enabled", "invitation_daily_reward_limit", "invitation_monthly_reward_limit", "invite_page_base_url", "windows_download_url", "macos_download_url", "revision"],
    properties: {
      enabled: { type: "boolean", default: false },
      direct_rate_bps: { type: "integer", minimum: 0, maximum: 10000, description: "基点，1000=10%；与间接比例合计不超过10000" },
      indirect_rate_bps: { type: "integer", minimum: 0, maximum: 10000 },
      minimum_withdrawal_fen: { type: "integer", minimum: 1, maximum: 1000000000, default: 10000, description: "人民币分" },
      invitation_reward_credits: { type: "integer", minimum: 0, maximum: 100000, default: 20 },
      invitation_anti_abuse_enabled: { type: "boolean", default: false, description: "开启后注册只创建待确认奖励，首笔真实支付后按日/月人数限额发放；关闭时注册成功立即发放" },
      invitation_daily_reward_limit: { type: "integer", minimum: 1, maximum: 100000, default: 20 },
      invitation_monthly_reward_limit: { type: "integer", minimum: 1, maximum: 1000000, default: 200 },
      invite_page_base_url: { type: "string", maxLength: 500, description: "公开邀请页基础地址，不带查询参数、片段或邀请码；生产须HTTPS" },
      windows_download_url: { type: "string", maxLength: 1000 }, macos_download_url: { type: "string", maxLength: 1000 },
      revision: { type: "integer", minimum: 0, description: "乐观锁版本；保存冲突时须重读，不能强制覆盖" },
    },
  },
  SoftwareDownloadConfig: {
    type: "object",
    required: ["windows_download_url", "macos_download_url", "revision"],
    properties: {
      windows_download_url: { type: "string", maxLength: 1000, description: "Windows 安装包或下载页面的 HTTPS 地址" },
      macos_download_url: { type: "string", maxLength: 1000, description: "macOS 安装包或下载页面的 HTTPS 地址" },
      revision: { type: "integer", minimum: 0, description: "乐观锁版本" },
      updated_at: { type: "string", format: "date-time" },
    },
  },
  ReferralSummary: {
    type: "object", properties: {
      invite_code: { type: "string" }, invitation_url: { type: "string" }, invited_count: { type: "integer" }, reward_credits: { type: "integer" }, invitation_reward_credits: { type: "integer" }, invitation_anti_abuse_enabled: { type: "boolean" },
      enabled: { type: "boolean" }, direct_rate_bps: { type: "integer" }, indirect_rate_bps: { type: "integer" }, minimum_withdrawal_fen: { type: "integer" },
      available_fen: { type: "integer" }, frozen_fen: { type: "integer" }, earned_fen: { type: "integer" }, paid_fen: { type: "integer" },
      withdrawal_open: { type: "boolean" }, timezone: { type: "string", example: "Asia/Shanghai" }, server_time: { type: "string", format: "date-time" }, next_open_at: { type: "string", format: "date-time" },
    },
  },
  WithdrawalRequest: {
    type: "object", required: ["amount_fen", "idempotency_key", "alipay_real_name", "alipay_account", "alipay_qr_code"], properties: {
      amount_fen: { type: "integer", minimum: 1, maximum: 1000000000, description: "人民币分，须达到最低金额且不超过余额" },
      idempotency_key: { type: "string", pattern: "^[A-Za-z0-9_-]{16,64}$", description: "同用户同请求重试必须复用；资料变更须用新键" },
      alipay_real_name: { type: "string", maxLength: 100 }, alipay_account: { type: "string", maxLength: 191 },
      alipay_qr_code: { type: "string", maxLength: 2796236, description: "2MB以内PNG/JPEG的base64 data URL；不接受SVG/外部链接。资料加密保存。" },
    },
  },
  ReferralRecordPage: {
    type: "object", properties: { items: { type: "array", items: { type: "object", additionalProperties: true } }, page: { type: "integer" }, has_more: { type: "boolean" } },
    description: "每页最多50条。金额字段以分计（数据库BIGINT可能为字符串）；提现状态为PENDING/APPROVED/PROCESSING/REJECTED/PAID，邀请奖励状态为PENDING_PAYMENT/REWARDED/LIMITED。列表不包含收款实名、账号、收款码、密文或请求摘要。",
  },
  RegistrationCaptchaRequest: {
    type: "object", required: ["email"],
    properties: { email: { type: "string", format: "email", maxLength: 191 } },
  },
  RegistrationCaptcha: {
    type: "object", required: ["captcha_id", "image_data_url", "expires_in"],
    properties: { captcha_id: { type: "string", format: "uuid" }, image_data_url: { type: "string", description: "仅含路径的 SVG 图片 data URL，不包含答案文本" }, expires_in: { type: "integer", example: 300 } },
  },
  RegistrationCaptchaVerifyRequest: {
    type: "object", required: ["email", "captcha_id", "answer"],
    properties: { email: { type: "string", format: "email", maxLength: 191 }, captcha_id: { type: "string", format: "uuid" }, answer: { type: "string", maxLength: 10, description: "图片中的字符，不区分大小写" } },
  },
  RegistrationCaptchaProof: {
    type: "object", required: ["captcha_token", "expires_in"],
    properties: { captcha_token: { type: "string", description: "绑定邮箱/IP 的一次性发件凭证" }, expires_in: { type: "integer", example: 120 } },
  },
  RegistrationEmailCodeRequest: {
    type: "object", required: ["email", "captcha_token"],
    properties: { email: { type: "string", format: "email", maxLength: 191 }, captcha_token: { type: "string", maxLength: 100 } },
  },
  RegistrationEmailCodeResult: {
    type: "object", required: ["sent", "expires_in", "retry_after_seconds"],
    properties: { sent: { type: "boolean", example: true, description: "仅在邮件服务明确确认成功时返回 true" }, expires_in: { type: "integer", example: 600 }, retry_after_seconds: { type: "integer", example: 60 } },
  },
  PhoneRegisterRequest: {
    type: "object",
    required: ["phone", "password"],
    properties: {
      phone: { type: "string", example: "+8613800000000", maxLength: 32 },
      password: { type: "string", format: "password", minLength: 8, maxLength: 128, description: "必须同时包含字母和数字" },
      display_name: { type: "string", maxLength: 100 },
    },
  },
  LoginRequest: {
    type: "object",
    required: ["identifier", "password"],
    properties: {
      identifier: { type: "string", description: "邮箱或手机号" },
      password: { type: "string", format: "password" },
      device_name: { type: "string", maxLength: 100, example: "Windows Desktop" },
    },
  },
  RefreshRequest: {
    type: "object",
    required: ["refresh_token"],
    properties: {
      refresh_token: { type: "string" },
      device_name: { type: "string", maxLength: 100 },
    },
  },
  ProfileUpdateRequest: {
    type: "object",
    properties: {
      display_name: { type: "string", maxLength: 100 },
      avatar_url: { type: "string", format: "uri", nullable: true, description: "仅接受 HTTPS URL" },
      bio: { type: "string", maxLength: 500 },
      email: { type: "string", format: "email", nullable: true },
      phone: { type: "string", nullable: true },
      current_password: { type: "string", format: "password", description: "修改登录凭据时必填" },
      new_password: { type: "string", format: "password", minLength: 8, maxLength: 128 },
    },
  },
  WechatQrSession: {
    type: "object",
    properties: {
      state: { type: "string" },
      login_url: { type: "string", format: "uri", description: "公众号带参数二维码的原始内容，客户端应将该 URL 编码成二维码" },
      expires_at: { type: "string", format: "date-time" },
      requires_follow: { type: "boolean", description: "未关注用户扫码后需要先关注公众号" },
    },
  },
  CreditPackage: {
    type: "object",
    properties: {
      id: { type: "string", format: "uuid" },
      code: { type: "string" },
      name: { type: "string" },
      description: { type: "string" },
      base_credits: { type: "integer", format: "int64" },
      bonus_credits: { type: "integer", format: "int64" },
      total_credits: { type: "integer", format: "int64" },
      price_fen: { type: "integer", format: "int64", description: "人民币分" },
      currency: { type: "string", example: "CNY" },
      status: { type: "string", example: "ACTIVE" },
    },
  },
  CreditBalance: {
    type: "object",
    properties: {
      balance: { type: "number", example: 3000 },
      held: { type: "number", example: 20 },
      available: { type: "number", example: 2980 },
    },
  },
  CreditPurchaseRequest: {
    type: "object",
    required: ["package_id", "idempotency_key"],
    properties: {
      package_id: { type: "string", format: "uuid" },
      idempotency_key: { type: "string", maxLength: 191, example: "purchase-20260829-0001" },
    },
  },
  Model: {
    type: "object",
    properties: {
      id: { type: "string", format: "uuid", description: "创建任务时使用的 provider_model_id" },
      provider_code: { type: "string" },
      provider_name: { type: "string" },
      model_code: { type: "string" },
      display_name: { type: "string" },
      model_alias: { type: "string" },
      capability: { type: "string", enum: ["TEXT_GENERATION", "VIDEO_UNDERSTANDING", "IMAGE_GENERATION", "VIDEO_GENERATION"] },
      credit_cost: { type: "number" },
      billing_unit: { type: "string", enum: ["PER_REQUEST", "PER_SECOND"] },
      max_reference_images: { type: "integer" },
      supports_reference_video: { type: "boolean" },
      supports_real_person: { type: "boolean" },
      supports_async_tasks: { type: "boolean" },
      resolution_prices: { type: "array", items: { type: "object", properties: { resolution: { type: "string", example: "1080p" }, credit_cost: { type: "number" } } } },
      description: { type: "string" },
      parameter_schema: { type: "object", additionalProperties: true },
    },
  },
  Task: {
    type: "object",
    properties: {
      id: { type: "string", format: "uuid" },
      local_task_id: { type: "string", format: "uuid" },
      task_type: { type: "string" },
      logical_model_code: { type: "string" },
      provider_model_id: { type: "string", format: "uuid" },
      remote_task_id: { type: "string", nullable: true },
      status: { type: "string", enum: ["CREDIT_RESERVED", "PROVIDER_ACCEPTED", "PROCESSING", "SUCCEEDED", "FAILED", "CANCELED"] },
      progress: { type: "number", minimum: 0, maximum: 1 },
      estimated_credits: { type: "number" },
      settled_credits: { type: "number" },
      credits_released: { type: "boolean", description: "读取任务元数据时返回。只有冻结积分已释放才为 true，用于自动制作确认退款后重试。" },
      error_code: { type: "string", nullable: true },
      created_at: { type: "string", format: "date-time" },
      updated_at: { type: "string", format: "date-time" },
      finished_at: { type: "string", format: "date-time", nullable: true },
    },
  },
  TaskCreateRequest: {
    type: "object",
    required: ["idempotency_key", "provider_model_id", "payload"],
    properties: {
      local_task_id: { type: "string", format: "uuid", description: "可选的客户端任务 UUID" },
      expected_credits: { type: "number", minimum: 0, description: "用户已确认的 /tasks/quote 报价；与当前价格不一致则拒绝，且不占用或扣除积分" },
      idempotency_key: { type: "string", maxLength: 191, example: "model-task-20260829-0001" },
      provider_model_id: { type: "string", format: "uuid", description: "从 /client-config/models 获取" },
      payload: {
        type: "object",
        additionalProperties: true,
        description: "模型参数。图片/视频生成必须提供后台已定价的 resolution，视频还必须提供 seconds 或 duration；参考图可以使用 HTTPS URL 或 Data URL。客户端传入的 model/model_id 会被忽略。",
        example: { prompt: "生成电影感日落镜头", resolution: "1080p", reference_images: ["https://example.com/ref.png"], seconds: 10 },
      },
    },
  },
  VideoUnderstandingUrlRequest: {
    type: "object",
    required: ["idempotency_key", "video_url", "prompt"],
    properties: {
      idempotency_key: { type: "string", maxLength: 191 },
      provider_model_id: { type: "string", description: "报价确认的默认视频理解模型 ID；省略则使用当前默认模型" },
      expected_credits: { type: "number", minimum: 0, description: "用户已确认的积分金额；与当前费率不符时拒绝调用，不扣分" },
      video_url: { type: "string", format: "uri", description: "公网可访问的 HTTPS 视频地址" },
      mime_type: { type: "string", default: "video/mp4" },
      prompt: { type: "string" },
    },
  },
  VideoUnderstandingUploadRequest: {
    type: "object",
    required: ["idempotency_key", "prompt", "video"],
    properties: {
      idempotency_key: { type: "string", maxLength: 191 },
      provider_model_id: { type: "string", description: "报价确认的默认视频理解模型 ID；省略则使用当前默认模型" },
      expected_credits: { type: "number", minimum: 0, description: "用户已确认的积分金额；与当前费率不符时拒绝调用，不扣分" },
      prompt: { type: "string" },
      video: { type: "string", format: "binary", description: "客户端压缩后的视频，最大 15MB" },
    },
  },
  TaskRelayResult: {
    type: "object",
    properties: {
      task: ref("Task"),
      provider_response: { description: "供应商当次响应；不会持久化完整正文" },
      idempotent_replay: { type: "boolean" },
      terminal: { type: "boolean" },
    },
  },
  AdminLoginRequest: {
    type: "object",
    required: ["email", "password"],
    properties: { email: { type: "string", format: "email" }, password: { type: "string", format: "password" } },
  },
  AdminPasswordRequest: {
    type: "object",
    required: ["current_password", "new_password"],
    properties: { current_password: { type: "string", format: "password" }, new_password: { type: "string", format: "password" } },
  },
  ConfigCreateRequest: {
    type: "object",
    required: ["config_key", "category", "name", "value"],
    properties: {
      config_key: { type: "string", maxLength: 191 }, category: { type: "string", maxLength: 32 },
      name: { type: "string", maxLength: 150 }, description: { type: "string", maxLength: 1000 },
      value: {}, change_note: { type: "string", maxLength: 500 },
    },
  },
  ConfigVersionRequest: {
    type: "object", required: ["value"], properties: { value: {}, change_note: { type: "string", maxLength: 500 } },
  },
  ConfigPublishRequest: {
    type: "object",
    properties: {
      channel: { type: "string", default: "stable" }, min_client_version: { type: "string" },
      rollout_percent: { type: "integer", minimum: 0, maximum: 100, default: 100 },
    },
  },
  MailConfig: {
    type: "object",
    properties: {
      api_url: { type: "string", format: "uri" }, mail_from: { type: "string" },
      delivery_method: { type: "string", enum: ["HTTP", "SMTP"] }, smtp_host: { type: "string" }, smtp_port: { type: "integer" }, smtp_security: { type: "string", enum: ["STARTTLS", "TLS"] },
      password_configured: { type: "boolean", description: "仅返回是否已配置，不返回密码或密文" },
      status: { type: "string", enum: ["ACTIVE", "DISABLED"] }, revision: { type: "integer", minimum: 0 }, updated_at: { type: "string", format: "date-time" },
    },
  },
  MailConfigRequest: {
    type: "object", required: ["mail_from", "status", "revision"],
    properties: {
      api_url: { type: "string", format: "uri", maxLength: 500, example: "http://211.154.25.178:15686/mail_sys/send_mail_http.json", description: "HTTP 模式下支持完整 HTTP 或 HTTPS 发件接口，无内嵌凭据、查询参数或片段；HTTP 会明文传输发件密码和验证码内容。SMTP 模式忽略此字段" },
      delivery_method: { type: "string", enum: ["HTTP", "SMTP"], description: "省略时保留当前发件方式；仅验证和更新所选方式的服务器配置" },
      smtp_host: { type: "string", maxLength: 253, description: "SMTP 主机域名，无协议、端口或路径；省略保留原值" },
      smtp_port: { type: "integer", minimum: 1, maximum: 65535, description: "SMTP 端口；465 必须选择 TLS；省略保留原值" },
      smtp_security: { type: "string", enum: ["STARTTLS", "TLS"], description: "强制 STARTTLS 或隐式 SSL/TLS，验证域名证书，不支持明文密码认证；省略保留原值" },
      mail_from: { type: "string", maxLength: 191, description: "启用时必须填写发件邮箱" },
      password: { type: "string", format: "password", writeOnly: true, maxLength: 500, description: "留空保留原密码；首次启用或修改发件方式/服务器/端口/加密方式/发件邮箱时必须重新填写" },
      status: { type: "string", enum: ["ACTIVE", "DISABLED"] }, revision: { type: "integer", minimum: 0 },
    },
  },
  WechatPaymentConfigRequest: {
    type: "object",
    required: ["merchant_id", "payment_notify_url", "official_account_name", "app_id", "official_account_callback_url"],
    properties: {
      merchant_id: { type: "string" }, payment_notify_url: { type: "string", format: "uri" },
      merchant_key: { type: "string", format: "password", description: "32 字节 APIv3 Key；留空保留现值" },
      certificate_base64: { type: "string", format: "byte", description: "商户 X.509 证书，支持 PEM 或 DER" }, certificate_filename: { type: "string" },
      private_key_base64: { type: "string", format: "byte", description: "商户 RSA 私钥 PEM" }, private_key_filename: { type: "string" },
      wechatpay_public_key_base64: { type: "string", format: "byte", description: "微信支付公钥 PEM，用于 APIv3 应答和回调验签" },
      wechatpay_public_key_filename: { type: "string" }, wechatpay_public_key_id: { type: "string", example: "PUB_KEY_ID_..." },
      official_account_name: { type: "string" }, app_id: { type: "string", example: "wx..." },
      app_secret: { type: "string", format: "password", description: "留空保留现值" },
      official_account_token: { type: "string", format: "password", description: "公众号服务器配置 Token；留空保留现值" },
      official_account_encoding_aes_key: { type: "string", format: "password", description: "安全模式的 43 位 EncodingAESKey；明文模式可留空" },
      official_account_callback_url: { type: "string", format: "uri" },
      status: { type: "string", enum: ["ACTIVE", "DISABLED"], default: "DISABLED" },
    },
  },
  ProviderRequest: {
    type: "object",
    required: ["code", "display_name", "adapter_type", "base_url"],
    properties: {
      code: { type: "string" }, display_name: { type: "string" }, adapter_type: { type: "string" },
      base_url: { type: "string", format: "uri" }, status: { type: "string", enum: ["ACTIVE", "DISABLED"] },
      config: { type: "object", additionalProperties: true },
    },
  },
  ProviderUpdateRequest: {
    type: "object",
    properties: {
      code: { type: "string" }, display_name: { type: "string" }, adapter_type: { type: "string" },
      base_url: { type: "string", format: "uri" }, status: { type: "string", enum: ["ACTIVE", "DISABLED"] },
      config: { type: "object", additionalProperties: true },
    },
  },
  DefaultModelConfigRequest: {
    type: "object",
    required: ["text_model_id", "video_understanding_model_id", "image_model_ids", "video_model_ids"],
    properties: {
      text_model_id: { type: "string", format: "uuid" },
      video_understanding_model_id: { type: "string", format: "uuid" },
      image_model_ids: { type: "array", items: { type: "string", format: "uuid" } },
      video_model_ids: { type: "array", items: { type: "string", format: "uuid" } },
    },
  },
  ProviderCredentialRequest: {
    type: "object",
    required: ["name", "api_key"],
    properties: {
      name: { type: "string" }, api_key: { type: "string", format: "password" },
      status: { type: "string", enum: ["ACTIVE", "DISABLED"] }, balance: { type: "number" },
      balance_currency: { type: "string" }, notes: { type: "string" },
    },
  },
  ProviderCredentialUpdateRequest: {
    type: "object",
    properties: {
      name: { type: "string" }, api_key: { type: "string", format: "password", description: "留空保留现值" },
      status: { type: "string", enum: ["ACTIVE", "DISABLED"] }, balance: { type: "number" },
      balance_currency: { type: "string" }, notes: { type: "string" },
    },
  },
  ProviderModelRequest: {
    type: "object",
    required: ["model_code", "display_name", "model_alias", "capability", "api_protocol", "generation_endpoint", "credit_cost"],
    properties: {
      model_code: { type: "string" }, display_name: { type: "string" }, model_alias: { type: "string" },
      capability: { type: "string", enum: ["TEXT_GENERATION", "VIDEO_UNDERSTANDING", "IMAGE_GENERATION", "VIDEO_GENERATION"] },
      api_protocol: { type: "string" }, generation_endpoint: { type: "string" }, query_endpoint: { type: "string", nullable: true },
      credit_cost: { type: "integer", minimum: 0, description: "文本/理解/图片按次，视频生成按秒" },
      max_reference_images: { type: "integer", minimum: 0 }, supports_reference_video: { type: "boolean" },
      supports_real_person: { type: "boolean", default: false }, supports_async_tasks: { type: "boolean" },
      sort_order: { type: "integer" }, description: { type: "string" }, status: { type: "string", enum: ["ACTIVE", "DISABLED"] },
      parameter_schema: { type: "object", additionalProperties: true }, config: { type: "object", additionalProperties: true },
      resolution_prices: { type: "array", description: "图片按张、视频按秒的分辨率价格", items: { type: "object", required: ["resolution", "credit_cost"], properties: { resolution: { type: "string" }, credit_cost: { type: "integer", minimum: 1 } } } },
    },
  },
  ModelTestRequest: {
    type: "object", required: ["payload"],
    properties: { credential_id: { type: "string", format: "uuid" }, payload: { type: "object", additionalProperties: true } },
  },
  CreditPackageAdminRequest: {
    type: "object",
    required: ["code", "name", "base_credits", "bonus_credits", "price_fen", "sort_order"],
    properties: {
      code: { type: "string" }, name: { type: "string" }, description: { type: "string" },
      base_credits: { type: "integer", format: "int64" }, bonus_credits: { type: "integer", format: "int64" },
      price_fen: { type: "integer", format: "int64" }, currency: { type: "string", default: "CNY" },
      status: { type: "string", enum: ["ACTIVE", "DISABLED"] }, sort_order: { type: "integer" },
    },
  },
  CreditPurchaseAdminRequest: {
    type: "object", required: ["user_id", "package_id"],
    properties: {
      user_id: { type: "string", format: "uuid" }, package_id: { type: "string", format: "uuid" },
      credits_granted: { type: "integer", format: "int64" }, paid_amount_fen: { type: "integer", format: "int64" },
      currency: { type: "string" }, payment_order_id: { type: "string", format: "uuid", nullable: true },
      status: { type: "string" }, purchased_at: { type: "string", format: "date-time", nullable: true }, notes: { type: "string" },
    },
  },
  CreditConsumptionAdminRequest: {
    type: "object", required: ["user_id", "credits_consumed"],
    properties: {
      user_id: { type: "string", format: "uuid" }, task_id: { type: "string", format: "uuid", nullable: true },
      provider_model_id: { type: "string", format: "uuid", nullable: true }, category: { type: "string", default: "MODEL_TASK" },
      credits_consumed: { type: "number" }, status: { type: "string" }, description: { type: "string" }, notes: { type: "string" },
      metadata: { type: "object", additionalProperties: true }, occurred_at: { type: "string", format: "date-time", nullable: true },
    },
  },
  AdminUserUpdateRequest: {
    type: "object",
    required: ["display_name", "status"],
    properties: {
      display_name: { type: "string", maxLength: 100 },
      email: { type: "string", format: "email", nullable: true },
      phone: { type: "string", nullable: true },
      avatar_url: { type: "string", format: "uri", nullable: true },
      bio: { type: "string", maxLength: 500 },
      status: { type: "string", enum: ["ACTIVE", "DISABLED"] },
    },
  },
  AdminCreditAdjustmentRequest: {
    type: "object",
    required: ["amount", "reason"],
    properties: {
      amount: { type: "integer", format: "int64", description: "正数增加积分，负数扣减积分，不可为 0" },
      reason: { type: "string", maxLength: 500 },
    },
  },
  PromptDefaults: {
    type: "object",
    required: ["source", "channel", "generated_at", "prompts", "versions"],
    properties: {
      source: { type: "string", enum: ["SERVER"], example: "SERVER" },
      channel: { type: "string", example: "stable" },
      generated_at: { type: "string", format: "date-time" },
      prompts: {
        type: "object",
        required: ["video_storyboard_prompt", "video_storyboard_detailed_prompt", "character_image_prompt"],
        properties: {
          video_storyboard_prompt: { type: "string", description: "标准视频理解提示词" },
          video_storyboard_detailed_prompt: { type: "string", description: "详细视频理解提示词" },
          character_image_prompt: { type: "string", description: "角色生图提示词" },
        },
      },
      versions: {
        type: "object",
        properties: {
          video_storyboard_prompt: { type: "integer", minimum: 1 },
          video_storyboard_detailed_prompt: { type: "integer", minimum: 1 },
          character_image_prompt: { type: "integer", minimum: 1 },
        },
      },
    },
  },
};

export function createApiDocument(): OpenAPIObject {
  const paths: Record<string, Record<string, unknown>> = {
    "/health": {
      get: operation({ id: "health", tag: "系统", summary: "服务与数据库健康检查", success: ref("Health") }),
    },
    "/client-config/bootstrap": {
      get: operation({ id: "clientBootstrap", tag: "客户端配置", summary: "读取客户端引导配置" }),
    },
    "/client-config/auth-methods": {
      get: operation({ id: "clientAuthMethods", tag: "客户端配置", summary: "读取客户端可显示的注册登录方式", success: ref("ClientAuthMethods") }),
    },
    "/client-config/product-brand": {
      get: operation({ id: "clientProductBrand", tag: "客户端配置", summary: "读取产品中英文名称", success: ref("ProductBrand") }),
    },
    "/client-config/releases/current": {
      get: operation({ id: "currentConfigRelease", tag: "客户端配置", summary: "读取当前发布配置", parameters: [query("channel", "发布渠道，默认 stable")] }),
    },
    "/client-config/models": {
      get: operation({ id: "clientModels", tag: "客户端配置", summary: "读取启用的大模型目录与积分价格", success: arrayOf(ref("Model")) }),
    },
    "/client-config/prompts": {
      get: operation({
        id: "clientPromptDefaults",
        tag: "客户端配置",
        summary: "读取客户端默认提示词",
        description: "返回指定发布频道当前生效的标准视频理解、详细视频理解和角色生图提示词。客户端本地手动覆盖优先于这些默认值。",
        parameters: [query("channel", "发布渠道，默认 stable")],
        success: ref("PromptDefaults"),
      }),
    },
    "/auth/email/status": {
      post: operation({ id: "emailRegistrationStatus", tag: "用户身份", summary: "检查邮箱是否已注册", description: "统一登录入口在邮箱失焦时调用。仅返回规范化邮箱和 registered 布尔值，不返回用户资料。每 IP 每分钟最多 30 次，响应禁止缓存。", body: ref("RegistrationCaptchaRequest"), success: { type: "object", required: ["email", "registered"], properties: { email: { type: "string", format: "email" }, registered: { type: "boolean" } } } }),
    },
    "/auth/register/email": {
      post: operation({ id: "registerEmail", tag: "用户身份", summary: "校验邮箱验证码并注册", body: ref("EmailRegisterRequest"), success: ref("TokenResult") }),
    },
    "/auth/register/email/captcha": {
      post: operation({ id: "createEmailCaptcha", tag: "用户身份", summary: "获取注册图形验证码", body: ref("RegistrationCaptchaRequest"), success: ref("RegistrationCaptcha") }),
    },
    "/auth/register/email/captcha/verify": {
      post: operation({ id: "verifyEmailCaptcha", tag: "用户身份", summary: "验证图形码并签发一次性发件凭证", body: ref("RegistrationCaptchaVerifyRequest"), success: ref("RegistrationCaptchaProof") }),
    },
    "/auth/register/email/code": {
      post: operation({ id: "sendRegistrationEmailCode", tag: "用户身份", summary: "发送注册邮箱验证码", description: "必须先完成图形验证。每邮箱至少间隔 60 秒，验证码 10 分钟有效。明确失败后需重新完成图形验证。若返回 503 且 code=MAIL_HTTP_DELIVERY_UNCONFIRMED，邮件可能已送达：已收到的本次验证码仍可在有效期内按原有尝试次数和一次性规则注册；服务端不自动重发。", body: ref("RegistrationEmailCodeRequest"), success: ref("RegistrationEmailCodeResult") }),
    },
    "/auth/register/phone": {
      post: operation({ id: "registerPhone", tag: "用户身份", summary: "手机号密码注册", body: ref("PhoneRegisterRequest"), success: ref("TokenResult") }),
    },
    "/auth/login": {
      post: operation({ id: "userLogin", tag: "用户身份", summary: "邮箱或手机号密码登录", body: ref("LoginRequest"), success: ref("TokenResult") }),
    },
    "/auth/refresh": {
      post: operation({ id: "refreshUserToken", tag: "用户身份", summary: "轮换刷新令牌", description: "刷新成功后旧刷新令牌与旧访问令牌立即失效。", body: ref("RefreshRequest"), success: ref("TokenResult") }),
    },
    "/auth/logout": {
      post: operation({ id: "userLogout", tag: "用户身份", summary: "退出当前会话", security: true }),
    },
    "/auth/wechat/qr-sessions": {
      post: operation({ id: "createWechatQrSession", tag: "微信登录", summary: "创建公众号带参二维码登录会话", description: "可选JSON请求体含invite_code；未关注用户关注后触发 subscribe 事件，已关注用户扫码触发 SCAN 事件。邀请关系仅在创建新微信账户时生效。", success: ref("WechatQrSession") }),
    },
    "/auth/wechat/events": {
      get: operation({ id: "verifyWechatOfficialAccount", tag: "微信登录", summary: "验证微信公众号服务器回调", parameters: [query("signature", "公众号签名"), query("timestamp", "时间戳"), query("nonce", "随机串"), query("echostr", "验证字符串")] }),
      post: operation({ id: "receiveWechatOfficialAccountEvent", tag: "微信登录", summary: "接收公众号关注与扫码事件", description: "接收微信公众平台推送的 XML；支持明文模式及配置 EncodingAESKey 后的安全模式。" }),
    },
    "/auth/wechat/qr-sessions/status": {
      get: operation({ id: "wechatQrStatus", tag: "微信登录", summary: "轮询微信扫码登录状态并领取令牌", description: "完成后的登录令牌只能领取一次。", parameters: [query("state", "扫码会话 state", { type: "string" }, true), query("device_name", "设备名称")] }),
    },
    "/users/me": {
      get: operation({ id: "currentUser", tag: "用户资料", summary: "读取当前用户、积分及占用余额", security: true, success: ref("User") }),
      patch: operation({ id: "updateCurrentUser", tag: "用户资料", summary: "修改当前用户资料或登录凭据", security: true, body: ref("ProfileUpdateRequest"), success: ref("User") }),
    },
    "/referrals/invitations/{code}": {
      get: operation({ id: "publicInvitation", tag: "邀请与分润", summary: "校验公开邀请码并读取安装包下载地址", parameters: [{ name: "code", in: "path", required: true, schema: { type: "string", pattern: "^[A-Za-z0-9]{8}$" } }] }),
    },
    "/referrals/me": {
      get: operation({ id: "referralSummary", tag: "邀请与分润", summary: "当前用户邀请码、余额和周五提现窗口", security: true, success: ref("ReferralSummary") }),
    },
    "/referrals/me/{kind}": {
      get: operation({ id: "userReferralRecords", tag: "邀请与分润", summary: "当前用户的邀请、分润、提现或打款记录", security: true, parameters: [{ name: "kind", in: "path", required: true, schema: { type: "string", enum: ["rewards", "commissions", "withdrawals", "payouts"] } }, query("page", "页码，默认1", { type: "integer", minimum: 1, maximum: 100000 })], success: ref("ReferralRecordPage") }),
    },
    "/referrals/withdrawals": {
      post: operation({ id: "applyWithdrawal", tag: "邀请与分润", summary: "提交提现申请并冻结余额", description: "每周五北京时间开放。关闭分销不影响已有余额提现。重复请求不会重复冻结；审核驳回释放冻结。不会自动转账。", security: true, body: ref("WithdrawalRequest") }),
    },
    "/admin/distribution/config": {
      get: operation({ id: "distributionConfig", tag: "管理分销", summary: "读取分销与邀请配置（configs.manage）", security: true, success: ref("DistributionConfig") }),
      patch: operation({ id: "saveDistributionConfig", tag: "管理分销", summary: "保存配置（configs.manage和distribution.manage）", description: "默认关闭分销；开启时比例合计必须大于0且不超过100%。不重算历史分润。邀请积分奖励与分销开关独立；防刷开启后新奖励待首笔真实支付确认并受北京时间日/月人数上限约束。", security: true, body: ref("DistributionConfig"), success: ref("DistributionConfig") }),
    },
    "/admin/distribution/downloads": {
      get: operation({ id: "softwareDownloadConfig", tag: "管理配置", summary: "读取注册成功页的软件下载安装地址（configs.manage）", security: true, success: ref("SoftwareDownloadConfig") }),
      patch: operation({ id: "saveSoftwareDownloadConfig", tag: "管理配置", summary: "保存软件下载安装地址（configs.manage）", description: "至少配置一个平台，保存后立即用于邀请注册成功页。", security: true, body: ref("SoftwareDownloadConfig"), success: ref("SoftwareDownloadConfig") }),
    },
    "/admin/distribution/records/{kind}": {
      get: operation({ id: "adminDistributionRecords", tag: "管理分销", summary: "分页查询账本（distribution.manage）", security: true, parameters: [{ name: "kind", in: "path", required: true, schema: { type: "string", enum: ["rewards", "commissions", "withdrawals", "payouts"] } }, query("page", "页码", { type: "integer", minimum: 1, maximum: 100000 }), query("status", "提现或邀请奖励状态", { type: "string", enum: ["PENDING", "APPROVED", "PROCESSING", "REJECTED", "PAID", "PENDING_PAYMENT", "REWARDED", "LIMITED"] }), query("user_id", "收益用户ID")], success: ref("ReferralRecordPage") }),
    },
    "/admin/distribution/withdrawals/{id}/review": {
      post: operation({ id: "reviewWithdrawal", tag: "管理分销", summary: "审核提现（distribution.manage）", security: true, parameters: [pathId("id", "提现ID")], body: { type: "object", required: ["decision"], properties: { decision: { type: "string", enum: ["APPROVED", "REJECTED"] }, note: { type: "string", maxLength: 500, description: "驳回必填原因" } } } }),
    },
    "/admin/distribution/withdrawals/{id}/payee": {
      get: operation({ id: "withdrawalPayee", tag: "管理分销", summary: "查看解密收款资料（payouts.manage，访问留审计）", description: "返回can_confirm；仅PROCESSING状态的领取人可确认打款。禁止缓存。", security: true, parameters: [pathId("id", "提现ID")] }),
    },
    "/admin/distribution/withdrawals/{id}/claim": {
      post: operation({ id: "claimPayout", tag: "管理分销", summary: "领取已审核打款任务（payouts.manage）", description: "APPROVED转PROCESSING，一个申请只能由一名管理员持有。不会自动过期或自动转账。", security: true, parameters: [pathId("id", "提现ID")] }),
    },
    "/admin/distribution/withdrawals/{id}/release": {
      post: operation({ id: "releasePayout", tag: "管理分销", summary: "确认未打款后释放自己领取的任务（payouts.manage）", security: true, parameters: [pathId("id", "提现ID")], body: { type: "object", required: ["not_paid", "note"], properties: { not_paid: { type: "boolean", enum: [true] }, note: { type: "string", minLength: 1, maxLength: 500 } } } }),
    },
    "/admin/distribution/withdrawals/{id}/paid": {
      post: operation({ id: "confirmPayout", tag: "管理分销", summary: "领取人确认实际手动打款并记账（payouts.manage）", description: "仅记录已实际完成的支付宝转账，不调用支付宝转账API。流水号全局唯一，同一申请同一流水重试不重复扣款。", security: true, parameters: [pathId("id", "提现ID")], body: { type: "object", required: ["confirmed", "alipay_trade_no", "note"], properties: { confirmed: { type: "boolean", enum: [true] }, alipay_trade_no: { type: "string", pattern: "^[A-Za-z0-9_-]{6,100}$" }, note: { type: "string", minLength: 1, maxLength: 500 } } } }),
    },
    "/credits/packages": {
      get: operation({ id: "creditPackages", tag: "用户积分", summary: "读取可购买的积分套餐", success: arrayOf(ref("CreditPackage")) }),
    },
    "/credits/balance": {
      get: operation({ id: "creditBalance", tag: "用户积分", summary: "读取积分余额、占用与可用余额", security: true, success: ref("CreditBalance") }),
    },
    "/credits/purchases": {
      get: operation({ id: "listCreditPurchases", tag: "用户积分", summary: "读取当前用户最近 100 条积分购买记录", security: true }),
      post: operation({ id: "createCreditPurchase", tag: "用户积分", summary: "创建微信 Native 支付订单", description: "同一用户的 idempotency_key 唯一；成功返回可生成二维码的 code_url。", security: true, body: ref("CreditPurchaseRequest") }),
    },
    "/credits/consumptions": {
      get: operation({ id: "listCreditConsumptions", tag: "用户积分", summary: "读取当前用户最近 100 条积分消耗记录", security: true }),
    },
    "/credits/purchases/{purchaseId}": {
      get: operation({ id: "creditPurchase", tag: "用户积分", summary: "查询积分购买及支付状态", security: true, parameters: [pathId("purchaseId", "积分购买记录 ID")] }),
    },
    "/payments/wechat/notify": {
      post: operation({
        id: "wechatPaymentNotify", tag: "微信支付", summary: "微信支付结果通知",
        description: "微信支付服务器调用。服务端验证平台签名、解密报文并幂等发放积分。",
        parameters: [
          { name: "Wechatpay-Timestamp", in: "header", required: true, schema: { type: "string" } },
          { name: "Wechatpay-Nonce", in: "header", required: true, schema: { type: "string" } },
          { name: "Wechatpay-Signature", in: "header", required: true, schema: { type: "string" } },
          { name: "Wechatpay-Serial", in: "header", required: false, schema: { type: "string" } },
        ],
        body: { type: "object", additionalProperties: true },
      }),
    },
    "/tasks": {
      post: operation({ id: "createModelTask", tag: "模型任务", summary: "创建并转发模型任务", description: "先预占积分，再使用服务端保存的供应商 API Key 转发。提示词、媒体和完整响应不会写入数据库。提交前已回滚的数据库锁冲突会内部重试；重试耗尽返回 HTTP 503，code=TASK_NOT_SUBMITTED、retryable=true，明确表示未提交供应商且未扣分。普通 5xx、网络错误或查询 404 不代表未提交，不得据此重新扣分。", security: true, body: ref("TaskCreateRequest"), success: ref("TaskRelayResult") }),
      get: operation({ id: "listModelTasks", tag: "模型任务", summary: "读取当前用户最近 100 条任务", security: true, success: arrayOf(ref("Task")) }),
    },
    "/tasks/quote": {
      post: operation({ id: "quoteModelTask", tag: "模型任务", summary: "读取模型调用的最终积分报价（不扣分）", security: true,
        description: "优先使用 provider_model_id；未提供时按 capability 获取默认文本或视频理解模型。媒体 payload 必须包含分辨率，视频还需秒数。报价已含类型系数。提交任务时传回模型ID及 expected_credits，价格变化须重新确认。",
        body: { type: "object", required: ["payload"], properties: { provider_model_id: { type: "string" }, capability: { type: "string", enum: ["TEXT_GENERATION", "VIDEO_UNDERSTANDING"] }, payload: { type: "object", additionalProperties: true } } },
        success: { type: "object", properties: { provider_model_id: { type: "string" }, model_alias: { type: "string" }, capability: { type: "string" }, credits: { type: "number" }, resolution: { type: "string", nullable: true }, seconds: { type: "number", nullable: true }, includes_multiplier: { type: "boolean" } } },
      }),
    },
    "/tasks/video-understanding/url": {
      post: operation({ id: "understandVideoUrl", tag: "模型任务", summary: "通过公网 URL 理解视频", description: "自动使用后台配置的默认视频理解模型；不会下载或保存视频。", security: true, body: ref("VideoUnderstandingUrlRequest"), success: ref("TaskRelayResult") }),
    },
    "/tasks/video-understanding/upload": {
      post: operation({ id: "understandUploadedVideo", tag: "模型任务", summary: "理解客户端上传的视频", description: "接收客户端压缩后的 multipart 视频，自动使用后台配置的默认视频理解模型；视频仅在内存中转发，不写入数据库或磁盘。", security: true, body: ref("VideoUnderstandingUploadRequest"), bodyContentType: "multipart/form-data", success: ref("TaskRelayResult") }),
    },
    "/tasks/{taskId}": {
      get: operation({ id: "modelTask", tag: "模型任务", summary: "读取任务元数据", security: true, parameters: [pathId("taskId", "模型任务 ID")], success: ref("Task") }),
    },
    "/tasks/by-local/{localId}": {
      get: operation({ id: "modelTaskByLocalId", tag: "模型任务", summary: "按客户端请求编号核对任务和退款状态", security: true, parameters: [pathId("localId", "客户端请求 UUID，仅限当前用户的任务")], success: ref("Task") }),
    },
    "/tasks/{taskId}/query": {
      post: operation({ id: "queryModelTask", tag: "模型任务", summary: "向供应商查询异步任务", security: true, parameters: [pathId("taskId", "模型任务 ID")], success: ref("TaskRelayResult") }),
    },
    "/admin/auth/login": {
      post: operation({ id: "adminLogin", tag: "管理身份", summary: "管理员登录", body: ref("AdminLoginRequest") }),
    },
    "/admin/auth/me": {
      get: operation({ id: "currentAdmin", tag: "管理身份", summary: "读取当前管理员身份与权限", security: true }),
    },
    "/admin/auth/change-password": {
      post: operation({ id: "changeAdminPassword", tag: "管理身份", summary: "修改管理员密码", security: true, body: ref("AdminPasswordRequest") }),
    },
    "/admin/dashboard/overview": {
      get: operation({ id: "adminOverview", tag: "管理概览", summary: "读取运营概览、分销明细与最近30天趋势", security: true, success: ref("DashboardOverview") }),
    },
    "/admin/configs": {
      get: operation({ id: "listConfigs", tag: "管理配置", summary: "读取配置集合", security: true, parameters: [query("category", "按配置分类筛选")] }),
      post: operation({ id: "createConfig", tag: "管理配置", summary: "创建配置集合及首个版本", security: true, body: ref("ConfigCreateRequest") }),
    },
    "/admin/configs/{configSetId}/versions": {
      post: operation({ id: "createConfigVersion", tag: "管理配置", summary: "创建配置版本", security: true, parameters: [pathId("configSetId", "配置集合 ID")], body: ref("ConfigVersionRequest") }),
    },
    "/admin/configs/{configSetId}/versions/{versionId}/publish": {
      post: operation({ id: "publishConfigVersion", tag: "管理配置", summary: "发布配置版本", security: true, parameters: [pathId("configSetId", "配置集合 ID"), pathId("versionId", "配置版本 ID")], body: ref("ConfigPublishRequest") }),
    },
    "/admin/configs/mail": {
      get: operation({ id: "getMailConfig", tag: "管理配置", summary: "读取邮箱配置（不含密码）", security: true, success: ref("MailConfig") }),
      patch: operation({ id: "saveMailConfig", tag: "管理配置", summary: "保存邮箱配置", description: "需要 configs.manage 权限；发件密码加密保存、留空保留。携带当前 revision 防止并发覆盖。保存后新邮件请求立即使用配置。", security: true, body: ref("MailConfigRequest"), success: ref("MailConfig") }),
    },
    "/admin/configs/auth-methods": {
      get: operation({ id: "getAdminAuthMethods", tag: "管理配置", summary: "读取客户端登录方式配置", security: true, success: ref("ClientAuthMethods") }),
      patch: operation({ id: "updateAdminAuthMethods", tag: "管理配置", summary: "保存客户端登录方式配置", security: true }),
    },
    "/admin/configs/product-brand": {
      get: operation({ id: "getProductBrand", tag: "管理配置", summary: "读取产品中英文名称", security: true, success: ref("ProductBrand") }),
      patch: operation({ id: "updateProductBrand", tag: "管理配置", summary: "保存产品中英文名称", security: true, body: ref("ProductBrandRequest"), success: ref("ProductBrand") }),
    },
    "/admin/configs/ip-access-rules": {
      get: operation({ id: "listIpAccessRules", tag: "管理配置", summary: "读取 IP 风控规则和当前管理端 IP", security: true }),
      post: operation({ id: "createIpAccessRule", tag: "管理配置", summary: "添加 IP 或 CIDR 全局拦截规则", description: "启用后命中的地址不能访问任何 API；不能添加会立即拦截当前管理员的启用规则。", security: true, body: ref("IpAccessRuleRequest"), success: ref("IpAccessRule") }),
    },
    "/admin/configs/ip-access-rules/{ruleId}": {
      patch: operation({ id: "updateIpAccessRule", tag: "管理配置", summary: "更新或启停 IP 风控规则", security: true, parameters: [pathId("ruleId", "IP 风控规则 ID")], body: ref("IpAccessRuleRequest"), success: ref("IpAccessRule") }),
      delete: operation({ id: "deleteIpAccessRule", tag: "管理配置", summary: "删除 IP 风控规则", security: true, parameters: [pathId("ruleId", "IP 风控规则 ID")] }),
    },
    "/admin/configs/wechat-payment": {
      get: operation({ id: "getWechatPaymentConfig", tag: "管理微信配置", summary: "读取脱敏的微信公众号与微信支付配置", security: true }),
      patch: operation({ id: "updateWechatPaymentConfig", tag: "管理微信配置", summary: "更新微信公众号与微信支付配置", description: "密钥、商户私钥及微信支付公钥加密写入数据库；已配置的敏感字段可留空以保留现值。", security: true, body: ref("WechatPaymentConfigRequest") }),
    },
    "/admin/providers": {
      get: operation({ id: "listProviders", tag: "管理供应商", summary: "读取 AI 供应商", security: true }),
      post: operation({ id: "createProvider", tag: "管理供应商", summary: "创建 AI 供应商", security: true, body: ref("ProviderRequest") }),
    },
    "/admin/providers/default-model-config": {
      get: operation({ id: "getDefaultModelConfig", tag: "管理供应商", summary: "读取默认 AI 大模型及可选模型", security: true }),
      patch: operation({ id: "updateDefaultModelConfig", tag: "管理供应商", summary: "更新默认 AI 大模型", security: true, body: ref("DefaultModelConfigRequest") }),
    },
    "/admin/providers/{providerId}": {
      patch: operation({ id: "updateProvider", tag: "管理供应商", summary: "更新 AI 供应商", security: true, parameters: [pathId("providerId", "供应商 ID")], body: ref("ProviderUpdateRequest") }),
    },
    "/admin/providers/{providerId}/credentials": {
      get: operation({ id: "listProviderCredentials", tag: "管理 API Key", summary: "读取供应商 API Key（仅返回脱敏信息）", security: true, parameters: [pathId("providerId", "供应商 ID")] }),
      post: operation({ id: "createProviderCredential", tag: "管理 API Key", summary: "添加并加密保存供应商 API Key", security: true, parameters: [pathId("providerId", "供应商 ID")], body: ref("ProviderCredentialRequest") }),
    },
    "/admin/providers/{providerId}/pricing": {
      get: operation({
        id: "getProviderPricing", tag: "管理供应商", summary: "查询供应商所有模型的实时价格", security: true,
        parameters: [pathId("providerId", "供应商 ID")],
        description: "需要 providers.manage 权限。目前支持 code=wagaai；使用该供应商首个启用的 API Key 查询完整模型目录及本地配置模型，保留运行/暂停渠道、Token 和参数价格。返回查询时间、密钥名称、成功/失败数及模型价格；单个模型失败记录在 models[].error。仅查询，不修改系统积分定价或保存报价。",
      }),
    },
    "/admin/providers/{providerId}/pricing/sync": {
      post: operation({ id: "refreshProviderPricingAndCredits", tag: "管理供应商", summary: "查询实时价格并按启用的比例更新模型积分", security: true,
        parameters: [pathId("providerId", "供应商 ID")],
        description: "需要 providers.manage 权限。自动定价开启且供应商启用时，按可用渠道最低可换算价更新每个配置分辨率的积分；向上取整且最低 1 积分。返回实时价格及 credit_sync 处理报告。自动定价关闭时仅查询。不改变历史任务、用户余额或充值套餐。" }),
    },
    "/admin/configs/credit-pricing": {
      get: operation({ id: "getCreditPricingConfig", tag: "管理配置", summary: "读取人民币积分比例及最近更新报告", security: true }),
      patch: operation({ id: "saveCreditPricingConfig", tag: "管理配置", summary: "保存人民币积分比例并同步模型积分", security: true,
        description: "需要 configs.manage 与 providers.manage 权限。auto_sync=true 时保存后查询全部已接入且启用供应商。revision 必须为当前版本，避免覆盖其他管理员修改。WagaAI 算力按 1:1 人民币转换。",
        body: { type: "object", required: ["cny_per_credit", "auto_sync", "revision"], properties: {
          cny_per_credit: { type: "number", minimum: 0.000001, maximum: 1000000, example: 0.1 },
          auto_sync: { type: "boolean" }, revision: { type: "integer", minimum: 0 },
        } } }),
    },
    "/admin/configs/credit-multipliers": {
      get: operation({ id: "getModelCreditMultipliers", tag: "管理配置", summary: "读取四类大模型积分系数", security: true,
        description: "需要 configs.manage 权限，返回 multipliers 和 revision。四类系数默认均为 1。" }),
      patch: operation({ id: "saveModelCreditMultipliers", tag: "管理配置", summary: "保存四类大模型积分系数", security: true,
        description: "需要 configs.manage、providers.manage 权限。最终单价=基础积分×对应模型类型系数，视频再乘秒数。新任务生效，已有任务保持创建时锁定的最终积分。支持 6 位小数，不重复写入基础定价。",
        body: { type: "object", required: ["multipliers", "revision"], properties: {
          revision: { type: "integer", minimum: 0 },
          multipliers: { type: "object", required: ["TEXT_GENERATION", "VIDEO_UNDERSTANDING", "IMAGE_GENERATION", "VIDEO_GENERATION"], properties:
            Object.fromEntries(["TEXT_GENERATION", "VIDEO_UNDERSTANDING", "IMAGE_GENERATION", "VIDEO_GENERATION"].map((capability) => [capability, { type: "number", minimum: 0.000001, maximum: 1000, default: 1 }])) },
        } } }),
    },
    "/admin/configs/credit-pricing/sync": {
      post: operation({ id: "syncAllModelCredits", tag: "管理配置", summary: "按已保存比例刷新实时价并更新模型积分", security: true,
        description: "需要 configs.manage 与 providers.manage 权限及启用的 auto_sync。按 Token 计费且无用量规则、无可用渠道、分辨率不匹配或上游失败时保留原价，结果包含逐档原因。" }),
    },
    "/admin/providers/{providerId}/credentials/{credentialId}": {
      patch: operation({ id: "updateProviderCredential", tag: "管理 API Key", summary: "更新供应商 API Key、余额或状态", security: true, parameters: [pathId("providerId", "供应商 ID"), pathId("credentialId", "API Key 记录 ID")], body: ref("ProviderCredentialUpdateRequest") }),
    },
    "/admin/providers/{providerId}/models": {
      get: operation({ id: "listProviderModels", tag: "管理模型", summary: "读取供应商下的大模型", security: true, parameters: [pathId("providerId", "供应商 ID")] }),
      post: operation({ id: "createProviderModel", tag: "管理模型", summary: "创建供应商大模型", security: true, parameters: [pathId("providerId", "供应商 ID")], body: ref("ProviderModelRequest") }),
    },
    "/admin/providers/{providerId}/models/{modelId}": {
      patch: operation({ id: "updateProviderModel", tag: "管理模型", summary: "更新供应商大模型", security: true, parameters: [pathId("providerId", "供应商 ID"), pathId("modelId", "模型 ID")], body: ref("ProviderModelRequest") }),
    },
    "/admin/providers/{providerId}/models/{modelId}/tests": {
      post: operation({ id: "createModelTest", tag: "模型测试", summary: "使用配置的 API Key 创建模型测试", security: true, parameters: [pathId("providerId", "供应商 ID"), pathId("modelId", "模型 ID")], body: ref("ModelTestRequest") }),
    },
    "/admin/model-tests": {
      get: operation({ id: "listModelTests", tag: "模型测试", summary: "读取模型测试记录", security: true, parameters: [query("limit", "返回数量，1～200", { type: "integer", minimum: 1, maximum: 200 })] }),
    },
    "/admin/model-tests/{testId}/query": {
      post: operation({ id: "queryModelTest", tag: "模型测试", summary: "查询异步模型测试任务", security: true, parameters: [pathId("testId", "测试记录 ID")] }),
    },
    "/admin/credits/packages": {
      get: operation({ id: "adminListCreditPackages", tag: "管理积分", summary: "读取全部积分套餐", security: true }),
      post: operation({ id: "adminCreateCreditPackage", tag: "管理积分", summary: "创建积分套餐", security: true, body: ref("CreditPackageAdminRequest") }),
    },
    "/admin/credits/packages/{packageId}": {
      patch: operation({ id: "adminUpdateCreditPackage", tag: "管理积分", summary: "更新积分套餐", security: true, parameters: [pathId("packageId", "积分套餐 ID")], body: ref("CreditPackageAdminRequest") }),
      delete: operation({ id: "adminDeleteCreditPackage", tag: "管理积分", summary: "删除未被引用的积分套餐", security: true, parameters: [pathId("packageId", "积分套餐 ID")] }),
    },
    "/admin/credits/purchases": {
      get: operation({ id: "adminListCreditPurchases", tag: "管理积分", summary: "读取积分购买记录", security: true, parameters: [query("limit", "返回数量，1～200", { type: "integer", minimum: 1, maximum: 200 })] }),
      post: operation({ id: "adminCreateCreditPurchase", tag: "管理积分", summary: "手工创建积分购买记录", security: true, body: ref("CreditPurchaseAdminRequest") }),
    },
    "/admin/credits/purchases/{purchaseId}": {
      patch: operation({ id: "adminUpdateCreditPurchase", tag: "管理积分", summary: "更新积分购买记录", security: true, parameters: [pathId("purchaseId", "积分购买记录 ID")], body: ref("CreditPurchaseAdminRequest") }),
      delete: operation({ id: "adminDeleteCreditPurchase", tag: "管理积分", summary: "删除允许删除的积分购买记录", security: true, parameters: [pathId("purchaseId", "积分购买记录 ID")] }),
    },
    "/admin/credits/consumptions": {
      get: operation({ id: "adminListCreditConsumptions", tag: "管理积分", summary: "读取积分消耗记录", security: true, parameters: [query("limit", "返回数量，1～200", { type: "integer", minimum: 1, maximum: 200 })] }),
      post: operation({ id: "adminCreateCreditConsumption", tag: "管理积分", summary: "手工创建积分消耗记录", security: true, body: ref("CreditConsumptionAdminRequest") }),
    },
    "/admin/credits/consumptions/{consumptionId}": {
      patch: operation({ id: "adminUpdateCreditConsumption", tag: "管理积分", summary: "更新积分消耗记录", security: true, parameters: [pathId("consumptionId", "积分消耗记录 ID")], body: ref("CreditConsumptionAdminRequest") }),
      delete: operation({ id: "adminDeleteCreditConsumption", tag: "管理积分", summary: "删除积分消耗记录", security: true, parameters: [pathId("consumptionId", "积分消耗记录 ID")] }),
    },
    "/admin/users": {
      get: operation({ id: "adminUsers", tag: "管理查询", summary: "读取用户列表、积分、分润余额和上下级统计", description: "返回balance_fen（人民币分，含冻结）、commission_available_fen、commission_frozen_fen、parent（上级基本资料或null）、direct_count与indirect_count。人数包含停用账户，仅统计第一/第二级。需要users.read，响应禁止缓存。", security: true, parameters: [query("limit", "返回数量，1～200", { type: "integer", minimum: 1, maximum: 200 })] }),
    },
    "/admin/users/{userId}/relations": {
      get: operation({ id: "adminUserRelations", tag: "管理查询", summary: "查看用户上级及分页的直接/间接下级", description: "只读接口，需要users.read。返回user、parent（无上级为null）、direct_count、indirect_count、items、level、page、page_size=50、total、has_more。同一事务快照读取；停用账户也计入人数，间接只包含第二级。用户资料中不包含密码、令牌或支付宝收款资料。", security: true, parameters: [pathId("userId", "目标用户ID"), query("level", "下级层级，1直接/2间接，默认1", { type: "integer", enum: [1, 2], default: 1 }), query("page", "页码，默认1", { type: "integer", minimum: 1, maximum: 100000, default: 1 })] }),
    },
    "/admin/users/{userId}": {
      patch: operation({ id: "adminUpdateUser", tag: "管理查询", summary: "编辑用户资料和账号状态", security: true, parameters: [pathId("userId", "用户 ID")], body: ref("AdminUserUpdateRequest") }),
    },
    "/admin/users/{userId}/credit-adjustments": {
      post: operation({ id: "adminAdjustUserCredits", tag: "管理积分", summary: "人工增加或扣减用户积分", description: "创建不可变账本交易并同步写入审计日志；扣减后余额不能低于已占用积分。", security: true, parameters: [pathId("userId", "用户 ID")], body: ref("AdminCreditAdjustmentRequest") }),
    },
    "/admin/tasks": {
      get: operation({ id: "adminTasks", tag: "管理查询", summary: "读取模型任务元数据", security: true, parameters: [query("limit", "返回数量，1～200", { type: "integer", minimum: 1, maximum: 200 })] }),
    },
    "/admin/payments": {
      get: operation({ id: "adminPayments", tag: "管理查询", summary: "读取支付订单", security: true, parameters: [query("limit", "返回数量，1～200", { type: "integer", minimum: 1, maximum: 200 })] }),
    },
    "/admin/audit-logs": {
      get: operation({ id: "adminAuditLogs", tag: "管理查询", summary: "读取不可变审计日志", security: true, parameters: [query("limit", "返回数量，1～200", { type: "integer", minimum: 1, maximum: 200 })] }),
    },
  };

  return {
    openapi: "3.0.3",
    info: {
      title: "影匠 API",
      version: "1.0.0",
      description: [
        "影匠客户端、积分支付、模型转发与运营后台接口。",
        "",
        "用户和管理员均使用 Bearer JWT；在右上角 Authorize 中填入登录接口返回的 access_token。",
        "服务端不会在任务表中保存提示词、图片、音频、视频或完整模型结果。",
      ].join("\n"),
      contact: { name: "影匠" },
    },
    servers: [
      { url: "/api/v1", description: "当前服务" },
      { url: "http://localhost:3101/api/v1", description: "本机调试服务" },
    ],
    tags: [
      { name: "系统", description: "运行状态" },
      { name: "客户端配置", description: "客户端引导配置和模型目录" },
      { name: "用户身份", description: "邮箱/手机号注册登录和会话管理" },
      { name: "微信登录", description: "微信公众号带参二维码及关注/扫码事件登录" },
      { name: "用户资料", description: "当前用户资料" },
      { name: "用户积分", description: "套餐、余额和购买" },
      { name: "邀请与分润", description: "邀请关系、两级分润及提现申请" },
      { name: "管理分销", description: "配置、分润记录、提现审核与手动支付宝打款" },
      { name: "微信支付", description: "微信支付回调" },
      { name: "模型任务", description: "客户端与大模型供应商之间的创建/查询转发" },
      { name: "管理身份", description: "管理员登录和密码" },
      { name: "管理概览" }, { name: "管理配置" }, { name: "管理微信配置" },
      { name: "管理供应商" }, { name: "管理 API Key" }, { name: "管理模型" },
      { name: "模型测试" }, { name: "管理积分" }, { name: "管理查询" },
    ],
    paths,
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT", description: "用户或管理员登录接口返回的 access_token" },
      },
      schemas,
    },
  } as unknown as OpenAPIObject;
}
