const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const source = fs.readFileSync(path.join(__dirname, '../src/components/EmailRegistrationVerification.tsx'), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const flush = () => new Promise(resolve => setImmediate(resolve));

function harness(overrides = {}, propsOverride = {}) {
  const cells = [], effects = [], calls = [];
  const document = { body: {}, activeElement: null };
  let cursor = 0, tree;
  class PlatformApiError extends Error { constructor(message, status, details) { super(message); this.status = status; this.details = details; } }
  const api = {
    PlatformApiError,
    async createRegistrationCaptcha(email) { calls.push(['create', email]); return { captcha_id: 'test-image', image_data_url: 'data:image/svg+xml;base64,PHN2Zy8+', expires_in: 300 }; },
    async verifyRegistrationCaptcha(input) { calls.push(['verify', input]); return { captcha_token: 'test-proof', expires_in: 120 }; },
    async sendRegistrationEmailCode(input) { calls.push(['send', input]); return { sent: true, expires_in: 600, retry_after_seconds: 60 }; },
    ...overrides,
  };
  const props = { email: 'test@example.com', credentialsValid: true, code: '', disabled: false, onCodeChange(value) { props.code = value; }, onBusyChange(value) { props.busy = value; }, ...propsOverride };
  const module = { exports: {} };
  const mockRequire = name => name === 'react' ? {
    useState(initial) { const slot = cursor++; if (!(slot in cells)) cells[slot] = typeof initial === 'function' ? initial() : initial; return [cells[slot], next => { cells[slot] = typeof next === 'function' ? next(cells[slot]) : next; }]; },
    useRef(initial) { const slot = cursor++; if (!(slot in cells)) cells[slot] = { current: initial }; return cells[slot]; },
    useEffect(callback, deps) {
      const slot = cursor++, previous = cells[slot];
      if (!previous || !deps || deps.some((value, index) => !Object.is(value, previous.deps[index]))) {
        cells[slot] = { deps, cleanup: previous?.cleanup };
        effects.push(() => { cells[slot].cleanup?.(); cells[slot].cleanup = callback(); });
      }
    },
  } : name === 'react-dom' ? { createPortal(children, container) { return { type: 'portal', props: { children }, container }; } }
    : name === '../services/platform' ? api : require(name);
  new Function('require', 'module', 'exports', 'window', 'document', compiled)(mockRequire, module, module.exports, { setInterval() {}, clearInterval() {} }, document);
  function render() { cursor = 0; tree = module.exports.EmailRegistrationVerification(props); while (effects.length) effects.shift()(); }
  function nodes(node = tree) { if (!node || typeof node !== 'object') return []; if (Array.isArray(node)) return node.flatMap(nodes); return [node, ...nodes(node.props?.children ?? null)]; }
  function button(label) { return nodes().find(node => node.type === 'button' && JSON.stringify(node.props.children).includes(label)); }
  const input = id => nodes().find(node => node.type === 'input' && node.props.id === id);
  const clickSend = async () => { button('发送邮箱验证码').props.onClick(); await flush(); render(); };
  const enterAnswer = () => { input('registration-captcha-answer').props.onChange({ target: { value: 'ABCDE' } }); render(); };
  render();
  return { props, api, calls, document, render, nodes, button, input, clickSend, enterAnswer, unmount() { cells.forEach(cell => cell?.cleanup?.()); } };
}

test('image challenge opens in a body portal with an accessible modal dialog', async () => {
  const h = harness();
  assert.equal(h.nodes().find(x => x.props?.role === 'dialog'), undefined);
  await h.clickSend();
  const portal = h.nodes().find(x => x.type === 'portal');
  assert.equal(portal.container, h.document.body);
  const dialog = h.nodes(portal).find(x => x.props?.role === 'dialog');
  assert.equal(dialog.props['aria-modal'], 'true');
  assert.equal(dialog.props['aria-labelledby'], 'registration-captcha-title');
  assert.equal(dialog.props['aria-describedby'], 'registration-captcha-description');
  assert.ok(h.nodes(dialog).find(x => x.type === 'img'));
  assert.ok(h.nodes(dialog).includes(h.input('registration-captcha-answer')));
  assert.equal(h.button('发送邮箱验证码').props.disabled, true);
});

test('loading dialog can be cancelled and ignores a late challenge after reopening', async () => {
  let resolveFirst;
  const h = harness();
  const originalCreate = h.api.createRegistrationCaptcha;
  h.api.createRegistrationCaptcha = () => new Promise(resolve => { resolveFirst = resolve; });
  h.button('发送邮箱验证码').props.onClick(); h.render();
  assert.ok(h.nodes().find(x => x.props?.role === 'dialog'));
  assert.match(h.nodes().find(x => x.props?.role === 'status').props.children.join(''), /正在加载/);
  h.button('取消').props.onClick(); h.render();
  assert.equal(h.props.busy, false);
  assert.equal(h.nodes().find(x => x.props?.role === 'dialog'), undefined);
  h.api.createRegistrationCaptcha = originalCreate;
  await h.clickSend(); h.enterAnswer();
  resolveFirst({ captcha_id: 'stale-image', image_data_url: 'stale' }); await flush(); h.render();
  assert.equal(h.input('registration-captcha-answer').props.value, 'ABCDE');
  h.button('验证并发送').props.onClick(); await flush(); h.render();
  assert.equal(h.calls.find(x => x[0] === 'verify')[1].captcha_id, 'test-image');
});

test('cancelling pending image validation prevents a mail request and clears the answer', async () => {
  let resolveProof;
  const h = harness({ verifyRegistrationCaptcha: () => new Promise(resolve => { resolveProof = resolve; }) });
  await h.clickSend(); h.enterAnswer(); h.button('验证并发送').props.onClick(); h.render();
  h.button('取消').props.onClick(); h.render();
  resolveProof({ captcha_token: 'cancelled-proof' }); await flush(); h.render();
  assert.equal(h.calls.filter(x => x[0] === 'send').length, 0);
  assert.equal(h.props.busy, false);
  assert.equal(h.nodes().find(x => x.props?.role === 'dialog'), undefined);
  await h.clickSend();
  assert.equal(h.input('registration-captcha-answer').props.value, '');
});

test('Escape, the close button and backdrop dismiss the dialog without sending', async () => {
  const h = harness();
  await h.clickSend();
  h.nodes().find(x => x.props?.role === 'dialog').props.onKeyDown({ key: 'Escape', preventDefault() {}, stopPropagation() {} });
  h.render(); assert.equal(h.nodes().find(x => x.props?.role === 'dialog'), undefined);
  await h.clickSend();
  h.nodes().find(x => x.props?.['aria-label'] === '关闭图形验证').props.onClick();
  h.render(); assert.equal(h.nodes().find(x => x.props?.role === 'dialog'), undefined);
  await h.clickSend();
  const backdrop = h.nodes().find(x => x.props?.className === 'modal-backdrop registration-captcha-backdrop');
  backdrop.props.onMouseDown({ target: {}, currentTarget: {}, stopPropagation() {} });
  h.render(); assert.ok(h.nodes().find(x => x.props?.role === 'dialog'));
  const target = {};
  backdrop.props.onMouseDown({ target, currentTarget: target, stopPropagation() {} });
  h.render(); assert.equal(h.nodes().find(x => x.props?.role === 'dialog'), undefined);
  assert.equal(h.calls.filter(x => x[0] === 'send').length, 0);
});

test('dialog traps keyboard focus and Enter validates without submitting registration', async () => {
  const h = harness(); await h.clickSend(); h.enterAnswer();
  let focus, prevented = 0;
  const first = { focus() { focus = 'first'; } }, last = { focus() { focus = 'last'; } };
  const currentTarget = { querySelectorAll() { return [first, last]; } };
  const dialog = h.nodes().find(x => x.props?.role === 'dialog');
  h.document.activeElement = last;
  dialog.props.onKeyDown({ key: 'Tab', currentTarget, stopPropagation() {}, preventDefault() { prevented++; } });
  assert.equal(focus, 'first');
  h.document.activeElement = first;
  dialog.props.onKeyDown({ key: 'Tab', shiftKey: true, currentTarget, stopPropagation() {}, preventDefault() { prevented++; } });
  assert.equal(focus, 'last');
  h.input('registration-captcha-answer').props.onKeyDown({ key: 'Enter', preventDefault() { prevented++; } });
  await flush(); h.render();
  assert.equal(prevented, 3);
  assert.equal(h.calls.filter(x => x[0] === 'send').length, 1);
  assert.equal(h.nodes().find(x => x.props?.role === 'dialog'), undefined);
});

test('a loading failure stays in the dialog and offers retry without sending mail', async () => {
  const h = harness(); const originalCreate = h.api.createRegistrationCaptcha;
  h.api.createRegistrationCaptcha = async () => { throw new Error('验证码加载失败'); };
  await h.clickSend();
  const dialog = h.nodes().find(x => x.props?.role === 'dialog');
  assert.match(h.nodes(dialog).find(x => x.props?.role === 'alert').props.children, /加载失败/);
  h.api.createRegistrationCaptcha = originalCreate;
  h.button('重新加载验证码').props.onClick(); await flush(); h.render();
  assert.ok(h.input('registration-captcha-answer'));
  assert.equal(h.nodes().find(x => x.props?.role === 'alert'), undefined);
  assert.equal(h.calls.filter(x => x[0] === 'send').length, 0);
});

test('sending keeps a busy dialog until completion and prevents closing or duplicate sends', async () => {
  let resolveSend, sends = 0;
  const h = harness({ sendRegistrationEmailCode: () => { sends++; return new Promise(resolve => { resolveSend = resolve; }); } });
  await h.clickSend(); h.enterAnswer(); h.button('验证并发送').props.onClick(); await flush(); h.render();
  const dialog = h.nodes().find(x => x.props?.role === 'dialog');
  assert.equal(dialog.props['aria-busy'], true);
  assert.equal(h.button('取消').props.disabled, true);
  dialog.props.onKeyDown({ key: 'Escape', preventDefault() {}, stopPropagation() {} });
  h.button('取消').props.onClick(); h.render();
  assert.ok(h.nodes().find(x => x.props?.role === 'dialog'));
  assert.equal(sends, 1);
  resolveSend({ sent: true, expires_in: 600, retry_after_seconds: 60 }); await flush(); h.render();
  assert.equal(h.nodes().find(x => x.props?.role === 'dialog'), undefined);
  assert.match(h.nodes().find(x => x.props?.role === 'status').props.children, /验证码已发送/);
});

test('email sending starts with image challenge only and requires valid credentials', async () => {
  const h = harness({}, { credentialsValid: false });
  assert.equal(h.button('发送邮箱验证码').props.disabled, true);
  h.button('发送邮箱验证码').props.onClick(); await flush(); assert.equal(h.calls.length, 0);
  h.props.credentialsValid = true; h.render(); await h.clickSend();
  assert.deepEqual(h.calls.map(x => x[0]), ['create']);
  assert.equal(h.nodes().filter(x => x.type === 'img').length, 1);
  assert.equal(h.button('验证并发送').props.disabled, true);
});

test('failed image verification never sends email and reports the API error', async () => {
  const h = harness({ async verifyRegistrationCaptcha() { throw new Error('图形验证码错误'); } });
  await h.clickSend(); h.enterAnswer(); h.button('验证并发送').props.onClick(); await flush(); h.render();
  assert.equal(h.calls.filter(x => x[0] === 'send').length, 0);
  assert.match(h.nodes().find(x => x.props?.role === 'alert').props.children, /图形验证码错误/);
  assert.equal(h.props.busy, false);
});

test('verified proof is sent once, duplicate clicks are blocked and a resend countdown appears', async () => {
  let resolveProof;
  const h = harness({ verifyRegistrationCaptcha: () => new Promise(resolve => { resolveProof = resolve; }) }, { code: '654321' });
  await h.clickSend(); h.enterAnswer();
  h.button('验证并发送').props.onClick(); h.button('验证并发送').props.onClick(); h.render();
  assert.equal(h.props.busy, true); assert.equal(h.calls.length, 1);
  resolveProof({ captcha_token: 'accepted-proof' }); await flush(); h.render();
  assert.deepEqual(h.calls[1], ['send', { email: 'test@example.com', captcha_token: 'accepted-proof' }]);
  assert.equal(h.calls.filter(x => x[0] === 'send').length, 1);
  assert.equal(h.props.code, ''); assert.equal(h.props.busy, false);
  assert.equal(h.button('秒后重发').props.disabled, true);
  assert.equal(h.nodes().filter(x => x.type === 'img').length, 0);
  assert.match(h.nodes().find(x => x.props?.role === 'status').props.children, /10 分钟内有效/);
});

test('send failure discards the used proof and allows a new image challenge', async () => {
  const h = harness({ async sendRegistrationEmailCode() { throw new Error('邮件发送失败'); } });
  await h.clickSend(); h.enterAnswer(); h.button('验证并发送').props.onClick(); await flush(); h.render();
  assert.equal(h.nodes().filter(x => x.type === 'img').length, 0);
  assert.match(h.nodes().find(x => x.props?.role === 'alert').props.children, /邮件发送失败/);
  await h.clickSend(); assert.equal(h.calls.filter(x => x[0] === 'create').length, 2);
});

test('unconfirmed mail shows a neutral receipt instruction, allows code entry and enforces resend cooldown', async () => {
  const h = harness(); let attempts = 0;
  h.api.sendRegistrationEmailCode = async () => { attempts++; throw new h.api.PlatformApiError('结果未确认', 503, { code: 'MAIL_HTTP_DELIVERY_UNCONFIRMED', delivery_status: 'UNCERTAIN', retry_after_seconds: 60 }); };
  await h.clickSend(); h.enterAnswer(); h.button('验证并发送').props.onClick(); await flush(); h.render();
  assert.equal(attempts, 1); assert.equal(h.props.busy, false);
  assert.equal(h.nodes().find(x => x.props?.role === 'alert'), undefined);
  const notice = h.nodes().find(x => x.props?.role === 'status');
  assert.match(notice.props.children, /已收到本次验证码，可直接填写并注册/);
  assert.doesNotMatch(notice.props.className, /settings-success/);
  assert.equal(h.input('registration-email-code').props.disabled, false);
  h.input('registration-email-code').props.onChange({ target: { value: '012345' } }); assert.equal(h.props.code, '012345');
  assert.equal(h.button('秒后重发').props.disabled, true);
  assert.equal(h.nodes().filter(x => x.type === 'img').length, 0);
  h.button('秒后重发').props.onClick(); await flush(); assert.equal(attempts, 1);
});

test('429 response respects the server cooldown and code entry accepts six digits only', async () => {
  const h = harness();
  h.api.createRegistrationCaptcha = async () => { throw new h.api.PlatformApiError('请稍后重试', 429, { retry_after_seconds: 120 }); };
  await h.clickSend();
  assert.equal(h.button('秒后重发').props.disabled, true);
  h.input('registration-email-code').props.onChange({ target: { value: 'a0123459' } });
  assert.equal(h.props.code, '012345');
});

test('unmounting during image validation prevents a later mail request', async () => {
  let resolveProof;
  const h = harness({ verifyRegistrationCaptcha: () => new Promise(resolve => { resolveProof = resolve; }) });
  await h.clickSend(); h.enterAnswer(); h.button('验证并发送').props.onClick();
  h.unmount(); resolveProof({ captcha_token: 'proof' }); await flush();
  assert.equal(h.calls.filter(x => x[0] === 'send').length, 0);
});

test('account submission includes email_code and email changes discard stale state', () => {
  const account = fs.readFileSync(path.join(__dirname, '../src/components/UnifiedAuthPanel.tsx'), 'utf8');
  assert.match(account, /registerPlatformEmail\(\{[^}]*email_code: emailCode/);
  assert.match(account, /key=\{normalized\}/);
  assert.match(account, /setEmail\(event.target.value\); setEmailState\("idle"\); setEmailCode\(""\)/);
});
