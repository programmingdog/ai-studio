#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * Resolve a public Douyin share link and print the media CDN URL as JSON.
 * Requires Node.js 18+ and Playwright: npm install playwright && npx playwright install chromium
 */

const PC_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36';

const URL_PATTERNS = [
  /https?:\/\/(?:www\.)?(?:douyin|iesdouyin)\.com\/(?:video|note|slides)\/(\d{6,})[^\s]*/i,
  /https?:\/\/(?:www\.)?douyin\.com\/[^\s?#]*\?[^\s#]*(?:modal_id|aweme_id)=(\d{6,})[^\s]*/i,
  /https?:\/\/(?:www\.)?iesdouyin\.com\/share\/(?:video|note|slides)\/(\d{6,})[^\s]*/i,
  /https?:\/\/v\.douyin\.com\/[A-Za-z0-9_-]{4,}\/?[^\s]*/i,
  /(?:^|[\s(（【])v\.douyin\.com\/[A-Za-z0-9_-]{4,}\/?[^\s]*/i,
];

function usage() {
  return [
    'Usage: node extract_douyin_url.js "<Douyin share text or URL>" [--timeout=45000] [--raw]',
    '',
    'Environment: DOUYIN_CHROMIUM_PATH, DOUYIN_PROXY_SERVER, DOUYIN_PROXY_USERNAME, DOUYIN_PROXY_PASSWORD',
  ].join('\n');
}

function parseArgs(argv) {
  const opts = { timeout: 45000, raw: false, input: '' };
  const input = [];
  for (const arg of argv) {
    if (arg === '--raw') opts.raw = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg.startsWith('--timeout=')) {
      const n = Number(arg.slice('--timeout='.length));
      if (!Number.isFinite(n) || n < 10000 || n > 120000) {
        throw new Error('--timeout must be between 10000 and 120000 milliseconds');
      }
      opts.timeout = Math.floor(n);
    } else input.push(arg);
  }
  opts.input = input.join(' ').trim();
  return opts;
}

function trimPunctuation(value) {
  return value.replace(/[),.;!?，。；！？】）]+$/u, '');
}

function extractShareUrl(text) {
  const source = String(text || '').trim();
  if (!source) throw new Error('No Douyin share text or URL was provided');
  for (const re of URL_PATTERNS) {
    const match = source.match(re);
    if (!match) continue;
    let url = trimPunctuation(match[0].trim().replace(/^[\s(（【]+/, ''));
    if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
    return { url, awemeId: match[1] || null };
  }
  throw new Error('No supported Douyin URL was found in the input');
}

function parseAwemeId(value) {
  const source = String(value || '');
  const patterns = [
    /\/(?:video|note|slides)\/(\d{6,})/,
    /\/share\/(?:video|note|slides)\/(\d{6,})/,
    /[?&](?:modal_id|aweme_id|item_ids|item_id)=(\d{6,})/,
  ];
  for (const re of patterns) {
    const match = source.match(re);
    if (match) return match[1];
  }
  return null;
}

function pickUrlFromHtml(html) {
  const patterns = [
    /window\.location\.href\s*=\s*["']([^"']+)["']/i,
    /window\.location\.replace\(\s*["']([^"']+)["']/i,
    /<meta[^>]+http-equiv=["']refresh["'][^>]+content=["'][^;]*;\s*url=([^"']+)["']/i,
    /["'](https?:\/\/(?:www\.)?(?:douyin|iesdouyin)\.com\/[^"']+)["']/i,
  ];
  for (const re of patterns) {
    const match = html.match(re);
    if (match) return match[1].replace(/&amp;/g, '&');
  }
  return null;
}

async function resolveShare(input) {
  const extracted = extractShareUrl(input);
  if (extracted.awemeId) {
    return { awemeId: extracted.awemeId, shareUrl: extracted.url, resolvedUrl: extracted.url };
  }

  let current = extracted.url;
  for (let hop = 0; hop < 8; hop += 1) {
    const response = await fetch(current, {
      redirect: 'manual',
      headers: {
        'User-Agent': PC_UA,
        Accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9',
      },
      signal: AbortSignal.timeout(15000),
    });

    const location = response.headers.get('location');
    if (location && response.status >= 300 && response.status < 400) {
      current = new URL(location, current).toString();
      const awemeId = parseAwemeId(current);
      if (awemeId) return { awemeId, shareUrl: extracted.url, resolvedUrl: current };
      continue;
    }

    if (response.status === 200) {
      const html = await response.text();
      const next = pickUrlFromHtml(html);
      if (next) {
        current = new URL(next, current).toString();
        const awemeId = parseAwemeId(current);
        if (awemeId) return { awemeId, shareUrl: extracted.url, resolvedUrl: current };
        continue;
      }
      const inline = html.match(/["']?aweme_?id["']?\s*[:=]\s*["']?(\d{6,})/i) ||
        html.match(/\/video\/(\d{6,})/);
      if (inline) return { awemeId: inline[1], shareUrl: extracted.url, resolvedUrl: current };
    }
    break;
  }

  const awemeId = parseAwemeId(current);
  if (!awemeId) throw new Error('The share link did not resolve to a supported public work');
  return { awemeId, shareUrl: extracted.url, resolvedUrl: current };
}

function isDetailRequest(url) {
  return url.includes('/aweme/v1/web/aweme/detail/') ||
    url.includes('/aweme/v2/web/aweme/detail/') ||
    url.includes('/web/api/v2/aweme/iteminfo');
}

function findDetail(payload) {
  if (!payload || typeof payload !== 'object') return null;
  if (payload.aweme_detail) return payload.aweme_detail;
  if (Array.isArray(payload.aweme_list) && payload.aweme_list.length) return payload.aweme_list[0];
  if (Array.isArray(payload.data) && payload.data.length) return payload.data[0];
  if (payload.data && payload.data.aweme_detail) return payload.data.aweme_detail;
  if (Array.isArray(payload.item_list) && payload.item_list.length) return payload.item_list[0];
  for (const value of Object.values(payload)) {
    if (value && typeof value === 'object' && value.aweme_id && !value.filter_reason) return value;
  }
  return null;
}

function firstUrl(node) {
  if (!node) return null;
  if (typeof node === 'string' && node.startsWith('http')) return node;
  for (const key of ['url_list', 'download_url_list']) {
    if (!Array.isArray(node[key])) continue;
    const url = node[key].find((item) => typeof item === 'string' && item.startsWith('http'));
    if (url) return url;
  }
  return null;
}

function videoCandidates(detail) {
  const video = detail.video || {};
  const candidates = [];
  const seenUrls = new Set();

  function push(node, label, source, width, height, size) {
    const url = firstUrl(node);
    if (!url || seenUrls.has(url)) return;
    seenUrls.add(url);
    candidates.push({
      url,
      label,
      source,
      width: node.width || width || null,
      height: node.height || height || null,
      size: node.data_size || size || null,
    });
  }

  push(video.play_addr || {}, 'default', 'play_addr', video.width, video.height, null);
  push(video.play_addr_h264 || {}, 'H.264', 'play_addr_h264', video.width, video.height, null);
  push(video.play_addr_265 || {}, 'H.265', 'play_addr_265', video.width, video.height, null);

  for (const bitRate of Array.isArray(video.bit_rate) ? video.bit_rate : []) {
    const addr = bitRate.play_addr || {};
    push(
      addr,
      String(bitRate.gear_name || bitRate.quality_type || 'bit_rate'),
      'bit_rate',
      bitRate.width,
      bitRate.height,
      bitRate.data_size
    );
  }

  return candidates.sort((a, b) =>
    (b.height || 0) - (a.height || 0) ||
    (b.width || 0) - (a.width || 0) ||
    (b.size || 0) - (a.size || 0)
  );
}

function imageCandidates(detail) {
  return (Array.isArray(detail.image_list) ? detail.image_list : [])
    .map((image, index) => {
      const url = firstUrl(image) || firstUrl(image.origin_cover) || firstUrl(image.thumbnail);
      return url ? { index, url } : null;
    })
    .filter(Boolean);
}

function endpointWithoutQuery(value) {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch (_) {
    return null;
  }
}

async function waitForPayload(payloads, deadline) {
  while (!payloads.length && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

function defaultBrowserBase() {
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) return process.env.PLAYWRIGHT_BROWSERS_PATH;
  const home = os.homedir();
  if (process.platform === 'win32') return path.join(home, 'AppData', 'Local', 'ms-playwright');
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Caches', 'ms-playwright');
  return path.join(home, '.cache', 'ms-playwright');
}

function executableIn(directory) {
  const candidates = [
    ['chrome-win', 'chrome.exe'],
    ['chrome-win64', 'chrome.exe'],
    ['chrome-headless-shell-win64', 'chrome-headless-shell.exe'],
    ['chrome-linux', 'chrome'],
    ['chrome-linux64', 'chrome'],
    ['chrome-headless-shell-linux64', 'chrome-headless-shell'],
    ['chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'],
    ['chrome-mac-arm64', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'],
  ];
  for (const parts of candidates) {
    const candidate = path.join(directory, ...parts);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function browserRevision(name) {
  const match = name.match(/(\d+)$/);
  return match ? Number(match[1]) : 0;
}

function findBrowserExecutable() {
  const configured = process.env.DOUYIN_CHROMIUM_PATH ||
    process.env.PLAYWRIGHT_CHROMIUM_PATH ||
    process.env.CHROME_PATH;
  if (configured && fs.existsSync(configured)) return configured;

  const base = defaultBrowserBase();
  try {
    if (fs.existsSync(base)) {
      const directories = fs.readdirSync(base).filter((name) => name.startsWith('chromium'));
      const full = directories
        .filter((name) => name.startsWith('chromium-'))
        .sort((a, b) => browserRevision(b) - browserRevision(a));
      const shells = directories
        .filter((name) => name.includes('headless_shell'))
        .sort((a, b) => browserRevision(b) - browserRevision(a));
      for (const name of [...full, ...shells]) {
        const executable = executableIn(path.join(base, name));
        if (executable) return executable;
      }
    }
  } catch (_) {
    // Fall back to the browser revision expected by this Playwright package.
  }

  const systemCandidates = process.platform === 'win32'
    ? [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      ]
    : process.platform === 'darwin'
      ? [
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
          '/Applications/Chromium.app/Contents/MacOS/Chromium',
        ]
      : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  for (const candidate of systemCandidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

async function captureDetail(awemeId, timeout) {
  let chromium;
  try {
    ({ chromium } = require('playwright'));
  } catch (_) {
    throw new Error('Playwright is not installed. Run: npm install playwright && npx playwright install chromium');
  }

  const launchOptions = {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--lang=zh-CN',
    ],
  };
  const executablePath = findBrowserExecutable();
  if (executablePath) launchOptions.executablePath = executablePath;
  if (process.env.DOUYIN_PROXY_SERVER) {
    launchOptions.proxy = { server: process.env.DOUYIN_PROXY_SERVER };
    if (process.env.DOUYIN_PROXY_USERNAME) launchOptions.proxy.username = process.env.DOUYIN_PROXY_USERNAME;
    if (process.env.DOUYIN_PROXY_PASSWORD) launchOptions.proxy.password = process.env.DOUYIN_PROXY_PASSWORD;
  }

  const browser = await chromium.launch(launchOptions);
  const context = await browser.newContext({
    userAgent: PC_UA,
    viewport: { width: 1440, height: 900 },
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    extraHTTPHeaders: { 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' },
  });
  const payloads = [];
  let emptyHits = 0;
  let finalUrl = null;

  try {
    const page = await context.newPage();
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
      Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh'] });
    });

    page.on('response', async (response) => {
      if (!isDetailRequest(response.url())) return;
      try {
        const contentType = String(response.headers()['content-type'] || '').toLowerCase();
        if (!contentType.includes('json') && !contentType.includes('text')) return;
        const body = await response.text();
        if (!body.trim()) {
          emptyHits += 1;
          return;
        }
        payloads.push({ url: response.url(), status: response.status(), json: JSON.parse(body) });
      } catch (_) {
        emptyHits += 1;
      }
    });

    try {
      await page.goto('https://www.douyin.com/', {
        waitUntil: 'domcontentloaded',
        timeout: Math.min(timeout, 15000),
      });
      await page.waitForTimeout(2000);
    } catch (_) {
      // Home-page warming is best effort.
    }

    const deadline = Date.now() + timeout;
    await page.goto(`https://www.douyin.com/video/${awemeId}`, {
      waitUntil: 'domcontentloaded',
      timeout: Math.max(5000, deadline - Date.now()),
    });
    finalUrl = page.url();
    await waitForPayload(payloads, deadline);

    if (!payloads.length && deadline - Date.now() > 8000) {
      try {
        await page.reload({
          waitUntil: 'domcontentloaded',
          timeout: Math.min(20000, deadline - Date.now()),
        });
      } catch (_) {
        // The response listener can still capture a usable payload after a navigation timeout.
      }
      await waitForPayload(payloads, deadline);
    }

    let unavailable = null;
    for (const payload of payloads) {
      if (payload.json && payload.json.filter_detail && !payload.json.aweme_detail) {
        const filter = payload.json.filter_detail;
        unavailable = filter.detail_msg || filter.notice || 'The work is unavailable';
      }
      const detail = findDetail(payload.json);
      if (detail && (detail.video || detail.image_list)) {
        return { detail, sourceUrl: payload.url, emptyHits, finalUrl };
      }
    }

    if (unavailable) throw new Error(`Douyin reports that this work is unavailable: ${unavailable}`);
    if (emptyHits) {
      throw new Error(`Detail requests returned empty or invalid bodies ${emptyHits} time(s); risk control is likely`);
    }
    throw new Error(`No usable detail response was captured; final page: ${finalUrl || 'unknown'}`);
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (!opts.input) throw new Error(usage());

  const resolved = await resolveShare(opts.input);
  const captured = await captureDetail(resolved.awemeId, opts.timeout);
  const detail = captured.detail;
  const videos = videoCandidates(detail);
  const images = imageCandidates(detail);
  const type = videos.length ? 'video' : images.length ? 'images' : 'unknown';

  const output = {
    ok: true,
    type,
    aweme_id: String(detail.aweme_id || resolved.awemeId),
    title: detail.desc || detail.title || '',
    share_url: resolved.shareUrl,
    resolved_url: resolved.resolvedUrl,
    detail_source: endpointWithoutQuery(captured.sourceUrl),
    direct_url: videos[0] ? videos[0].url : null,
    primary: videos[0] || null,
    alternatives: videos.slice(1),
    images,
    download_headers: {
      'User-Agent': PC_UA,
      Referer: 'https://www.douyin.com/',
    },
    note: 'CDN URLs are temporary; preserve the complete query string and re-extract after expiry.',
  };
  if (opts.raw) output.raw_aweme_detail = detail;
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ ok: false, error: error.message })}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  extractShareUrl,
  parseAwemeId,
  findDetail,
  videoCandidates,
  imageCandidates,
};
