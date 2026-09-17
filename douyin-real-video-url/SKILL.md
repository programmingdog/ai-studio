---
name: douyin-real-video-url
description: "Extract primary and alternative raw media CDN URLs from public Douyin share text or links by resolving short links and capturing browser-signed detail responses. Use when implementing, running, or troubleshooting Douyin video or image-post URL extraction; not for livestreams, profiles, or bypassing access controls."
---

# Douyin Real Video URL

Extract the media URL that Douyin's web player actually receives. Treat the URL as temporary: keep its full query string and do not present it as a permanent link.

## Choose the path

- For a one-off extraction, run the bundled script. It emits structured JSON and does not download the media.
- For an existing codebase, preserve its language and architecture; read [references/method.md](references/method.md) and port only the relevant stages.
- For debugging, use the failure signals in the reference before changing selectors or inventing a signing implementation.

## Run the bundled extractor

Requirements: Node.js 18+, the `playwright` package, and a Chromium browser installed by Playwright.

```bash
npm install playwright
npx playwright install chromium
node scripts/extract_douyin_url.js "复制的抖音分享文本或链接"
```

Optional flags:

```bash
node scripts/extract_douyin_url.js "<share text>" --timeout=45000 --raw
```

- `--timeout=<ms>` changes the browser capture deadline.
- `--raw` includes the captured `aweme_detail` object and may produce a large response.
- Set `DOUYIN_PROXY_SERVER` only when the user already has an authorized proxy. Optional credentials are `DOUYIN_PROXY_USERNAME` and `DOUYIN_PROXY_PASSWORD`.
- Set `DOUYIN_CHROMIUM_PATH` to a compatible Chrome/Chromium executable when Playwright's managed browser is unavailable.

Return the `direct_url` as the primary result and retain `alternatives` when the caller needs codec or resolution choices. For image posts, return `images` instead.

## Preserve these invariants

- Resolve `v.douyin.com` redirects first and extract the numeric `aweme_id`.
- Open `https://www.douyin.com/video/{aweme_id}` with a desktop Chromium user agent. Mobile headless contexts can load an incomplete security SDK.
- Let the page generate `a_bogus`/`X-Bogus`; capture the detail XHR response instead of reverse-engineering signatures.
- Warm the browser context on the Douyin home page before opening the video, then reload once if the first matching response is empty.
- Accept JSON carried as either `application/json` or `text/plain`.
- Prefer the highest-resolution candidate from `video.play_addr`, codec variants, and `video.bit_rate`; keep only the first CDN mirror for each rendition.
- Distinguish an explicit `filter_detail` unavailable message from repeated HTTP 200 responses with empty bodies, which usually indicates risk control.

## Safety and output handling

Operate only on public content the user is allowed to access. Do not attempt to bypass login, privacy settings, deleted-content controls, CAPTCHAs, or platform access restrictions.

Raw CDN URLs can expire or reject requests without browser-like headers. If building a download proxy, allowlist Douyin media hosts, preserve Range requests, set a Douyin Referer and desktop User-Agent, and never turn it into an arbitrary URL fetcher.
