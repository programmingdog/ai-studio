"use client";

import { useEffect, useRef, useState } from "react";
import { apiRequest } from "@/lib/api";
import { CreditSyncResults, type CreditSyncReport } from "./CreditPricingPanel";

type PricingProvider = { id: string; display_name: string; code: string };
type PriceOption = {
  param_name: string; option_label: string; option_value: string; final_price: number | null;
  price_multiplier: number | null; price_addition: number | null; price_impact: string;
};
type PriceGroup = {
  group_name: string; is_active: boolean | null; in_key_whitelist: boolean | null;
  billing_method: string; currency: string; price_unit: string;
  base_price: number | null; min_price: number | null; input_token_price: number | null;
  output_token_price: number | null; current_time_discount: number | null; option_prices: PriceOption[];
};
type ModelPrice = {
  name: string; display_name: string; type: string; local_aliases: string[];
  available_for_this_key: boolean | null; queried_at: string; error: string | null;
  pricing_note: string; currency: string; price_unit: string; channel_groups: PriceGroup[];
};
type ProviderPrice = {
  credit_sync?: CreditSyncReport;
  provider_id: string; provider_name: string; credential_name: string; queried_at: string;
  catalog_total: number; success_count: number; failed_count: number; models: ModelPrice[];
};
const price = (value: number | null) => value === null ? "未提供" : String(value);
const time = (value: string) => new Date(value).toLocaleString("zh-CN", { hour12: false });
const typeNames: Record<string, string> = { chat: "文本", image: "图片", video: "视频", audio: "音频", tts: "语音", music: "音乐" };
function groupPrice(group: PriceGroup) {
  if (/token/i.test(group.billing_method)) return `输入 ${price(group.input_token_price)} / 输出 ${price(group.output_token_price)}`;
  return `基础价 ${price(group.base_price)}${group.min_price !== null ? ` · 最低价 ${price(group.min_price)}` : ""}`;
}
const groupState = (group: PriceGroup) => group.is_active === true ? "运行中" : group.is_active === false ? "暂停中" : "状态未知";
function displayGroups(model: ModelPrice) {
  return [...model.channel_groups].sort((left, right) =>
    Number(right.is_active === true && right.in_key_whitelist !== false) - Number(left.is_active === true && left.in_key_whitelist !== false));
}

export function useProviderPricing(token: string) {
  const [revision, setRevision] = useState(0);
  const [prices, setPrices] = useState<Record<string, ProviderPrice>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState<Record<string, boolean>>({});
  const [target, setTarget] = useState<{ provider: PricingProvider; model: string } | null>(null);
  const requests = useRef(new Map<string, AbortController>());
  useEffect(() => {
    const active = requests.current;
    return () => { active.forEach((controller) => controller.abort()); active.clear(); };
  }, [token]);

  async function fetchPrices(provider: PricingProvider) {
    if (requests.current.has(provider.id)) return;
    const controller = new AbortController();
    requests.current.set(provider.id, controller);
    setLoading((current) => ({ ...current, [provider.id]: true }));
    setErrors((current) => ({ ...current, [provider.id]: "" }));
    try {
      const result = await apiRequest<ProviderPrice>(`/admin/providers/${provider.id}/pricing/sync`, { method: "POST", signal: controller.signal }, token);
      if (!controller.signal.aborted) {
        setPrices((current) => ({ ...current, [provider.id]: result }));
        if (result.credit_sync?.enabled) setRevision((value) => value + 1);
      }
    } catch (reason) {
      if (!controller.signal.aborted) setErrors((current) => ({ ...current, [provider.id]: reason instanceof Error ? reason.message : "价格查询失败，请重试" }));
    } finally {
      if (requests.current.get(provider.id) === controller) {
        requests.current.delete(provider.id);
        setLoading((current) => ({ ...current, [provider.id]: false }));
      }
    }
  }

  return {
    revision,
    open(provider: PricingProvider, model = "") {
      setTarget({ provider, model });
      // Supplier button always fetches live; model details reuse this session's snapshot.
      if (!model || !prices[provider.id]) void fetchPrices(provider);
    },
    invalidate() {
      requests.current.forEach((controller) => controller.abort());
      requests.current.clear();
      setPrices({}); setErrors({}); setLoading({});
    },
    modelPrice(providerId: string, modelCode: string) {
      return prices[providerId]?.models.find((model) => model.name === modelCode);
    },
    modal: target && <PricingModal key={`${target.provider.id}:${target.model}`} provider={target.provider}
      data={prices[target.provider.id]} error={errors[target.provider.id]} loading={!!loading[target.provider.id]}
      initialSearch={target.model} onClose={() => setTarget(null)} onRefresh={() => void fetchPrices(target.provider)} />,
  };
}

export function ModelSupplierPrice({ model, onDetails }: { model?: ModelPrice; onDetails: () => void }) {
  const groups = model ? displayGroups(model) : [];
  return <div className="supplier-price-summary">
    <strong>供应商实时价</strong>
    {!model ? <span>尚未查询</span> : model.error ? <span className="supplier-price-error">{model.error}</span> : <>
      {model.available_for_this_key === false && <span>当前 API Key 不可用，报价仅供参考</span>}
      {groups.length ? groups.slice(0, 2).map((group, index) =>
        <span key={index}>{group.group_name}（{groupState(group)}{group.in_key_whitelist === false ? " · 不在 Key 白名单" : ""}）· {group.billing_method || "计费方式未提供"}：{groupPrice(group)} {group.currency || model.currency} {group.price_unit || model.price_unit}</span>) : <span>供应商未返回渠道报价</span>}
      <small>{model.channel_groups.length} 个渠道 · 查询于 {time(model.queried_at)} · 原始报价，非系统积分</small>
    </>}
    <button className="secondary" onClick={onDetails}>{model ? "查看价格明细" : "查询实时价格"}</button>
  </div>;
}

function PricingModal({ provider, data, error, loading, initialSearch, onClose, onRefresh }: {
  provider: PricingProvider; data?: ProviderPrice; error?: string; loading: boolean;
  initialSearch: string; onClose: () => void; onRefresh: () => void;
}) {
  const [search, setSearch] = useState(initialSearch);
  const [localOnly, setLocalOnly] = useState(false);
  const [page, setPage] = useState(0);
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.current?.focus();
    return () => previous?.focus();
  }, []);
  const query = search.trim().toLowerCase();
  const models = data?.models.filter((model) => (!localOnly || model.local_aliases.length > 0) &&
    [model.name, model.display_name, ...model.local_aliases].some((name) => name.toLowerCase().includes(query))) || [];
  const pages = Math.max(1, Math.ceil(models.length / 15));
  const currentPage = Math.min(page, pages - 1);
  return <div className="modal-backdrop" onClick={onClose}>
    <div ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="supplier-pricing-title" className="modal supplier-pricing-modal"
      onClick={(event) => event.stopPropagation()} onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
        if (event.key !== "Tab") return;
        const elements = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input, summary, [tabindex="0"]')].filter((element) => element.getClientRects().length);
        const first = elements[0], last = elements[elements.length - 1];
        if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }}>
      <header><div><span className="kicker">LIVE SUPPLIER PRICING</span><h2 id="supplier-pricing-title">{provider.display_name} · 实时价格</h2></div><button aria-label="关闭实时价格" onClick={onClose}>×</button></header>
      <p className="supplier-pricing-note">WagaAI 原始报价按 1 算力 = 1 元换算。配置中心开启自动定价后，查询/刷新会按最低可用价格更新模型积分。Token 报价不能直接当作每次或每秒价格。</p>
      {data?.credit_sync && <CreditSyncResults report={data.credit_sync} />}
      {data && <p className="supplier-pricing-note">查询时间：{time(data.queried_at)} · API Key：{data.credential_name}（首个启用密钥）<br />目录 {data.catalog_total} 个模型 · 含本地补查共 {data.models.length} 个 · 成功 {data.success_count} 个 / 失败 {data.failed_count} 个。价格为本次查询快照，关闭弹窗后仍显示在模型下方。</p>}
      <div className="supplier-price-toolbar">
        <input aria-label="搜索价格模型" placeholder="搜索模型名称、标识或本地别名" value={search} onChange={(event) => { setSearch(event.target.value); setPage(0); }} />
        <label><input type="checkbox" checked={localOnly} onChange={(event) => { setLocalOnly(event.target.checked); setPage(0); }} />仅本地已配置</label>
        <button className="primary" disabled={loading} onClick={onRefresh}>{loading ? "查询中…" : "刷新实时价格"}</button>
      </div>
      {loading && <div className="loading-card" role="status"><span className="spinner" />正在逐个查询模型价格，请稍候…{data && "下方暂为上次查询结果。"}</div>}
      {error && <div className="form-error" role="alert">{error}{data && "；下方保留上次查询结果，请注意时间。"}</div>}
      {data?.failed_count ? <div className="test-warning">部分模型价格查询失败，已单独标记；可点击刷新重试。</div> : null}
      <div className="supplier-price-models">{models.slice(currentPage * 15, (currentPage + 1) * 15).map((model) => <ModelPriceDetails key={model.name} model={model} />)}</div>
      {data && !models.length && <div className="empty-row">没有匹配的模型</div>}
      {data && <footer><span>共 {models.length} 个 · 第 {currentPage + 1}/{pages} 页</span><button className="secondary" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>上一页</button><button className="secondary" disabled={currentPage + 1 >= pages} onClick={() => setPage(currentPage + 1)}>下一页</button></footer>}
    </div>
  </div>;
}

function ModelPriceDetails({ model }: { model: ModelPrice }) {
  const [open, setOpen] = useState(false);
  const preview = displayGroups(model)[0];
  return <details className="supplier-price-model" onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary><strong>{model.local_aliases.join(" / ") || model.display_name}</strong><code>{model.name}</code><span>{typeNames[model.type] || model.type || "本地模型"}</span>
      <span className={`status ${model.error ? "bad" : "good"}`}>{model.error ? "查询失败" : `${model.channel_groups.length} 个渠道`}</span>{model.available_for_this_key === false && <span className="status warn">当前 Key 不可用</span>}
      {preview && <small className="supplier-price-preview">{preview.group_name}（{groupState(preview)}{preview.in_key_whitelist === false ? " · 不在 Key 白名单" : ""}）· {preview.billing_method}：{groupPrice(preview)} {preview.currency || model.currency} {preview.price_unit || model.price_unit} · 展开查看全部价格</small>}</summary>
    {open && <div className="supplier-price-detail">
      {model.error ? <div className="form-error">{model.error}</div> : <>
        {!model.channel_groups.length && <p>供应商未返回渠道报价</p>}
        {model.channel_groups.map((group, index) => <section className="supplier-price-channel" key={index}>
          <header><strong>{group.group_name || "未命名渠道"}</strong><span className={`status ${group.is_active === true ? "good" : "warn"}`}>{group.is_active === true ? "运行中" : group.is_active === false ? "暂停中" : "状态未知"}</span>{group.in_key_whitelist === false && <span className="status warn">不在当前 Key 白名单</span>}</header>
          <p>{group.billing_method || "计费方式未提供"} · {groupPrice(group)} {group.currency || model.currency} {group.price_unit || model.price_unit}
            {group.current_time_discount !== null && ` · 当前时段折扣系数 ${group.current_time_discount}`}</p>
          {!!group.option_prices.length && <div className="supplier-price-table"><table><thead><tr><th>参数</th><th>选项（接口值）</th><th>最终价格</th><th>价格调整</th></tr></thead><tbody>
            {group.option_prices.map((option, optionIndex) => <tr key={optionIndex}><td>{option.param_name}</td><td>{option.option_label} <code>{option.option_value}</code></td><td>{price(option.final_price)}</td><td>{option.price_impact || `倍率 ${price(option.price_multiplier)} / 加价 ${price(option.price_addition)}`}</td></tr>)}
          </tbody></table></div>}
        </section>)}
      </>}
    </div>}
  </details>;
}
