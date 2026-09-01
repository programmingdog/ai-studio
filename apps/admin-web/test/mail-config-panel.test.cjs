const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const source = fs.readFileSync(path.join(__dirname, '../components/MailConfigPanel.tsx'), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const flush = () => new Promise(resolve => setImmediate(resolve));
const baseConfig = { api_url: 'https://yuntianxing.net/mail_sys/send_mail_http.json', delivery_method: 'HTTP', smtp_host: 'mail.yuntianxing.net', smtp_port: 25, smtp_security: 'STARTTLS', mail_from: 'sender@yuntianxing.net', password_configured: true, status: 'ACTIVE', revision: 3, updated_at: '2026-08-31T00:00:00Z' };

function harness(request) {
  const cells = [], effects = [], calls = [];
  let cursor = 0, tree;
  const module = { exports: {} };
  const mockRequire = name => name === 'react' ? {
    useState(initial) { const slot = cursor++; if (!(slot in cells)) cells[slot] = initial; return [cells[slot], value => { cells[slot] = typeof value === 'function' ? value(cells[slot]) : value; }]; },
    useRef(initial) { const slot = cursor++; if (!(slot in cells)) cells[slot] = { current: initial }; return cells[slot]; },
    useCallback(fn) { return fn; },
    useEffect(fn) { const slot = cursor++; if (!(slot in cells)) { cells[slot] = true; effects.push(fn); } },
  } : name === '@/lib/api' ? { async apiRequest(...args) { calls.push(args); if (request) return request(...args); return args[1].method === 'PATCH' ? { ...baseConfig, revision: 4 } : { ...baseConfig }; } } : require(name);
  new Function('require', 'module', 'exports', compiled)(mockRequire, module, module.exports);
  function render() { cursor = 0; tree = module.exports.MailConfigPanel({ token: 'test-only-token' }); while (effects.length) effects.shift()(); }
  function nodes(node = tree) { if (!node || typeof node !== 'object') return []; if (Array.isArray(node)) return node.flatMap(nodes); return [node, ...nodes(node.props?.children ?? null)]; }
  const input = type => nodes().find(node => node.type === 'input' && node.props.type === type);
  const form = () => nodes().find(node => node.type === 'form');
  const submit = () => form().props.onSubmit({ preventDefault() {} });
  render();
  return { render, calls, nodes, input, form, submit, async ready() { await flush(); render(); } };
}

test('mail fields cannot be saved before configuration loads', async () => {
  let resolve;
  const h = harness(() => new Promise(done => { resolve = done; }));
  assert.equal(h.nodes().find(node => node.type === 'fieldset').props.disabled, true);
  await h.submit(); assert.equal(h.calls.length, 1);
  resolve(baseConfig); await h.ready();
  assert.equal(h.nodes().find(node => node.type === 'fieldset').props.disabled, false);
  assert.equal(h.input('password').props.value, '');
  assert.match(h.input('password').props.placeholder, /已配置/);
});

test('saving an unchanged password omits it and includes the loaded revision', async () => {
  const h = harness(); await h.ready(); await h.submit(); h.render();
  const body = JSON.parse(h.calls[1][1].body);
  assert.equal(body.revision, 3); assert.equal(body.password, undefined);
  assert.equal(body.api_url, baseConfig.api_url); assert.equal(body.mail_from, baseConfig.mail_from);
  assert.equal(h.calls[1][0], '/admin/configs/mail'); assert.equal(h.calls[1][2], 'test-only-token');
  assert.match(h.nodes().find(node => node.props?.role === 'status').props.children, /无需重启/);
});

test('HTTP endpoint shows plaintext warning, requires password re-entry and saves the exact URL', async () => {
  const apiUrl = 'http://211.154.25.178:15686/mail_sys/send_mail_http.json';
  const h = harness(async (_, options) => options.method === 'PATCH' ? { ...baseConfig, api_url: apiUrl, revision: 4 } : baseConfig);
  await h.ready();
  assert.equal(h.nodes().find(node => node.props?.role === 'note'), undefined);
  h.input('url').props.onChange({ target: { value: apiUrl } }); h.render();
  assert.equal(h.input('password').props.required, true);
  assert.match(h.nodes().find(node => node.props?.role === 'note').props.children, /HTTP 会明文传输发件邮箱密码/);
  h.input('password').props.onChange({ target: { value: 'test-only-http-secret' } }); h.render();
  await h.submit(); h.render();
  const body = JSON.parse(h.calls[1][1].body);
  assert.equal(body.api_url, apiUrl); assert.equal(body.password, 'test-only-http-secret');
  assert.equal(h.input('url').props.value, apiUrl); assert.equal(h.input('password').props.value, '');
  assert.equal(h.input('password').props.required, false);
  assert.match(h.nodes().find(node => node.props?.role === 'note').props.children, /明文传输/);
  h.nodes().find(node => node.props?.name === 'delivery_method').props.onChange({ target: { value: 'SMTP' } }); h.render();
  assert.equal(h.nodes().find(node => node.props?.role === 'note'), undefined);
});

test('password replacement preserves whitespace in transit and is cleared after saving', async () => {
  const h = harness(); await h.ready();
  h.input('password').props.onChange({ target: { value: ' test-password-with-spaces ' } }); h.render();
  await h.submit(); h.render();
  assert.equal(JSON.parse(h.calls[1][1].body).password, ' test-password-with-spaces ');
  assert.equal(h.input('password').props.value, '');
});

test('changing endpoint or sender requires re-entering the password', async () => {
  for (const [type, value] of [['url', 'https://other.example.com/send'], ['email', 'other@example.com']]) {
    const h = harness(); await h.ready();
    h.input(type).props.onChange({ target: { value } }); h.render();
    assert.equal(h.input('password').props.required, true);
  }
});

test('SMTP selection shows host/port/security, hides HTTP URL and posts a numeric port', async () => {
  const h = harness(async (_, options) => options.method === 'PATCH' ? { ...baseConfig, ...JSON.parse(options.body), password: undefined, revision: 4 } : baseConfig);
  await h.ready();
  h.nodes().find(node => node.props?.name === 'delivery_method').props.onChange({ target: { value: 'SMTP' } }); h.render();
  assert.equal(h.input('url'), undefined); assert.equal(h.input('text').props.value, 'mail.yuntianxing.net');
  assert.equal(h.input('number').props.value, '25'); assert.equal(h.input('password').props.required, true);
  assert.match(h.input('password').props.placeholder, /重新填写/);
  h.input('number').props.onChange({ target: { value: '465' } }); h.render();
  h.nodes().find(node => node.props?.name === 'smtp_security').props.onChange({ target: { value: 'TLS' } }); h.render();
  h.input('password').props.onChange({ target: { value: 'test-new-smtp-secret' } }); h.render();
  await h.submit(); h.render();
  const body = JSON.parse(h.calls[1][1].body);
  assert.equal(body.delivery_method, 'SMTP'); assert.equal(body.smtp_port, 465); assert.equal(body.smtp_security, 'TLS');
  assert.equal(h.input('password').props.value, ''); assert.equal(h.input('password').props.required, false);
  assert.equal(h.input('url'), undefined);
});

test('loaded SMTP configuration requires secret re-entry for host, port, security or protocol changes', async () => {
  for (const [name, value] of [['smtp_host', 'other.example.com'], ['smtp_port', '587'], ['smtp_security', 'TLS'], ['delivery_method', 'HTTP']]) {
    const h = harness(async () => ({ ...baseConfig, delivery_method: 'SMTP' })); await h.ready();
    assert.equal(h.input('url'), undefined); assert.equal(h.input('password').props.required, false);
    h.nodes().find(node => node.props?.name === name).props.onChange({ target: { value } }); h.render();
    assert.equal(h.input('password').props.required, true);
  }
});

test('load failures keep save disabled and display an actionable error', async () => {
  const h = harness(async () => { throw Error('当前管理员没有权限'); }); await h.ready();
  assert.equal(h.nodes().find(node => node.type === 'fieldset').props.disabled, true);
  assert.match(h.nodes().find(node => node.props?.role === 'alert').props.children, /没有权限/);
  await h.submit(); assert.equal(h.calls.length, 1);
});

test('duplicate submissions are blocked and a conflict leaves the form for explicit reload', async () => {
  let reject;
  const h = harness(async (_, options) => options.method === 'PATCH' ? new Promise((_, fail) => { reject = fail; }) : baseConfig);
  await h.ready();
  const first = h.submit(); await h.submit(); h.render();
  assert.equal(h.calls.length, 2); assert.equal(h.nodes().find(node => node.type === 'fieldset').props.disabled, true);
  reject(Error('邮箱配置已被修改，请重新读取后再保存')); await first; h.render();
  assert.match(h.nodes().find(node => node.props?.role === 'alert').props.children, /重新读取/);
  assert.equal(h.input('url').props.value, baseConfig.api_url);
});

test('settings navigation contains the mail panel and no legacy mail env credentials are read', () => {
  const app = fs.readFileSync(path.join(__dirname, '../components/AdminApp.tsx'), 'utf8');
  assert.match(app, /id: "mail-config", label: "邮箱配置"/);
  assert.match(app, /view === "mail-config" && <MailConfigPanel/);
  const environment = fs.readFileSync(path.join(__dirname, '../../server/src/config/environment.ts'), 'utf8');
  assert.doesNotMatch(environment, /process\.env\.MAIL_API_(URL|FROM|PASSWORD)/);
});
