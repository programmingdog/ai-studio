const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const source = fs.readFileSync(path.join(__dirname, '../src/components/AssetLibraryPickerModal.tsx'), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const assets = ['scene', 'character', 'prop'].map(type => ({ id: type, asset_type: type, name: `${type}-picture`, image_path: `C:/library/${type}.png`, prompt: '' }));
function harness(type, onConfirm = async () => {}) {
  const cells = [];
  let cursor = 0, tree, closes = 0;
  const query = { data: assets, isFetching: false, isLoading: false, error: null, refetch() {} };
  const value = { exports: {} };
  const mockRequire = name => {
    if (name === 'react') return {
      useEffect() {},
      useState(initial) { const slot = cursor++; if (!(slot in cells)) cells[slot] = initial; return [cells[slot], next => { cells[slot] = next; }]; },
      useRef(initial) { const slot = cursor++; if (!(slot in cells)) cells[slot] = { current: initial }; return cells[slot]; },
    };
    if (name === 'react-dom') return { createPortal: element => element };
    if (name === '@tanstack/react-query') return { useQuery: () => query };
    if (name === '@tauri-apps/api/core') return { convertFileSrc: p => `asset:${p}` };
    if (name === '../services/backend') return { listAssetLibrary() { throw Error('no real IO in tests'); } };
    return require(name);
  };
  new Function('require', 'exports', 'module', 'document', compiled)(mockRequire, value.exports, value, { body: {} });
  function render() { cursor = 0; tree = value.exports.AssetLibraryPickerModal({ assetType: type, onConfirm, onClose: () => { closes++; } }); }
  function nodes(node = tree) {
    if (!node || typeof node !== 'object') return [];
    if (Array.isArray(node)) return node.flatMap(nodes);
    return [node, ...nodes(node.props?.children ?? null)];
  }
  function button(label) { return nodes().find(node => node.type === 'button' && (node.props['aria-label'] === label || nodes(node.props.children).length === 0 && node.props.children === label)); }
  const confirm = () => nodes().find(node => node.type === 'button' && node.props.className === 'primary-button');
  render();
  return { render, nodes, button, confirm, query, closes: () => closes };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

test('each picker shows only its requested category and confirmation needs a selection', () => {
  for (const type of ['scene', 'character']) {
    const h = harness(type);
    const cards = h.nodes().filter(n => n.type === 'button' && n.props.className?.includes('asset-library-card'));
    assert.equal(cards.length, 1);
    assert.equal(cards[0].key, type);
    assert.equal(h.confirm().props.disabled, true);
    cards[0].props.onClick(); h.render();
    assert.equal(h.confirm().props.disabled, false);
  }
});

test('cancel never confirms or imports an image', () => {
  let imports = 0;
  const h = harness('scene', async () => { imports++; });
  h.button('选择场景图：scene-picture').props.onClick(); h.render();
  h.button('取消').props.onClick();
  assert.equal(h.closes(), 1);
  assert.equal(imports, 0);
});

test('confirmation submits exactly the selected asset and blocks duplicate clicks while importing', async () => {
  const calls = [];
  let finish;
  const h = harness('character', asset => { calls.push(asset); return new Promise(resolve => { finish = resolve; }); });
  h.button('选择角色图：character-picture').props.onClick(); h.render();
  h.confirm().props.onClick(); h.confirm().props.onClick(); h.render();
  assert.deepEqual(calls, [assets[1]]);
  assert.equal(h.confirm().props.disabled, true);
  assert.equal(h.button('取消').props.disabled, true);
  finish(); await flush(); h.render();
  assert.equal(h.confirm().props.disabled, false);
});

test('import failure stays in the picker and allows retry', async () => {
  const h = harness('scene', async () => { throw Error('图片文件不存在'); });
  h.button('选择场景图：scene-picture').props.onClick(); h.render();
  h.confirm().props.onClick(); await flush(); h.render();
  assert.equal(h.closes(), 0);
  assert.equal(h.confirm().props.disabled, false);
  const alert = h.nodes().find(n => n.props?.role === 'alert');
  assert.ok(JSON.stringify(alert.props.children).includes('图片文件不存在'));
});

test('removed or unavailable assets cannot be confirmed after refresh', () => {
  const h = harness('scene');
  h.button('选择场景图：scene-picture').props.onClick(); h.render();
  h.query.isFetching = true; h.render(); assert.equal(h.confirm().props.disabled, true);
  h.query.isFetching = false; h.query.data = [assets[1]]; h.render();
  assert.equal(h.confirm().props.disabled, true);
  assert.equal(h.nodes().filter(n => n.type === 'img').length, 0);
});

test('project entry points precede local imports and copy into the correct scene or character state', () => {
  const app = fs.readFileSync(path.join(__dirname, '../src/App.tsx'), 'utf8');
  assert.match(app, /\["story", "story", BookOpen\], \["scenes", "scenes", Boxes\], \["characters", "characters", CircleUserRound\]/);
  const characters = app.slice(app.indexOf('function CharactersPage'), app.indexOf('function sceneImageTask'));
  const scenes = app.slice(app.indexOf('function ScenesPage'), app.indexOf('function LegacyStoryboardPage'));
  for (const [part, category, owner, button] of [[characters, 'character', 'character_state', '从素材库选择'], [scenes, 'scene', 'scene', '从资产库选择']]) {
    assert.match(part, new RegExp(`assetType="${category}"`));
    assert.ok(part.indexOf(button) < part.indexOf('"选择本地图片"'));
    assert.ok(part.includes(`importProjectReferenceImage(projectPath, sourcePath, "${owner}"`));
    assert.ok(part.includes('asset.image_path'));
    assert.ok(part.includes('libraryPath ?? await chooseProjectImage()'));
    assert.ok(part.includes('reference_assets: [relativePath, ...remaining]'));
  }
});
