const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateNormalizedScript, normalizedScriptText } = require('../dist/gateway/script-normalization.js');

const { fixture } = require('./fixtures/normalized-script.cjs');

test('normalization keeps natural shot lengths and builds a continuous source timeline', () => {
  const result = validateNormalizedScript(fixture());
  assert.deepEqual(result.shots.map(shot => shot.duration), [7, 12]);
  assert.deepEqual(result.shots.map(shot => shot.source_time_range), [{ start: 0, end: 7 }, { start: 7, end: 19 }]);
  assert.match(result.shots[0].scene_lock, /编辑部/);
  assert.match(result.shots[0].character_lock, /米色风衣/);
});

test('exports a readable four-section TXT with every shot and dialogue', () => {
  const result = validateNormalizedScript(fixture());
  const txt = normalizedScriptText(result);
  for (const section of ['一、项目剧情', '二、全局角色库', '三、全局场景库', '四、分镜列表']) assert.ok(txt.includes(section));
  assert.match(txt, /第1段（0～7秒）\n生成时长：7秒/);
  assert.match(txt, /第2段（7～19秒）\n生成时长：12秒/);
  assert.match(txt, /口播台词：\n- 林夏：谁送来的？/);
  assert.match(txt, /人物引用：CHAR_001｜林夏/);
  assert.doesNotMatch(txt, /undefined|\[object Object\]/);
});

test('preserves explicit source ranges independently of generation duration', () => {
  const input = fixture();
  input.shots[0].time_range = { start: 0, end: 5 };
  input.shots[1].time_range = { start: 5, end: 16 };
  assert.deepEqual(validateNormalizedScript(input).shots.map(s => s.source_time_range), [{ start: 0, end: 5 }, { start: 5, end: 16 }]);
});

test('rejects hollow paid results, unknown references and invalid durations before settlement', () => {
  const cases = [
    value => value.shots[0].duration = 0,
    value => value.shots[0].duration = NaN,
    value => value.shots[0].scene_id = 'missing',
    value => value.shots[0].character_state_ids = {},
    value => value.shots[0].visual = '',
    value => value.characters[0].appearance = {},
    value => value.scenes[0].layout = '未说明',
    value => value.shots = [],
    value => value.shots[1].id = value.shots[0].id,
    value => value.shots[1].time_range = { start: 0, end: 12 },
  ];
  for (const mutate of cases) {
    const value = fixture(); mutate(value);
    assert.throws(() => validateNormalizedScript(value), /剧本规范化结果不完整/);
  }
});
