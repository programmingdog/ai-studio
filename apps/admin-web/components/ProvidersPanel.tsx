"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { apiRequest } from "@/lib/api";
import { ModelSupplierPrice, useProviderPricing } from "./ProviderPricing";

type Provider = {
  id: string;
  code: string;
  display_name: string;
  adapter_type: string;
  base_url: string;
  status: string;
  config_json: unknown;
  model_count: number;
  active_model_count: number;
};

type ProviderModel = {
  id: string;
  provider_id: string;
  model_code: string;
  display_name: string;
  model_alias: string;
  capability: ModelCapability;
  api_protocol: string;
  generation_endpoint: string;
  query_endpoint: string | null;
  credit_cost: number;
  credit_multiplier?: number;
  final_credit_cost?: number;
  max_reference_images: number;
  supports_reference_video: boolean;
  supports_real_person: boolean;
  supports_async_tasks: boolean;
  sort_order: number;
  description: string;
  status: string;
  parameter_schema_json: unknown;
  config_json: unknown;
  resolution_prices: ResolutionPrice[];
};

type ResolutionPrice = { resolution: string; credit_cost: number; final_credit_cost?: number };

type ProviderCredential = {
  id: string;
  provider_id: string;
  name: string;
  masked_hint: string;
  status: string;
  balance: number | null;
  balance_currency: string;
  notes: string;
  last_balance_synced_at: string | null;
  updated_at: string;
};

type ModelTestRecord = {
  id: string;
  status: string;
  request_json: unknown;
  create_http_status: number | null;
  create_duration_ms: number | null;
  create_response_json: unknown;
  remote_task_id: string | null;
  query_http_status: number | null;
  query_duration_ms: number | null;
  query_response_json: unknown;
  error_message: string | null;
};

type ModelCapability = "TEXT_GENERATION" | "VIDEO_UNDERSTANDING" | "IMAGE_GENERATION" | "VIDEO_GENERATION";

type DefaultModelCandidate = {
  id: string;
  provider_id: string;
  provider_name: string;
  model_code: string;
  display_name: string;
  model_alias: string;
  capability: ModelCapability;
  sort_order: number;
};

type DefaultModelConfig = {
  text_model_id: string | null;
  video_understanding_model_id: string | null;
  image_model_ids: string[];
  video_model_ids: string[];
  candidates: DefaultModelCandidate[];
};

const capabilityLabels: Record<ModelCapability, string> = {
  TEXT_GENERATION: "文本生成",
  VIDEO_UNDERSTANDING: "视频理解",
  IMAGE_GENERATION: "图片生成",
  VIDEO_GENERATION: "视频生成",
};

const capabilityOrder = Object.keys(capabilityLabels) as ModelCapability[];

function errorMessage(reason: unknown, fallback: string) {
  return reason instanceof Error ? reason.message : fallback;
}

function statusTone(status: string) {
  if (status === "ACTIVE") return "good";
  if (status === "DISABLED") return "bad";
  return "warn";
}

export function ProvidersPanel({ token }: { token: string }) {
  const pricing = useProviderPricing(token);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [models, setModels] = useState<ProviderModel[]>([]);
  const [credentials, setCredentials] = useState<ProviderCredential[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [providerModal, setProviderModal] = useState<Provider | "new" | null>(null);
  const [modelModal, setModelModal] = useState<ProviderModel | "new" | null>(null);
  const [credentialModal, setCredentialModal] = useState<ProviderCredential | "new" | null>(null);
  const [testModel, setTestModel] = useState<ProviderModel | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [defaultModelsRevision, setDefaultModelsRevision] = useState(0);

  const selected = providers.find((provider) => provider.id === selectedId) || null;

  const loadProviders = useCallback(async () => {
    try {
      const rows = await apiRequest<Provider[]>("/admin/providers", {}, token);
      setProviders(rows);
      setSelectedId((current) => current && rows.some((row) => row.id === current) ? current : rows[0]?.id || null);
    } catch (reason) {
      setError(errorMessage(reason, "供应商读取失败"));
    }
  }, [token]);

  const loadModels = useCallback(async (providerId: string) => {
    setLoadingModels(true);
    try {
      setModels(await apiRequest<ProviderModel[]>(`/admin/providers/${providerId}/models`, {}, token));
    } catch (reason) {
      setError(errorMessage(reason, "模型读取失败"));
    } finally {
      setLoadingModels(false);
    }
  }, [token]);

  const loadCredentials = useCallback(async (providerId: string) => {
    try {
      setCredentials(await apiRequest<ProviderCredential[]>(`/admin/providers/${providerId}/credentials`, {}, token));
    } catch (reason) {
      setError(errorMessage(reason, "API Key 读取失败"));
    }
  }, [token]);

  useEffect(() => { void loadProviders(); }, [loadProviders]);
  useEffect(() => {
    if (selectedId) {
      void loadModels(selectedId);
      void loadCredentials(selectedId);
    } else {
      setModels([]);
      setCredentials([]);
    }
  }, [selectedId, loadModels, loadCredentials, pricing.revision]);

  const groupedModels = useMemo(() => capabilityOrder.map((capability) => ({
    capability,
    items: models.filter((model) => model.capability === capability),
  })), [models]);

  const refresh = async (successMessage: string) => {
    pricing.invalidate();
    setMessage(successMessage);
    setError("");
    await loadProviders();
    if (selectedId) await Promise.all([loadModels(selectedId), loadCredentials(selectedId)]);
    setDefaultModelsRevision((revision) => revision + 1);
  };

  const toggleProvider = async (provider: Provider) => {
    try {
      await apiRequest(`/admin/providers/${provider.id}`, {
        method: "PATCH",
        body: JSON.stringify({ status: provider.status === "ACTIVE" ? "DISABLED" : "ACTIVE" }),
      }, token);
      await refresh(provider.status === "ACTIVE" ? "供应商已停用" : "供应商已启用");
    } catch (reason) { setError(errorMessage(reason, "操作失败")); }
  };

  const toggleModel = async (model: ProviderModel) => {
    if (!selected) return;
    try {
      await apiRequest(`/admin/providers/${selected.id}/models/${model.id}`, {
        method: "PATCH",
        body: JSON.stringify(modelPayload({ ...model, status: model.status === "ACTIVE" ? "DISABLED" : "ACTIVE" })),
      }, token);
      await refresh(model.status === "ACTIVE" ? "模型已停用" : "模型已启用");
    } catch (reason) { setError(errorMessage(reason, "操作失败")); }
  };

  const toggleCredential = async (credential: ProviderCredential) => {
    if (!selected) return;
    try {
      await apiRequest(`/admin/providers/${selected.id}/credentials/${credential.id}`, {
        method: "PATCH",
        body: JSON.stringify({ status: credential.status === "ACTIVE" ? "DISABLED" : "ACTIVE" }),
      }, token);
      await refresh(credential.status === "ACTIVE" ? "API Key 已停用" : "API Key 已启用");
    } catch (reason) { setError(errorMessage(reason, "操作失败")); }
  };

  return <div className="provider-console">
    {pricing.modal}
    <DefaultModelConfigPanel token={token} revision={defaultModelsRevision} />
    <section className="list-card provider-directory">
      <header><div><span className="kicker">AI GATEWAY</span><h2>AI 供应商</h2><p>管理 Adapter、网关地址与模型目录。</p></div><button className="primary" onClick={() => setProviderModal("new")}>新增</button></header>
      {providers.length ? <div className="provider-list">{providers.map((provider) => <article key={provider.id} className={selectedId === provider.id ? "selected" : ""}>
        <button className="provider-select" onClick={() => { setSelectedId(provider.id); setMessage(""); setError(""); }}>
          <span className="provider-icon">{provider.display_name.slice(0, 2).toUpperCase()}</span>
          <span className="provider-summary"><b>{provider.display_name}</b><small>{provider.code} · {provider.adapter_type}</small><em>{provider.active_model_count}/{provider.model_count} 个模型启用</em></span>
          <span className={`status ${statusTone(provider.status)}`}>{provider.status}</span>
        </button>
        <div className="inline-actions"><button onClick={() => setProviderModal(provider)}>编辑</button><button onClick={() => void toggleProvider(provider)}>{provider.status === "ACTIVE" ? "停用" : "启用"}</button></div>
        <div className="provider-live-price"><button className="secondary" disabled={provider.code.toLowerCase() !== "wagaai"} onClick={() => pricing.open(provider)}>查看实时价格</button>{provider.code.toLowerCase() !== "wagaai" && <small>暂未接入该供应商价格接口</small>}</div>
      </article>)}</div> : <div className="empty-row">尚未配置 AI 供应商</div>}
    </section>

    <section className="editor-card model-catalog">
      {selected ? <>
        <header><div><span className="kicker">MODEL CATALOG</span><h2>{selected.display_name} · 大模型</h2><p>{selected.base_url}</p></div><button className="primary" onClick={() => setModelModal("new")}>新增大模型</button></header>
        {error && <div className="form-error">{error}</div>}{message && <div className="form-success">{message}</div>}
        <section className="credential-section"><header><div><strong>API Key</strong><small>密钥使用 AES-256-GCM 加密保存，页面仅展示掩码。</small></div><button className="secondary" onClick={() => setCredentialModal("new")}>新增 API Key</button></header>
          {credentials.length ? <div className="credential-list">{credentials.map((credential) => <article key={credential.id}>
            <div><span className={`status ${statusTone(credential.status)}`}>{credential.status}</span><strong>{credential.name}</strong><code>{credential.masked_hint}</code><small>{credential.notes || "暂无备注"}</small></div>
            <div className="credential-balance"><strong>{credential.balance === null ? "—" : credential.balance.toLocaleString("zh-CN")}</strong><span>{credential.balance_currency}</span></div>
            <div className="model-actions"><button className="secondary" onClick={() => setCredentialModal(credential)}>编辑</button><button className="secondary" onClick={() => void toggleCredential(credential)}>{credential.status === "ACTIVE" ? "停用" : "启用"}</button></div>
          </article>)}</div> : <div className="empty-model">尚未配置 API Key</div>}
        </section>
        {loadingModels ? <div className="loading-card"><span className="spinner" />正在读取模型…</div> : <div className="model-groups">{groupedModels.map(({ capability, items }) => <section key={capability} className="model-group">
          <header><div><strong>{capabilityLabels[capability]}</strong><small>{items.length} 个模型</small></div></header>
          {items.length ? <div className="model-list">{items.map((model) => <article key={model.id}>
            <div className="model-main"><span className={`status ${statusTone(model.status)}`}>{model.status}</span><h3>{model.model_alias}</h3><p>{model.display_name} · <code>{model.model_code}</code></p><small>{model.api_protocol} · {model.generation_endpoint}</small>
              {selected.code.toLowerCase() === "wagaai" && <ModelSupplierPrice model={pricing.modelPrice(selected.id, model.model_code)} onDetails={() => pricing.open(selected, model.model_code)} />}
            </div>
            <div className="model-pricing"><small>用户最终积分</small>{model.resolution_prices?.length ? model.resolution_prices.map((price) => <span className="resolution-price" key={price.resolution}><strong>{price.resolution}</strong><em>{price.final_credit_cost ?? price.credit_cost} 积分{model.capability === "VIDEO_GENERATION" ? " / 秒" : " / 次"}</em><small>基础 {price.credit_cost} × {model.credit_multiplier ?? 1}</small></span>) : <><strong>{model.final_credit_cost ?? model.credit_cost}</strong><span>{model.capability === "VIDEO_GENERATION" ? "积分 / 秒" : "积分 / 次"}</span><small>基础 {model.credit_cost} × {model.credit_multiplier ?? 1}</small></>}</div>
            <div className="model-flags"><span>参考图 {model.max_reference_images}</span><span>参考视频 {model.supports_reference_video ? "支持" : "不支持"}</span>{model.capability === "VIDEO_GENERATION" && <span>真人 {model.supports_real_person ? "支持" : "不支持"}</span>}<span>{model.supports_async_tasks ? "异步查询" : "同步返回"}</span></div>
            <div className="model-actions"><button className="primary" onClick={() => setTestModel(model)}>测试</button><button className="secondary" onClick={() => setModelModal(model)}>编辑</button><button className="secondary" onClick={() => void toggleModel(model)}>{model.status === "ACTIVE" ? "停用" : "启用"}</button></div>
          </article>)}</div> : <div className="empty-model">暂未配置{capabilityLabels[capability]}模型</div>}
        </section>)}</div>}
      </> : <div className="empty-editor"><strong>先添加一个供应商</strong><p>供应商创建后，可以为它配置不同类型的大模型与积分定价。</p></div>}
    </section>

    {providerModal && <ProviderModal token={token} provider={providerModal === "new" ? null : providerModal} onClose={() => setProviderModal(null)} onSaved={async () => { setProviderModal(null); await refresh(providerModal === "new" ? "供应商已创建" : "供应商已更新"); }} />}
    {modelModal && selected && <ModelModal token={token} providerId={selected.id} model={modelModal === "new" ? null : modelModal} onClose={() => setModelModal(null)} onSaved={async () => { setModelModal(null); await refresh(modelModal === "new" ? "模型已创建" : "模型已更新"); }} />}
    {credentialModal && selected && <CredentialModal token={token} providerId={selected.id} credential={credentialModal === "new" ? null : credentialModal} onClose={() => setCredentialModal(null)} onSaved={async () => { setCredentialModal(null); await refresh(credentialModal === "new" ? "API Key 已创建" : "API Key 已更新"); }} />}
    {testModel && selected && <ModelTestModal token={token} provider={selected} model={testModel} credentials={credentials.filter((credential) => credential.status === "ACTIVE")} onClose={() => setTestModel(null)} />}
  </div>;
}

function defaultModelLabel(model: DefaultModelCandidate): string {
  return `${model.provider_name}-${model.model_alias}-${model.display_name}`;
}

function DefaultModelConfigPanel({ token, revision }: { token: string; revision: number }) {
  const [config, setConfig] = useState<DefaultModelConfig | null>(null);
  const [form, setForm] = useState({
    text_model_id: "",
    video_understanding_model_id: "",
    image_model_ids: [] as string[],
    video_model_ids: [] as string[],
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  useEffect(() => {
    let active = true;
    setLoading(true);
    apiRequest<DefaultModelConfig>("/admin/providers/default-model-config", {}, token)
      .then((result) => {
        if (!active) return;
        setConfig(result);
        setForm({
          text_model_id: result.text_model_id || "",
          video_understanding_model_id: result.video_understanding_model_id || "",
          image_model_ids: result.image_model_ids,
          video_model_ids: result.video_model_ids,
        });
        setError("");
      })
      .catch((reason) => { if (active) setError(errorMessage(reason, "默认模型配置读取失败")); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [revision, token]);

  const candidates = (capability: ModelCapability) => config?.candidates.filter((model) => model.capability === capability) || [];
  const toggle = (field: "image_model_ids" | "video_model_ids", id: string) => {
    setForm((current) => ({
      ...current,
      [field]: current[field].includes(id) ? current[field].filter((item) => item !== id) : [...current[field], id],
    }));
  };
  const save = async (event: FormEvent) => {
    event.preventDefault(); setSaving(true); setError(""); setMessage("");
    try {
      await apiRequest("/admin/providers/default-model-config", { method: "PATCH", body: JSON.stringify(form) }, token);
      setMessage("AI 默认大模型配置已保存");
    } catch (reason) { setError(errorMessage(reason, "默认模型配置保存失败")); }
    finally { setSaving(false); }
  };

  return <section className="section-card default-model-config">
    <header><div><span className="kicker">DEFAULT MODEL ROUTING</span><h2>AI 默认大模型配置</h2><p>仅显示已启用、拥有启用 API Key 且模型自身已启用的供应商模型。</p></div></header>
    {loading ? <div className="loading-card"><span className="spinner" />正在读取默认模型配置…</div> : !config ? <div className="form-error">{error || "默认模型配置不可用"}</div> : <form onSubmit={save}>
      <div className="default-model-selects">
        <label>默认文本大模型<select value={form.text_model_id} onChange={(event) => setForm({ ...form, text_model_id: event.target.value })} required><option value="">请选择文本大模型</option>{candidates("TEXT_GENERATION").map((model) => <option key={model.id} value={model.id}>{defaultModelLabel(model)}</option>)}</select><small>{candidates("TEXT_GENERATION").length ? "所有文本任务默认使用此模型" : "当前没有符合条件的文本生成模型"}</small></label>
        <label>默认视频理解大模型<select value={form.video_understanding_model_id} onChange={(event) => setForm({ ...form, video_understanding_model_id: event.target.value })} required><option value="">请选择视频理解大模型</option>{candidates("VIDEO_UNDERSTANDING").map((model) => <option key={model.id} value={model.id}>{defaultModelLabel(model)}</option>)}</select><small>{candidates("VIDEO_UNDERSTANDING").length ? "视频解析和分镜理解默认使用此模型" : "当前没有符合条件的视频理解模型"}</small></label>
      </div>
      <div className="default-model-check-groups">
        <ModelCheckboxGroup title="图片生成大模型" empty="当前没有符合条件的图片生成模型" models={candidates("IMAGE_GENERATION")} selected={form.image_model_ids} onToggle={(id) => toggle("image_model_ids", id)} />
        <ModelCheckboxGroup title="视频生成大模型" empty="当前没有符合条件的视频生成模型" models={candidates("VIDEO_GENERATION")} selected={form.video_model_ids} onToggle={(id) => toggle("video_model_ids", id)} />
      </div>
      {error && <div className="form-error">{error}</div>}{message && <div className="form-success">{message}</div>}
      <footer><button className="primary" disabled={saving || !form.text_model_id || !form.video_understanding_model_id}>{saving ? "保存中…" : "保存默认模型配置"}</button></footer>
    </form>}
  </section>;
}

function ModelCheckboxGroup({ title, empty, models, selected, onToggle }: {
  title: string;
  empty: string;
  models: DefaultModelCandidate[];
  selected: string[];
  onToggle: (id: string) => void;
}) {
  return <fieldset><legend>{title}<small>可多选</small></legend>{models.length ? <div className="default-model-options">{models.map((model) => <label key={model.id}><input type="checkbox" checked={selected.includes(model.id)} onChange={() => onToggle(model.id)} /><span><strong>{defaultModelLabel(model)}</strong><small>{model.model_code}</small></span></label>)}</div> : <div className="empty-model">{empty}</div>}</fieldset>;
}

function defaultTestPayload(model: ProviderModel): Record<string, unknown> {
  if (model.capability === "TEXT_GENERATION") return { prompt: "请只回复：模型连接测试成功" };
  if (model.capability === "VIDEO_UNDERSTANDING") return { prompt: "请描述视频中的关键事件，并标注重要片段的时间戳。" };
  if (model.capability === "IMAGE_GENERATION") return { prompt: "一枚极简绿色圆形图标，白色背景" };
  return { prompt: "一只纸飞机缓慢飞过蓝天", seconds: 5 };
}

function isGeminiVideoUnderstanding(model: ProviderModel): boolean {
  return model.model_code === "gem-3.7-flash" && model.capability === "VIDEO_UNDERSTANDING" && model.api_protocol.toLowerCase() === "gemini";
}

function ModelTestModal({ token, provider, model, credentials, onClose }: {
  token: string;
  provider: Provider;
  model: ProviderModel;
  credentials: ProviderCredential[];
  onClose: () => void;
}) {
  const [credentialId, setCredentialId] = useState(credentials[0]?.id || "");
  const [payload, setPayload] = useState(JSON.stringify(defaultTestPayload(model), null, 2));
  const [geminiVideo, setGeminiVideo] = useState({
    video_uri: "",
    mime_type: "video/mp4",
    prompt: "请描述视频中的关键事件，同时概括画面与音频信息，并为重要片段标注 MM:SS 时间戳。",
    media_resolution: "",
  });
  const [result, setResult] = useState<ModelTestRecord | null>(null);
  const [error, setError] = useState("");
  const [running, setRunning] = useState(false);
  const createTest = async (event: FormEvent) => {
    event.preventDefault(); setRunning(true); setError("");
    try {
      const requestPayload = isGeminiVideoUnderstanding(model) ? {
        contents: [{
          role: "user",
          parts: [
            {
              file_data: { file_uri: geminiVideo.video_uri.trim(), mime_type: geminiVideo.mime_type },
              ...(geminiVideo.media_resolution ? { media_resolution: geminiVideo.media_resolution } : {}),
            },
            { text: geminiVideo.prompt.trim() },
          ],
        }],
      } : JSON.parse(payload);
      const response = await apiRequest<ModelTestRecord>(`/admin/providers/${provider.id}/models/${model.id}/tests`, {
        method: "POST",
        body: JSON.stringify({ credential_id: credentialId || undefined, payload: requestPayload }),
      }, token);
      setResult(response);
    } catch (reason) { setError(errorMessage(reason, "模型测试失败")); }
    finally { setRunning(false); }
  };
  const queryTest = async () => {
    if (!result) return;
    setRunning(true); setError("");
    try {
      setResult(await apiRequest<ModelTestRecord>(`/admin/model-tests/${result.id}/query`, { method: "POST" }, token));
    } catch (reason) { setError(errorMessage(reason, "任务查询失败")); }
    finally { setRunning(false); }
  };
  return <div className="modal-backdrop"><form className="modal model-test-modal" onSubmit={createTest}>
    <header><div><span className="kicker">MODEL API TEST</span><h2>测试 · {model.model_alias}</h2><p>{provider.display_name} · {model.api_protocol}</p></div><button type="button" onClick={onClose}>×</button></header>
    <div className="test-warning">测试会调用供应商真实接口并可能消耗积分。API Key 仅在服务端解密使用，不会返回浏览器。</div>
    <label>使用 API Key<select value={credentialId} onChange={(event) => setCredentialId(event.target.value)} required>{credentials.length ? credentials.map((credential) => <option key={credential.id} value={credential.id}>{credential.name} · {credential.masked_hint}</option>) : <option value="">没有启用的 API Key</option>}</select></label>
    {isGeminiVideoUnderstanding(model) ? <>
      <div className="model-doc-guide"><strong>Gemini 官方视频理解格式</strong><p>推荐填写 Gemini File API 返回的文件 URI；也可测试公开视频或 YouTube URL。大型、长视频请先通过 File API 上传并等待文件状态变为 ACTIVE。本测试不会把视频下载到服务器。</p><a href="https://ai.google.dev/gemini-api/docs/video-understanding?hl=zh-cn" target="_blank" rel="noreferrer">查看 Google 官方视频理解文档</a></div>
      <label>视频 URI / URL<input type="url" value={geminiVideo.video_uri} onChange={(event) => setGeminiVideo({ ...geminiVideo, video_uri: event.target.value })} placeholder="Gemini File API URI 或公开视频 URL" required /></label>
      <div className="two-columns"><label>视频 MIME 类型<select value={geminiVideo.mime_type} onChange={(event) => setGeminiVideo({ ...geminiVideo, mime_type: event.target.value })}><option>video/mp4</option><option>video/mpeg</option><option>video/mov</option><option>video/avi</option><option>video/x-flv</option><option>video/mpg</option><option>video/webm</option><option>video/wmv</option><option>video/3gpp</option></select></label><label>媒体分辨率<select value={geminiVideo.media_resolution} onChange={(event) => setGeminiVideo({ ...geminiVideo, media_resolution: event.target.value })}><option value="">默认</option><option value="MEDIA_RESOLUTION_LOW">低（节省 Token）</option><option value="MEDIA_RESOLUTION_MEDIUM">中</option><option value="MEDIA_RESOLUTION_HIGH">高（更多细节）</option></select></label></div>
      <label>视频分析提示<textarea className="compact-textarea" value={geminiVideo.prompt} onChange={(event) => setGeminiVideo({ ...geminiVideo, prompt: event.target.value })} required /></label>
      <label>最终请求预览<pre>{JSON.stringify({ contents: [{ role: "user", parts: [{ file_data: { file_uri: geminiVideo.video_uri || "<待填写>", mime_type: geminiVideo.mime_type }, ...(geminiVideo.media_resolution ? { media_resolution: geminiVideo.media_resolution } : {}) }, { text: geminiVideo.prompt }] }] }, null, 2)}</pre></label>
    </> : <label>创建任务参数 JSON<textarea value={payload} onChange={(event) => setPayload(event.target.value)} spellCheck={false} /></label>}
    {error && <div className="form-error">{error}</div>}
    {result && <section className="test-result"><header><strong>测试结果</strong><span className={`status ${result.status === "SUCCEEDED" ? "good" : result.status.includes("FAILED") ? "bad" : "warn"}`}>{result.status}</span></header>
      <div className="test-meta"><span>创建 HTTP：{result.create_http_status ?? "—"}</span><span>耗时：{result.create_duration_ms ?? "—"} ms</span><span>任务 ID：{result.remote_task_id || "—"}</span></div>
      {result.error_message && <div className="form-error">{result.error_message}</div>}
      <label>创建响应<pre>{JSON.stringify(result.create_response_json, null, 2)}</pre></label>
      {result.query_response_json !== null && <label>查询响应<pre>{JSON.stringify(result.query_response_json, null, 2)}</pre></label>}
    </section>}
    <footer>{result?.remote_task_id && model.query_endpoint && <button type="button" className="secondary" onClick={() => void queryTest()} disabled={running}>{running ? "查询中…" : "查询任务"}</button>}<button type="button" className="secondary" onClick={onClose}>关闭</button><button className="primary" disabled={running || !credentialId || (isGeminiVideoUnderstanding(model) && (!geminiVideo.video_uri.trim() || !geminiVideo.prompt.trim()))}>{running ? "测试中…" : result ? "重新创建测试" : "创建测试任务"}</button></footer>
  </form></div>;
}

function CredentialModal({ token, providerId, credential, onClose, onSaved }: { token: string; providerId: string; credential: ProviderCredential | null; onClose: () => void; onSaved: () => Promise<void> }) {
  const [form, setForm] = useState({
    name: credential?.name || "",
    api_key: "",
    status: credential?.status || "ACTIVE",
    balance: credential?.balance === null || credential?.balance === undefined ? "" : String(credential.balance),
    balance_currency: credential?.balance_currency || "CREDITS",
    notes: credential?.notes || "",
  });
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setSaving(true); setError("");
    try {
      const payload: Record<string, unknown> = {
        name: form.name, status: form.status, balance: form.balance === "" ? undefined : Number(form.balance),
        balance_currency: form.balance_currency, notes: form.notes,
      };
      if (form.api_key) payload.api_key = form.api_key;
      await apiRequest(credential ? `/admin/providers/${providerId}/credentials/${credential.id}` : `/admin/providers/${providerId}/credentials`, {
        method: credential ? "PATCH" : "POST", body: JSON.stringify(payload),
      }, token);
      await onSaved();
    } catch (reason) { setError(errorMessage(reason, credential ? "API Key 更新失败" : "API Key 创建失败")); }
    finally { setSaving(false); }
  };
  return <div className="modal-backdrop"><form className="modal" onSubmit={submit}><header><div><span className="kicker">{credential ? "EDIT API KEY" : "NEW API KEY"}</span><h2>{credential ? "编辑 API Key" : "新增 API Key"}</h2></div><button type="button" onClick={onClose}>×</button></header>
    <div className="two-columns"><label>名称<input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="默认生产密钥" required /></label><label>状态<select value={form.status} onChange={(event) => setForm({ ...form, status: event.target.value })}><option value="ACTIVE">启用</option><option value="DISABLED">停用</option></select></label></div>
    <label>API Key<input type="password" value={form.api_key} onChange={(event) => setForm({ ...form, api_key: event.target.value })} placeholder={credential ? `留空保持 ${credential.masked_hint}` : "输入供应商 API Key"} required={!credential} autoComplete="new-password" /></label>
    <div className="two-columns"><label>余额<input type="number" min="0" step="0.000001" value={form.balance} onChange={(event) => setForm({ ...form, balance: event.target.value })} placeholder="可留空" /></label><label>余额单位<input value={form.balance_currency} onChange={(event) => setForm({ ...form, balance_currency: event.target.value })} placeholder="CREDITS" required /></label></div>
    <label>备注<textarea className="compact-textarea" value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} placeholder="用途、额度或轮换说明" /></label>
    {error && <div className="form-error">{error}</div>}<footer><button type="button" className="secondary" onClick={onClose}>取消</button><button className="primary" disabled={saving}>{saving ? "保存中…" : "保存 API Key"}</button></footer>
  </form></div>;
}

function ProviderModal({ token, provider, onClose, onSaved }: { token: string; provider: Provider | null; onClose: () => void; onSaved: () => Promise<void> }) {
  const [form, setForm] = useState({
    code: provider?.code || "",
    display_name: provider?.display_name || "",
    adapter_type: provider?.adapter_type || "openai-compatible",
    base_url: provider?.base_url || "https://",
    status: provider?.status || "DISABLED",
    config: JSON.stringify(provider?.config_json ?? {}, null, 2),
  });
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setSaving(true); setError("");
    try {
      await apiRequest(provider ? `/admin/providers/${provider.id}` : "/admin/providers", {
        method: provider ? "PATCH" : "POST",
        body: JSON.stringify({ ...form, config: JSON.parse(form.config) }),
      }, token);
      await onSaved();
    } catch (reason) { setError(errorMessage(reason, provider ? "更新失败" : "创建失败")); }
    finally { setSaving(false); }
  };
  return <div className="modal-backdrop"><form className="modal" onSubmit={submit}><header><div><span className="kicker">{provider ? "EDIT PROVIDER" : "NEW PROVIDER"}</span><h2>{provider ? "编辑 AI 供应商" : "新增 AI 供应商"}</h2></div><button type="button" onClick={onClose}>×</button></header>
    <div className="two-columns"><label>供应商 code<input value={form.code} onChange={(event) => setForm({ ...form, code: event.target.value })} placeholder="provider_code" required /></label><label>显示名称<input value={form.display_name} onChange={(event) => setForm({ ...form, display_name: event.target.value })} required /></label></div>
    <div className="two-columns"><label>Adapter 类型<input value={form.adapter_type} onChange={(event) => setForm({ ...form, adapter_type: event.target.value })} required /></label><label>状态<select value={form.status} onChange={(event) => setForm({ ...form, status: event.target.value })}><option value="ACTIVE">启用</option><option value="DISABLED">停用</option><option value="DEGRADED">降级</option></select></label></div>
    <label>API Base URL<input value={form.base_url} onChange={(event) => setForm({ ...form, base_url: event.target.value })} required /></label>
    <label>扩展配置 JSON<textarea value={form.config} onChange={(event) => setForm({ ...form, config: event.target.value })} spellCheck={false} /></label>
    {error && <div className="form-error">{error}</div>}<footer><button type="button" className="secondary" onClick={onClose}>取消</button><button className="primary" disabled={saving}>{saving ? "保存中…" : "保存供应商"}</button></footer>
  </form></div>;
}

type ModelForm = {
  model_code: string; display_name: string; model_alias: string; capability: ModelCapability;
  api_protocol: string; generation_endpoint: string; query_endpoint: string;
  credit_cost: number; max_reference_images: number; supports_reference_video: boolean;
  supports_real_person: boolean;
  supports_async_tasks: boolean; sort_order: number; description: string; status: string;
  parameter_schema: string; config: string;
  resolution_prices: ResolutionPrice[];
};

function modelPayload(model: ProviderModel | ModelForm) {
  const parameterSchema = "parameter_schema" in model ? JSON.parse(model.parameter_schema) : model.parameter_schema_json;
  const config = "config" in model ? JSON.parse(model.config) : model.config_json;
  return {
    model_code: model.model_code, display_name: model.display_name, model_alias: model.model_alias,
    capability: model.capability, api_protocol: model.api_protocol, generation_endpoint: model.generation_endpoint,
    query_endpoint: model.query_endpoint || "", credit_cost: Number(model.credit_cost),
    max_reference_images: Number(model.max_reference_images), supports_reference_video: model.supports_reference_video,
    supports_real_person: model.capability === "VIDEO_GENERATION" && model.supports_real_person,
    supports_async_tasks: model.supports_async_tasks, sort_order: Number(model.sort_order),
    description: model.description, status: model.status, parameter_schema: parameterSchema, config,
    resolution_prices: model.resolution_prices.map((price) => ({ resolution: price.resolution.trim(), credit_cost: Number(price.credit_cost) })),
  };
}

function ModelModal({ token, providerId, model, onClose, onSaved }: { token: string; providerId: string; model: ProviderModel | null; onClose: () => void; onSaved: () => Promise<void> }) {
  const [form, setForm] = useState<ModelForm>({
    model_code: model?.model_code || "", display_name: model?.display_name || "", model_alias: model?.model_alias || "",
    capability: model?.capability || "TEXT_GENERATION", api_protocol: model?.api_protocol || "openai",
    generation_endpoint: model?.generation_endpoint || "/v1/chat/completions", query_endpoint: model?.query_endpoint || "",
    credit_cost: model?.credit_cost || 1, max_reference_images: model?.max_reference_images || 0,
    supports_reference_video: model?.supports_reference_video || false,
    supports_real_person: model?.supports_real_person || false,
    supports_async_tasks: model?.supports_async_tasks || false,
    sort_order: model?.sort_order ?? 100, description: model?.description || "", status: model?.status || "DISABLED",
    parameter_schema: JSON.stringify(model?.parameter_schema_json ?? {}, null, 2), config: JSON.stringify(model?.config_json ?? {}, null, 2),
    resolution_prices: model?.resolution_prices?.map((price) => ({ ...price })) || [],
  });
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setSaving(true); setError("");
    try {
      await apiRequest(model ? `/admin/providers/${providerId}/models/${model.id}` : `/admin/providers/${providerId}/models`, {
        method: model ? "PATCH" : "POST", body: JSON.stringify(modelPayload(form)),
      }, token);
      await onSaved();
    } catch (reason) { setError(errorMessage(reason, model ? "模型更新失败" : "模型创建失败")); }
    finally { setSaving(false); }
  };
  return <div className="modal-backdrop"><form className="modal model-modal" onSubmit={submit}><header><div><span className="kicker">{model ? "EDIT MODEL" : "NEW MODEL"}</span><h2>{model ? "编辑大模型" : "新增大模型"}</h2></div><button type="button" onClick={onClose}>×</button></header>
    <p className="supplier-pricing-note">下方编辑的是未乘系数的基础积分。用户最终单价 = 基础积分 × 配置中心对应模型类型系数；分辨率价格同样适用。</p>
    <div className="three-columns"><label>名称<input value={form.display_name} onChange={(event) => setForm({ ...form, display_name: event.target.value })} placeholder="模型官方名称" required /></label><label>模型值<input value={form.model_code} onChange={(event) => setForm({ ...form, model_code: event.target.value })} placeholder="gpt-5.6-sol" required /></label><label>模型别名<input value={form.model_alias} onChange={(event) => setForm({ ...form, model_alias: event.target.value })} placeholder="客户端展示名称" required /></label></div>
    <div className="three-columns"><label>模型类型<select value={form.capability} onChange={(event) => { const capability = event.target.value as ModelCapability; const isMedia = capability === "IMAGE_GENERATION" || capability === "VIDEO_GENERATION"; setForm({ ...form, capability, resolution_prices: isMedia && !form.resolution_prices.length ? [{ resolution: capability === "IMAGE_GENERATION" ? "1K" : "720p", credit_cost: form.credit_cost }] : (isMedia ? form.resolution_prices : []) }); }}>{capabilityOrder.map((capability) => <option key={capability} value={capability}>{capabilityLabels[capability]}</option>)}</select></label><label>接口协议<input value={form.api_protocol} onChange={(event) => setForm({ ...form, api_protocol: event.target.value })} placeholder="openai / gemini / media" required /></label><label>状态<select value={form.status} onChange={(event) => setForm({ ...form, status: event.target.value })}><option value="ACTIVE">启用</option><option value="DISABLED">停用</option></select></label></div>
    <div className="two-columns"><label>生成接口地址<input value={form.generation_endpoint} onChange={(event) => setForm({ ...form, generation_endpoint: event.target.value })} placeholder="/v1/chat/completions 或 HTTPS 地址" required /></label><label>查询接口地址<input value={form.query_endpoint} onChange={(event) => setForm({ ...form, query_endpoint: event.target.value })} placeholder="异步模型填写" /></label></div>
    <div className="three-columns"><label>{form.capability === "VIDEO_GENERATION" ? "每秒消耗积分数（整数）" : "每次消耗积分数（整数）"}<input type="number" min="1" max="100000" value={form.credit_cost} onChange={(event) => setForm({ ...form, credit_cost: Number(event.target.value) })} required /></label><label>支持参考图数量<input type="number" min="0" max="255" value={form.max_reference_images} onChange={(event) => setForm({ ...form, max_reference_images: Number(event.target.value) })} required /></label><label>排序值<input type="number" min="0" max="100000" value={form.sort_order} onChange={(event) => setForm({ ...form, sort_order: Number(event.target.value) })} required /></label></div>
    {(form.capability === "IMAGE_GENERATION" || form.capability === "VIDEO_GENERATION") && <section className="resolution-editor"><header><div><strong>分辨率积分定价</strong><small>{form.capability === "VIDEO_GENERATION" ? "每个价格按生成视频秒数计费" : "每个价格按生成图片张数计费"}</small></div><button type="button" className="secondary" onClick={() => setForm({ ...form, resolution_prices: [...form.resolution_prices, { resolution: "", credit_cost: form.credit_cost }] })}>增加分辨率</button></header>{form.resolution_prices.map((price, index) => <div className="resolution-row" key={index}><label>分辨率<input value={price.resolution} placeholder={form.capability === "VIDEO_GENERATION" ? "例如 720p" : "例如 1K"} onChange={(event) => setForm({ ...form, resolution_prices: form.resolution_prices.map((item, itemIndex) => itemIndex === index ? { ...item, resolution: event.target.value } : item) })} required /></label><label>{form.capability === "VIDEO_GENERATION" ? "每秒积分" : "每张积分"}<input type="number" min="1" max="100000" value={price.credit_cost} onChange={(event) => setForm({ ...form, resolution_prices: form.resolution_prices.map((item, itemIndex) => itemIndex === index ? { ...item, credit_cost: Number(event.target.value) } : item) })} required /></label><button type="button" className="secondary" onClick={() => setForm({ ...form, resolution_prices: form.resolution_prices.filter((_, itemIndex) => itemIndex !== index) })}>删除</button></div>)}</section>}
    <div className="checkbox-row"><label><input type="checkbox" checked={form.supports_reference_video} onChange={(event) => setForm({ ...form, supports_reference_video: event.target.checked })} />支持参考视频</label>{form.capability === "VIDEO_GENERATION" && <label><input type="checkbox" checked={form.supports_real_person} onChange={(event) => setForm({ ...form, supports_real_person: event.target.checked })} />支持真人</label>}<label><input type="checkbox" checked={form.supports_async_tasks} onChange={(event) => setForm({ ...form, supports_async_tasks: event.target.checked })} />异步任务（需要查询接口）</label></div>
    <label>模型说明<textarea className="compact-textarea" value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} /></label>
    <div className="two-columns"><label>参数 Schema JSON<textarea value={form.parameter_schema} onChange={(event) => setForm({ ...form, parameter_schema: event.target.value })} spellCheck={false} /></label><label>扩展配置 JSON<textarea value={form.config} onChange={(event) => setForm({ ...form, config: event.target.value })} spellCheck={false} /></label></div>
    {error && <div className="form-error">{error}</div>}<footer><button type="button" className="secondary" onClick={onClose}>取消</button><button className="primary" disabled={saving}>{saving ? "保存中…" : "保存大模型"}</button></footer>
  </form></div>;
}
