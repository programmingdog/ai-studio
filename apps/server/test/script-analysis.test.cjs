const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { extractScriptText, parseOpenAiEventStream, parseScriptAnalysis, ModelGatewayService } = require("../dist/gateway/model-gateway.service.js");

const canonical = {
  story: { title: "原文标题" }, episodes: [], characters: [], scenes: [], sequences: [], shots: [],
};

test("accepts fenced OpenAI-compatible canonical JSON", () => {
  const result = parseScriptAnalysis({ choices: [{ message: { content: `\`\`\`json\n${JSON.stringify(canonical)}\n\`\`\`` } }] });
  assert.equal(result.story.title, "原文标题");
});

test("reassembles an OpenAI event stream into the canonical response shape", () => {
  const json = JSON.stringify(canonical);
  const midpoint = Math.floor(json.length / 2);
  const stream = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: json.slice(0, midpoint) }, finish_reason: null }] })}`,
    `data: ${JSON.stringify({ choices: [{ delta: { content: json.slice(midpoint) }, finish_reason: "stop" }] })}`,
    `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 20 } })}`,
    "data: [DONE]",
  ].join("\n\n");
  const result = parseOpenAiEventStream(stream);
  assert.deepEqual(parseScriptAnalysis(result), canonical);
  assert.equal(result.usage.completion_tokens, 20);
});

test("script extraction enables streaming for OpenAI-compatible text models", async () => {
  const gateway = new ModelGatewayService({}, {});
  gateway.defaultTextTarget = async () => ({
    model_id: "model-1", model_code: "tt-5.6-sol", capability: "TEXT_GENERATION",
    api_protocol: "openai", generation_endpoint: "/v1/chat/completions", supports_async_tasks: 0,
  });
  gateway.scriptAnalysisConfig = async () => ({ prompt: "x".repeat(100), credit_cost: 10, revision: 1 });
  gateway.create = async (_userId, input) => {
    assert.equal(input.payload.stream, true);
    return { provider_response: { choices: [{ message: { content: JSON.stringify(canonical) } }] } };
  };
  const result = await gateway.createScriptAnalysisUpload("user-1", {
    idempotencyKey: "stream-script", expectedCredits: 10,
    file: { buffer: Buffer.from("第一场\n原文内容不能改写"), mimetype: "text/plain", originalname: "script.txt", size: 30 },
  });
  assert.equal(result.analysis.story.title, "原文标题");
});

test("video URL and upload storyboard extraction use the configured feature price", async () => {
  const gateway = new ModelGatewayService({}, {});
  const target = {
    model_id: "video-model-1", model_code: "gem-3.7-flash", model_alias: "GEM 视频理解",
    capability: "VIDEO_UNDERSTANDING", credit_cost: 1,
  };
  gateway.defaultVideoUnderstandingTarget = async () => target;
  gateway.target = async () => target;
  gateway.scriptAnalysisConfig = async () => ({ prompt: "x".repeat(100), credit_cost: 10, revision: 2 });

  const quote = await gateway.quote({ capability: "VIDEO_UNDERSTANDING", payload: {} });
  assert.equal(quote.credits, 10);
  assert.equal(quote.provider_model_id, target.model_id);

  const submissions = [];
  gateway.create = async (_userId, input) => { submissions.push(input); return { task: { id: `task-${submissions.length}` } }; };
  await gateway.createVideoUnderstanding("user-1", {
    idempotencyKey: "video-url", expectedCredits: 10, providerModelId: target.model_id,
    prompt: "提取完整分镜脚本", videoUrl: "https://example.invalid/video.mp4",
  });
  await gateway.createVideoUnderstandingUpload("user-1", {
    idempotencyKey: "video-upload", expectedCredits: 10, providerModelId: target.model_id,
    prompt: "提取完整分镜脚本",
    file: { buffer: Buffer.from("video"), mimetype: "video/mp4", originalname: "video.mp4", size: 5 },
  });
  assert.deepEqual(submissions.map(item => item.creditOverride), [10, 10]);
  assert.deepEqual(submissions.map(item => item.expectedCredits), [10, 10]);
  assert.deepEqual(submissions.map(item => item.taskType), ["VIDEO_UNDERSTANDING", "VIDEO_UNDERSTANDING"]);
});

test("provider network failures expose the underlying socket error", async () => {
  const gateway = new ModelGatewayService({}, {});
  const originalFetch = global.fetch;
  global.fetch = async () => {
    const cause = Object.assign(new Error("socket closed before TLS completed"), { code: "ECONNRESET" });
    throw Object.assign(new TypeError("fetch failed"), { cause });
  };
  try {
    await assert.rejects(
      gateway.call({ url: "https://example.invalid", method: "POST", headers: {}, body: {} }),
      /ECONNRESET.*socket closed before TLS completed/,
    );
  } finally { global.fetch = originalFetch; }
});

test("rejects incomplete model extraction before credit settlement", () => {
  assert.throws(() => parseScriptAnalysis({ choices: [{ message: { content: '{"story":{"title":"x"}}' } }] }), /结构不完整/);
});

test("repairs character state strings returned by the text model", () => {
  const malformed = {
    ...canonical,
    characters: [{ id: "CHAR_001", name: "林小凡", states: ["雨中状态", null] }],
  };
  const result = parseScriptAnalysis({ choices: [{ message: { content: JSON.stringify(malformed) } }] });
  assert.equal(result.characters[0].states[0].id, "CHAR_001_STATE_001");
  assert.equal(result.characters[0].states[0].name, "雨中状态");
  assert.equal(result.characters[0].states[0].description, "雨中状态");
  assert.equal(result.characters[0].states[1].name, "未说明");
});

test("wraps a scalar states field returned by the text model", () => {
  const malformed = {
    ...canonical,
    characters: [{ id: "CHAR_001", name: "林小凡", states: "常态" }],
  };
  const result = parseScriptAnalysis({ choices: [{ message: { content: JSON.stringify(malformed) } }] });
  assert.equal(result.characters[0].states[0].name, "常态");
});

test("extracts the entire UTF-8 text file without script splitting", async () => {
  const text = "第一场 外景 街道\n林小凡：这是剧本原文。\n第二场 内景 房间";
  const result = await extractScriptText({ buffer: Buffer.from(text), originalname: "原剧本.txt" });
  assert.equal(result.text, text);
});

test("default configuration explicitly forbids invention", () => {
  const migration = fs.readFileSync(path.join(__dirname, "../src/database/migrations/032_script_analysis_config.sql"), "utf8");
  assert.match(migration, /100%忠于原文/);
  assert.match(migration, /禁止补写、推测、润色、改编、续写/);
});
