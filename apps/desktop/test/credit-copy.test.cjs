const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const compiled = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/services/creditCopy.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
const moduleValue = { exports: {} };
new Function('exports', 'module', compiled)(moduleValue.exports, moduleValue);
const { creditAction, creditNotice, creditRefundCopy, creditRetryCopy } = moduleValue.exports;

test('remix notice gives the actual points and explains refunds without technical terms', () => {
  const text = creditNotice('二创', 4);
  assert.match(text, /本次二创需要扣 4 积分/);
  assert.match(text, /生成失败会退回积分/);
  assert.match(text, /已生成内容但需要调整，本次仍会扣分/);
  assert.doesNotMatch(text + creditRetryCopy, /系数|调用|接口|冻结|结算|费率|大模型/);
});
test('free operations and fractional prices stay explicit', () => {
  assert.equal(creditNotice('二创', 0), '本次二创免费，不扣积分。');
  assert.match(creditNotice('图片生成', 1.125), /1\.125 积分/);
  assert.match(creditRetryCopy, /由你确认/);
});
test('native operation names turn into familiar activities', () => {
  const cases = [
    ['二创剧情与分镜生成', 'TEXT_GENERATION', '二创'],
    ['Agent 文本规划（每轮调用分别计费）', 'TEXT_GENERATION', '助手处理'],
    ['角色图生成 · CHAR_001', 'IMAGE_GENERATION', '角色图生成'],
    ['场景图生成 · SCENE_001', 'IMAGE_GENERATION', '场景图生成'],
    ['分镜图生成', 'IMAGE_GENERATION', '分镜图生成'],
    ['创意故事大纲生成', 'TEXT_GENERATION', '大纲生成'],
    ['视频链接理解与分镜解析', 'VIDEO_UNDERSTANDING', '视频解析'],
    ['分镜视频生成', 'VIDEO_GENERATION', '视频生成'],
  ];
  for (const [operation, capability, expected] of cases) assert.equal(creditAction(operation, capability), expected);
});
test('payment confirmation and entry notices no longer present implementation details', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/components/CreditConfirmationHost.tsx'), 'utf8');
  assert.doesNotMatch(source, /已含系数|积分费率|冻结积分|次调用|本批调用|model_alias/);
  assert.match(source, /取消，不扣分/);
  assert.match(source, /确认并开始/);
  const app = fs.readFileSync(path.join(__dirname, '../src/App.tsx'), 'utf8');
  assert.match(app, /action="二创"/);
  assert.match(app, /action="大纲生成"/);
  assert.doesNotMatch(app, /已含系数|收费调用都须|本批总额/);
});
