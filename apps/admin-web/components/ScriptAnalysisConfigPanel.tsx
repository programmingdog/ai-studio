"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { apiRequest } from "@/lib/api";

type ExtractionBillingMode = "OVERALL" | "PER_SEGMENT";
type ScriptAnalysisConfig = { prompt: string; credit_cost: number; remix_credit_cost: number; extraction_billing_mode: ExtractionBillingMode; revision: number; updated_at?: string };

function errorMessage(reason: unknown, fallback: string) {
  return reason instanceof Error ? reason.message : fallback;
}

export function ScriptAnalysisConfigPanel({ token }: { token: string }) {
  return <ScriptAnalysisSetting token={token} mode="prompt" />;
}

export function ScriptAnalysisPricingPanel({ token }: { token: string }) {
  return <ScriptAnalysisSetting token={token} mode="pricing" />;
}

function ScriptAnalysisSetting({ token, mode }: { token: string; mode: "prompt" | "pricing" }) {
  const [config, setConfig] = useState<ScriptAnalysisConfig | null>(null);
  const [prompt, setPrompt] = useState("");
  const [creditCost, setCreditCost] = useState(10);
  const [remixCreditCost, setRemixCreditCost] = useState(20);
  const [extractionBillingMode, setExtractionBillingMode] = useState<ExtractionBillingMode>("OVERALL");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await apiRequest<ScriptAnalysisConfig>("/admin/configs/script-analysis", {}, token);
      setConfig(result); setPrompt(result.prompt); setCreditCost(result.credit_cost); setRemixCreditCost(result.remix_credit_cost); setExtractionBillingMode(result.extraction_billing_mode || "OVERALL"); setError("");
    } catch (reason) { setError(errorMessage(reason, "剧本提取配置读取失败")); }
    finally { setLoading(false); }
  }, [token]);
  useEffect(() => { void load(); }, [load]);
  const save = async (event: FormEvent) => {
    event.preventDefault(); if (!config) return;
    setSaving(true); setError(""); setMessage("");
    try {
      const result = await apiRequest<ScriptAnalysisConfig>("/admin/configs/script-analysis", { method: "PATCH", body: JSON.stringify({ prompt, credit_cost: creditCost, remix_credit_cost: remixCreditCost, extraction_billing_mode: extractionBillingMode, revision: config.revision }) }, token);
      setConfig(result); setPrompt(result.prompt); setCreditCost(result.credit_cost); setRemixCreditCost(result.remix_credit_cost); setExtractionBillingMode(result.extraction_billing_mode || "OVERALL"); setMessage(mode === "prompt" ? "剧本提取提示词已保存" : "功能定价已保存");
    } catch (reason) { setError(errorMessage(reason, "剧本提取配置保存失败")); }
    finally { setSaving(false); }
  };
  return <section className="section-card default-model-config">
    <header><div><span className="kicker">{mode === "prompt" ? "SCRIPT EXTRACTION" : "FEATURE PRICING"}</span><h2>{mode === "prompt" ? "剧本提取提示词" : "功能定价"}</h2><p>{mode === "prompt" ? "设置剧本文件交给默认文本大模型时使用的忠实提取提示词。" : "设置剧本与视频提取、二次创作等功能的固定积分；价格修改只影响后续任务。"}</p></div></header>
    {loading ? <div className="loading-card"><span className="spinner" />正在读取剧本提取配置…</div> : config ? <form onSubmit={save}>
      {mode === "prompt" ? <label>忠实提取提示词<textarea value={prompt} rows={16} minLength={100} maxLength={100000} onChange={(event) => setPrompt(event.target.value)} required /><small>应明确禁止发挥、补写和衍生，并要求输出完整结构化 JSON。</small></label>
        : <><label>每次提取所需积分<input type="number" min="0" max="1000000" step="0.000001" value={creditCost} onChange={(event) => setCreditCost(Number(event.target.value))} required /><small>剧本文件和视频生成分镜脚本共用此固定价格；模型自身计费不会再次向用户重复扣除。</small></label><label>每次二次创作所需积分<input type="number" min="0" max="1000000" step="0.000001" value={remixCreditCost} onChange={(event) => setRemixCreditCost(Number(event.target.value))} required /><small>同时应用于剧本库二次创作和视频链接解析结果二次创作；每次向模型发起一次二创生成扣除此价格。</small></label><label>提取剧本扣费模式<select value={extractionBillingMode} onChange={(event) => setExtractionBillingMode(event.target.value as ExtractionBillingMode)}><option value="OVERALL">整体扣费模式（默认）</option><option value="PER_SEGMENT">分段单独扣费模式</option></select><small>{extractionBillingMode === "OVERALL" ? "不管视频拆分为多少段，整个提取任务只扣 1 次。" : "视频拆分为几段就扣几次；剧本文件仍按每个文件扣 1 次。"}</small></label></>}
      {error && <div className="form-error">{error}</div>}{message && <div className="form-success">{message}</div>}
      <footer><button className="primary" disabled={saving || (mode === "prompt" && prompt.trim().length < 100)}>{saving ? "保存中…" : mode === "prompt" ? "保存提取提示词" : "保存功能定价"}</button></footer>
    </form> : <div className="form-error">{error || "剧本提取配置不可用"}</div>}
  </section>;
}
