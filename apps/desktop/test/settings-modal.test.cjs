const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

const source = fs.readFileSync(path.join(__dirname, '../src/components/AiSettingsModal.tsx'), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;

function renderSettings(data, activeTab = 'general') {
  let mutation;
  let saved;
  const moduleValue = { exports: {} };
  const prompt = 'test prompt '.repeat(10);
  const mockRequire = (name) => {
    if (name === 'react') return {
      ...React,
      useEffect: () => {},
      useState: (initial) => [initial === 'general' ? activeTab : initial, () => {}],
    };
    if (name === '@tanstack/react-query') return {
      useQuery: () => ({ data, isLoading: false }),
      useQueryClient: () => ({ setQueryData: () => {} }),
      useMutation: (options) => { mutation = options; return { isPending: false }; },
    };
    if (name === '../services/backend') return {
      getAiSettings: () => data,
      saveAiSettings: (input) => { saved = input; return input; },
    };
    if (name === '../prompts/videoStoryboard') return { VIDEO_STORYBOARD_PROMPT: prompt, VIDEO_STORYBOARD_DETAILED_PROMPT: prompt };
    if (name === '../prompts/characterImage') return { CHARACTER_IMAGE_PROMPT: prompt };
    if (name === '../i18n') return {
      supportedLocales: [{ code: 'zh-CN', nativeName: '简体中文' }],
      useI18n: () => ({ locale: 'zh-CN', direction: 'ltr', setLocale: () => {}, t: (key) => key }),
    };
    return require(name);
  };
  new Function('require', 'exports', 'module', compiled)(mockRequire, moduleValue.exports, moduleValue);
  const html = renderToStaticMarkup(React.createElement(moduleValue.exports.AiSettingsModal, { onClose() {} }));
  return { html, save: () => mutation.mutationFn(), saved: () => saved };
}

const settings = {
  base_url: 'https://example.test', agent_model: 'custom-agent', video_model: 'custom-understanding',
  image_model: 'custom-image', image_protocol: 'media', video_generation_model: 'custom-video',
  video_generation_protocol: 'media', credit_costs: { image_per_item: 17, video_per_second: { '2K': 31 } },
  prompt_defaults: { source: 'SERVER', channel: 'stable', versions: {} },
};

test('settings renders only general and prompt tabs, with both retained panels available', () => {
  for (const tab of ['general', 'prompt']) {
    const { html } = renderSettings(settings, tab);
    assert.equal((html.match(/role="tab"/g) || []).length, 2);
    assert.match(html, /general/);
    assert.match(html, /promptSettings/);
    assert.doesNotMatch(html, /interfaceSettings|积分消耗|API Key|interface-settings-panel|credit-settings-panel/);
    assert.match(html, tab === 'general' ? /language-settings-panel/ : /prompt-settings-panel/);
  }
});

test('saving remaining settings preserves hidden interface and credit configuration without changing keys', () => {
  const rendered = renderSettings(settings);
  rendered.save();
  const saved = rendered.saved();
  for (const key of Object.keys(settings).filter((key) => key !== 'prompt_defaults')) {
    assert.deepEqual(saved[key], settings[key], key);
  }
  assert.equal(Object.hasOwn(saved, 'api_key'), false);
  assert.equal(Object.hasOwn(saved, 'clear_api_key'), false);
});

test('settings cannot overwrite stored configuration before it has loaded', () => {
  const rendered = renderSettings(undefined);
  assert.match(rendered.html, /class="primary-button" type="button" disabled=""/);
  assert.throws(() => rendered.save(), /设置尚未加载/);
  assert.equal(rendered.saved(), undefined);
});
