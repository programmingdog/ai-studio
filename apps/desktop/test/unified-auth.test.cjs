const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const source = fs.readFileSync(path.join(__dirname, '../src/components/UnifiedAuthPanel.tsx'), 'utf8');
const compiled = ts.transpileModule(source.replaceAll('import.meta.env.DEV', 'false'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const flush = () => new Promise(resolve => setImmediate(resolve));

function harness(overrides = {}) {
  const cells = [], effects = [], calls = [];
  let cursor = 0, tree;
  const api = {
    async getClientAuthMethods() { return { email_enabled: true, phone_otp_enabled: false, phone_otp_available: false, wechat_enabled: true }; },
    async checkRegistrationEmail(email) { calls.push(['check', email]); return { email, registered: false }; },
    async loginPlatform(input) { calls.push(['login', input]); return { user: { id: 'known' } }; },
    async registerPlatformEmail(input) { calls.push(['register', input]); return { user: { id: 'new' } }; },
    ...overrides,
  };
  const mockRequire = name => name === 'react' ? {
    useState(initial) { const slot = cursor++; if (!(slot in cells)) cells[slot] = initial; return [cells[slot], next => { cells[slot] = typeof next === 'function' ? next(cells[slot]) : next; }]; },
    useRef(initial) { const slot = cursor++; if (!(slot in cells)) cells[slot] = { current: initial }; return cells[slot]; },
    useEffect(callback, deps) { const slot = cursor++, previous = cells[slot]; if (!previous || deps.some((v, i) => !Object.is(v, previous.deps[i]))) { cells[slot] = { deps, cleanup: previous?.cleanup }; effects.push(() => { cells[slot].cleanup?.(); cells[slot].cleanup = callback(); }); } },
  } : name === '@tanstack/react-query' ? {
    useMutation(options) {
      const slot = cursor++;
      if (!(slot in cells)) cells[slot] = { isPending: false, error: null };
      const state = cells[slot];
      state.reset = () => { state.error = null; };
      state.mutate = () => {
        state.isPending = true;
        Promise.resolve().then(options.mutationFn).then(options.onSuccess).catch(error => { state.error = error; }).finally(() => { state.isPending = false; options.onSettled?.(); });
      };
      return state;
    },
  } : name === '../services/platform' ? api : name === './EmailRegistrationVerification' ? { EmailRegistrationVerification: 'EmailVerification' }
    : name === './WechatLoginDialog' ? { WechatIcon: 'WechatIcon', WechatLoginDialog: 'WechatDialog' } : require(name);
  const module = { exports: {} };
  new Function('require', 'module', 'exports', compiled)(mockRequire, module, module.exports);
  const props = { async onAuthenticated(result) { calls.push(['accepted', result.user.id]); } };
  function render() { cursor = 0; tree = module.exports.UnifiedAuthPanel(props); while (effects.length) effects.shift()(); }
  function nodes(node = tree) { if (!node || typeof node !== 'object') return []; if (Array.isArray(node)) return node.flatMap(nodes); return [node, ...nodes(node.props?.children ?? null)]; }
  const input = type => nodes().find(node => node.type === 'input' && node.props.type === type);
  const button = label => nodes().find(node => node.type === 'button' && JSON.stringify(node.props.children).includes(label));
  const editEmail = value => { input('email').props.onChange({ target: { value } }); render(); };
  const blur = async () => { input('email').props.onBlur(); render(); await flush(); render(); };
  const password = () => { input('password').props.onChange({ target: { value: 'Password123' } }); render(); };
  const submit = () => nodes().find(node => node.type === 'form').props.onSubmit({ preventDefault() {} });
  render();
  return { api, calls, render, nodes, input, button, editEmail, blur, password, submit, async ready() { await flush(); render(); }, unmount() { cells.forEach(cell => cell?.cleanup?.()); } };
}

test('default view is email login with no registration tabs and a WeChat button below the form', async () => {
  const h = harness(); await h.ready();
  assert.ok(h.button('登录')); assert.ok(h.button('微信登录'));
  assert.equal(h.nodes().filter(x => x.type === 'input').length, 2);
  assert.equal(h.nodes().find(x => x.type === 'EmailVerification'), undefined);
  assert.doesNotMatch(source, /手机注册|auth-tabs|registerPlatformPhone/);
  assert.ok(source.indexOf('wechat-login-entry') > source.indexOf('</form>'));
});

test('email is checked only on blur; new addresses expand registration below password', async () => {
  const h = harness(); await h.ready(); h.editEmail(' New@Example.com ');
  assert.equal(h.calls.length, 0);
  await h.blur();
  assert.deepEqual(h.calls, [['check', 'new@example.com']]);
  assert.ok(h.nodes().find(x => x.type === 'EmailVerification'));
  assert.ok(h.button('注册并登录'));
  const fields = h.nodes().filter(x => x.type === 'input');
  assert.equal(fields[0].props.type, 'email'); assert.equal(fields[1].props.type, 'password');
  assert.equal(fields[2].props.placeholder, '选填');
});

test('registered addresses keep password login and authenticate through existing login API', async () => {
  const h = harness({ async checkRegistrationEmail(email) { return { email, registered: true }; } });
  await h.ready();
  h.editEmail('known@example.com'); await h.blur(); h.password();
  assert.equal(h.nodes().find(x => x.type === 'EmailVerification'), undefined);
  h.submit(); await flush(); h.render();
  assert.deepEqual(h.calls, [['login', { identifier: 'known@example.com', password: 'Password123' }], ['accepted', 'known']]);
});

test('new addresses require the code and register directly into a logged-in session', async () => {
  const h = harness(); await h.ready(); h.editEmail('new@example.com'); await h.blur(); h.password();
  h.submit(); await flush(); assert.equal(h.calls.length, 1);
  h.nodes().find(x => x.type === 'EmailVerification').props.onCodeChange('012345'); h.render();
  h.submit(); h.submit(); await flush(); h.render();
  assert.equal(h.calls.filter(x => x[0] === 'register').length, 1);
  assert.equal(h.calls.find(x => x[0] === 'register')[1].email_code, '012345');
  assert.deepEqual(h.calls.at(-1), ['accepted', 'new']);
});

test('editing email resets registration/code and ignores stale status responses', async () => {
  let resolveOld;
  const h = harness({ checkRegistrationEmail: email => email === 'old@example.com' ? new Promise(resolve => { resolveOld = resolve; }) : Promise.resolve({ email, registered: true }) });
  await h.ready();
  h.editEmail('old@example.com'); await h.blur();
  h.editEmail('known@example.com'); await h.blur();
  resolveOld({ email: 'old@example.com', registered: false }); await flush(); h.render();
  assert.equal(h.nodes().find(x => x.type === 'EmailVerification'), undefined);
  h.password(); h.submit(); await flush();
  assert.equal(h.calls.find(x => x[0] === 'login')[1].identifier, 'known@example.com');
});

test('invalid and failed checks cannot fall through to login or registration', async () => {
  const h = harness({ async checkRegistrationEmail() { throw new Error('检查暂不可用'); } });
  await h.ready();
  h.editEmail('invalid'); await h.blur(); assert.equal(h.calls.length, 0);
  h.editEmail('new@example.com'); await h.blur(); h.password();
  assert.match(h.nodes().find(x => x.props?.role === 'alert').props.children[0], /检查暂不可用/);
  h.submit(); await flush(); h.render();
  assert.equal(h.calls.length, 0);
  assert.equal(h.nodes().find(x => x.type === 'EmailVerification'), undefined);
});

test('WeChat entry opens a custom dialog, disables email submission and can close', async () => {
  const h = harness(); await h.ready(); h.button('微信登录').props.onClick(); h.render();
  assert.ok(h.nodes().find(x => x.type === 'WechatDialog'));
  assert.equal(h.input('email').props.disabled, true);
  h.nodes().find(x => x.type === 'WechatDialog').props.onClose(); h.render();
  assert.equal(h.nodes().find(x => x.type === 'WechatDialog'), undefined);
  assert.equal(h.input('email').props.disabled, false);
});

test('server login-method configuration controls which client entries are visible', async () => {
  const wechatOnly = harness({ async getClientAuthMethods() { return { email_enabled: false, phone_otp_enabled: false, phone_otp_available: false, wechat_enabled: true }; } });
  await flush(); wechatOnly.render();
  assert.equal(wechatOnly.input('email'), undefined);
  assert.ok(wechatOnly.button('微信登录'));

  const emailOnly = harness({ async getClientAuthMethods() { return { email_enabled: true, phone_otp_enabled: false, phone_otp_available: false, wechat_enabled: false }; } });
  await flush(); emailOnly.render();
  assert.ok(emailOnly.input('email'));
  assert.equal(emailOnly.button('微信登录'), undefined);
});

test('WeChat polling is serialized and cancellation blocks accepting late tokens', () => {
  const wechat = fs.readFileSync(path.join(__dirname, '../src/components/WechatLoginDialog.tsx'), 'utf8');
  const platform = fs.readFileSync(path.join(__dirname, '../src/services/platform.ts'), 'utf8');
  assert.match(wechat, /pollWechatQrSession\(next.state, \(\) => active\)/);
  assert.match(wechat, /active = false; window.clearTimeout\(timer\)/);
  assert.doesNotMatch(wechat, /setInterval/);
  assert.match(platform, /if \(shouldAccept\(\) && typeof result.access_token/);
});
