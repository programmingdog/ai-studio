# 方法说明

## 结论

稳定方案不是手工拼详情接口或长期维护 `a_bogus` 算法，而是让抖音网页在真实 Chromium 环境中执行安全 SDK，再拦截网页自己发出的详情请求。真实媒体地址位于详情 JSON 的 `aweme_detail.video` 中。

完整链路：

```text
分享文本
  -> 提取 douyin.com URL
  -> 跟随 v.douyin.com 跳转并取得 aweme_id
  -> 访问抖音首页预热 Cookie
  -> 打开 www.douyin.com/video/{aweme_id}
  -> 捕获 detail XHR 的 JSON/text 响应
  -> 定位 aweme_detail
  -> 枚举并排序媒体地址
  -> 返回临时 CDN URL
```

## 1. 输入与短链还原

输入可能是干净 URL，也可能是包含口令、标题和链接的一整段分享文本。优先识别：

- `www.douyin.com/video/{id}`、`/note/{id}`、`/slides/{id}`
- 查询参数 `modal_id`、`aweme_id`、`item_id`、`item_ids`
- `www.iesdouyin.com/share/video/{id}` 等分享页
- `v.douyin.com/{token}` 短链，包括没有 scheme 的形式

对短链用桌面 User-Agent 发起 GET，关闭自动重定向，最多跟随约 8 跳。每一跳先从 `Location` 中解析 ID；没有 `Location` 时再检查 HTML 的 `window.location`、meta refresh、页面内 `/video/{id}` 或 `aweme_id`。相对跳转必须以当前 URL 为基址展开。

## 2. 浏览器采集

使用 Playwright Chromium，推荐设置：

- 桌面 Chrome User-Agent
- `1440x900` viewport、`zh-CN` locale、`Asia/Shanghai` timezone
- `Accept-Language: zh-CN,zh;q=0.9,en;q=0.8`
- 新建隔离 context，但复用 browser 进程
- 先打开 `https://www.douyin.com/`，等待约 2 秒，让页面写入 `ttwid`、`msToken` 等 Cookie
- 再打开 `https://www.douyin.com/video/{id}`

在导航前注册 `response` 监听器，匹配：

```text
/aweme/v1/web/aweme/detail/
/aweme/v2/web/aweme/detail/
/web/api/v2/aweme/iteminfo
```

不要只调用 `response.json()` 或只接受 `application/json`；部分有效响应标记为 `text/plain`。先读文本、判空，再 `JSON.parse`。首次没有有效 payload 且仍有足够超时时间时刷新一次，使请求携带已写入的 Cookie。

## 3. 定位详情对象

按以下常见结构寻找详情：

1. `payload.aweme_detail`
2. `payload.aweme_list[0]`
3. `payload.data[0]` 或 `payload.data.aweme_detail`
4. `payload.item_list[0]`

遍历兜底时，不要把仅含 `aweme_id` 的 `filter_detail` 当成作品详情。若 `filter_detail` 存在但 `aweme_detail` 为空，应返回“作品不可用”的明确错误，而不是生成一份字段全空的成功结果。

## 4. 提取和选择真实媒体地址

视频候选来源：

- `video.play_addr.url_list[0]`
- `video.play_addr_h264.url_list[0]`
- `video.play_addr_265.url_list[0]`
- 每个 `video.bit_rate[*].play_addr.url_list[0]`

`url_list` 通常只是同一份媒体的多个 CDN 镜像，因此每个 rendition 取第一个即可。按高度、宽度、文件大小降序排序，首项作为 `direct_url`；其余去重后作为 `alternatives`。必须保留完整查询串，不能自行删除参数。

图集作品从 `image_list` 提取每项的 `url_list[0]`，必要时依次降级到 `origin_cover` 和 `thumbnail`。

不要把 `download_addr` 必然等同于更优或“无水印”地址；以浏览器播放器实际使用的 `play_addr` 与 `bit_rate` 为准，并如实描述结果，不作去水印保证。

## 5. 下载与代理

直链具有时效性，并可能依赖请求上下文。直接下载时通常需要：

```http
User-Agent: <desktop Chrome UA>
Referer: https://www.douyin.com/
```

面向第三方调用方时，可在自己的服务端做受控代理并透传 `Range`、`Content-Range`、`Accept-Ranges`、`Content-Length`、`Content-Type`。代理必须：

- 只允许已确认的抖音媒体 CDN 主机或经过解析流程产生的 URL
- 对外部 URL 做签名并设置过期时间
- 禁止跟随到内网、环回、metadata 地址，防止 SSRF
- 不记录含临时令牌的完整 URL，或至少对查询串脱敏

## 6. 失败信号与处理

| 信号 | 含义 | 处理 |
| --- | --- | --- |
| `filter_detail` 且无详情 | 删除、私密、审核或不可见 | 作为终态返回，不绕过 |
| detail 请求 HTTP 200、body 为空 | 常见静默风控 | 刷新一次；仍失败则降低频率或换合规网络出口 |
| 完全没有 detail 请求 | 页面结构、安全 SDK、登录墙或选择器变化 | 记录最终 URL 和捕获到的请求路径，检查端点模式 |
| JSON 有详情但没有视频 | 可能是图集或结构变化 | 先检查 `image_list`，再保存脱敏样本更新提取器 |
| CDN 403 | 直链过期或缺少请求头 | 重新解析，保留完整查询串并带 Referer/UA |
| 云主机稳定失败、本地网络成功 | 机房 IP 风控 | 把浏览器采集放到获准的住宅/本地 worker，不要伪造成功 |

对临时错误采用有限次数、带退避的重试；对明确不可见错误不要重试。并发保持较低，避免无谓触发平台风控。
