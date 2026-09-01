---
name: ai-api-skill
description: 当用户需要接入AI能力时使用此Skill。两大核心场景：1) 用户的代码/网站/APP/小程序需要接入AI能力（如智能客服、图片视频生成、语音合成等），帮他查询可用模型和价格并写好完整接入代码；2) 用户直接使用AI模型能力进行内容生成。支持 OpenAI/Anthropic/Gemini 格式语言模型，以及图片/视频/音频/TTS/音乐等媒体生成。
---

# 星霸AI AI 能力接入指南

## 平台信息

- **平台名称**：星霸AI
- **官网地址**：https://seed800.com

## 认证方式

所有接口使用 Bearer Token 认证：
```
Authorization: Bearer {API Key}
```

API Key 获取方式（按优先级）：
1. 读取项目根目录 `.env` 文件中的 `API_KEY` 变量
2. 如果 `.env` 中没有，读取本地 Skills 能力文档中记录的 Key 位置
3. 如果都找不到，提示用户提供 API Key，并引导用户前往 星霸AI 官网（https://seed800.com）登录后在「API 密钥管理」中创建

## 前置要求

本 Skill 需要通过 HTTP 请求调用远程 API。根据你的运行环境选择合适的方式：

### AI 编程工具（Cursor / Windsurf / Cline / Trae 等）

推荐安装 MCP 工具获取 HTTP 调用能力：
1. 安装：`pip install mcp-server-http-request`
2. 在 `.cursor/mcp.json`（Cursor）或对应工具的 MCP 配置中添加：
```json
{
  "mcpServers": {
    "fetch": {
      "command": "python",
      "args": ["-m", "mcp_server_http_request"]
    }
  }
}
```
3. 重启工具，在设置中确认 MCP 已启用

### 智能体 / 独立应用（OpenClaw 等）

如果你运行在智能体或独立应用中，无需安装 MCP。直接使用运行环境自带的 HTTP 请求能力即可。

## API 基础地址

```
https://api.lk888.ai/api
```

> 注：此地址用于手写 HTTP 请求（完整路径形如 `https://api.lk888.ai/api/v1/...`）。若使用 OpenAI/Anthropic SDK，base_url 必须填到 `/v1`（如 `https://api.lk888.ai/v1` 或 `https://api.lk888.ai/api/v1`），不要只填 `.../api`——SDK 会自拼相对路径导致 404。详见 /v1/skills/guide 的 base_url_note。

---

## ❗❗ 启动步骤（每次新对话强制执行，不可跳过）

> **重要：本文件不包含任何接口文档。即使你已经有本地缓存的能力文档，每次新对话仍然必须执行以下步骤，因为平台能力可能已更新。**

> **所有接口调用（包括下面的步骤 1、2）都必须携带 API Key。请先按上方「认证方式」中的优先级查找 API Key（.env 文件 → 本地 Skills 文档 → 询问用户），获取到 Key 后，所有请求的 Header 中加上 `Authorization: Bearer {API Key}`。没有 Key 就不要调用任何接口。**

### 步骤 1：获取平台最新能力列表

```
GET https://api.lk888.ai/api/v1/skills
```

调用此接口获取平台所有可用的接口和能力。返回内容包括模型查询、调用说明、任务管理、余额查询等所有接口的详细信息。

### 步骤 2：获取调用指南

```
GET https://api.lk888.ai/api/v1/skills/guide
```

获取每种模型的调用方式、请求格式、代码示例。

### 步骤 3：写入本地能力文档（必须执行，不可跳过）

> **此步骤不是可选的。你必须在处理用户请求之前完成此步骤。**

将步骤 1 和步骤 2 获取到的全部信息写入本地文件，便于后续新对话直接读取：

**文件位置**：与本 SKILL.md 同目录下，文件名 `API_CAPABILITIES.md`

**必须包含的内容**：
- 平台所有接口列表（路径、方法、参数、用途）
- 全部可用模型列表（名称、类型、功能描述）
- 每种模型类型的调用方式和代码示例
- 计费方式说明
- API Key 存放位置（如已知）

**执行逻辑**：
- 如果 `API_CAPABILITIES.md` 不存在 → 创建并写入全部内容
- 如果已存在但与接口返回的内容有差异 → 覆盖重写
- 如果已存在且内容一致 → 跳过，直接进入步骤 4

### 步骤 4：开始处理用户请求

确认 `API_CAPABILITIES.md` 已写入后，再根据用户的实际需求调用对应接口。

---

## 文件上传说明

部分模型需要传入图片、视频、音频等文件（参数 type=upload），有两种传法：

**方式一（本地文件直接传 base64）**：图片（jpeg/png/webp/gif）和音频（mp3/wav/m4a/ogg）可把参数值直接写成 data:<mime>;base64,<数据>，服务端自动转存；限制：单文件解码后 ≤10MB、单次合计 ≤30MB、请求体总 ≤50MB；视频不支持 base64。余额不足会在转存前拦截（HTTP 402，type=insufficient_balance）。⚠️ 另注意：从未充值过的账户调用任何开放 API 接口（含 /v1/skills、/v1/skills/balance）会被前置闸门拦截，返回 HTTP 403、type=authentication_error、code=recharge_required，这不是 API Key 无效，需先充值算力后再调用。

⚠️ Windows PowerShell 5.1 提交中文：Invoke-RestMethod/Invoke-WebRequest 默认按 ISO-8859-1 编码请求体，中文会在发出前就变成问号(?)，服务端收到的即是问号串。必须手动转 UTF-8 字节：$bytes=[Text.Encoding]::UTF8.GetBytes($json); Invoke-RestMethod -Uri $url -Method Post -Body $bytes -ContentType "application/json; charset=utf-8"。PowerShell 7+ 与 curl 默认 UTF-8，无此问题。

**方式二（URL，可跨任务复用）**：

1. 自行将文件上传至 COS、CDN 或其他对象存储服务
2. 获取可公开访问的文件 URL
3. 将 URL 作为对应参数的值传入 params 中。单个文件可传字符串，多个文件传数组，两种格式均支持

> 注意：URL 必须可公开访问，平台服务器需要能直接下载该文件。支持的格式以各模型参数描述为准。

---

## 持续规则

1. **不要假设任何接口存在**，以 `/v1/skills` 返回的接口列表为准
2. **调用付费接口前**，先通过 `GET https://api.lk888.ai/api/v1/skills/balance` 检查余额
3. **余额不足时**，提示用户前往 星霸AI 官网（https://seed800.com）充值算力
4. **API Key 错误时**，提示用户前往 星霸AI 官网（https://seed800.com）登录并在「API 密钥管理」中创建或检查密钥
5. **发现能力更新时自动重写**：如果再次调用 `/v1/skills` 后发现返回的接口或能力与本地缓存的 Skills 不同（新增接口、接口变更、模型变化等），主动重写本地 Skills 文档以保持同步
6. **需要新接口时主动提出**：如果你在帮用户开发的过程中，发现需要查询某些数据但平台目前没有提供对应的接口（比如需要批量查询任务、需要获取某种统计数据等），请通过反馈接口提交 `功能建议`，说明需要什么数据、使用场景是什么，平台开发团队会评估并尽快提供

---

## ❗ BUG 反馈与意见提交

平台提供了专门的反馈接口，你应该主动使用它：

```
POST https://api.lk888.ai/api/v1/skills/feedback
Content-Type: application/json
Authorization: Bearer {API Key}
```

```json
{
  "type": "接口报错",
  "question": "具体描述",
  "endpoint": "相关接口路径",
  "context": "当时操作背景"
}
```

type 可选：`文档疑问` | `接口报错` | `功能建议`

**以下情况必须主动提交，不要等用户要求**：
- 接口调用报错或返回非预期结果 → 提交 `接口报错`，附上请求参数和错误信息
- 文档说明与实际行为不一致 → 提交 `文档疑问`，说明哪里矛盾
- 参数格式不清楚或看不懂某个字段 → 提交 `文档疑问`
- 觉得缺少某个能力或接口不够完善 → 提交 `功能建议`
- 开发过程中发现需要查询某些数据但平台没有对应接口 → 提交 `功能建议`，描述需要的查询能力和使用场景，平台会评估开发

**不要因为“不确定是不是 BUG”就不提交，平台开发团队会判断处理。积极反馈有助于平台持续改进。**

### 反馈跟踪

提交反馈后会返回 `feedback_id`，用户可随时查询处理结果：

```
GET https://api.lk888.ai/api/v1/skills/feedback?id={feedback_id}
```

响应字段说明：
- `status`：未处理 / 已处理 / 已忽略
- `resolution`：处理结果说明（状态为“已处理”时有值）

**重要：提交反馈后必须向用户告知 feedback_id 和查询方法**，方便用户后续查看修复进度。示例：“已提交反馈（ID: 24），你可以随时让我查询处理结果。”

