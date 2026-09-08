"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { apiRequest } from "@/lib/api";

type ScriptAnalysisConfig = { prompt: string; credit_cost: number; revision: number; updated_at?: string };

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
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await apiRequest<ScriptAnalysisConfig>("/admin/configs/script-analysis", {}, token);
      setConfig(result); setPrompt(result.prompt); setCreditCost(result.credit_cost); setError("");
    } catch (reason) { setError(errorMessage(reason, "剧本提取配置读取失败")); }
    finally { setLoading(false); }
  }, [token]);
  useEffect(() => { void load(); }, [load]);
  const save = async (event: FormEvent) => {
    event.preventDefault(); if (!config) return;
    setSaving(true); setError(""); setMessage("");
    try {
      const result = await apiRequest<ScriptAnalysisConfig>("/admin/configs/script-analysis", { method: "PATCH", body: JSON.stringify({ prompt, credit_cost: creditCost, revision: config.revision }) }, token);
      setConfig(result); setPrompt(result.prompt); setCreditCost(result.credit_cost); setMessage(mode === "prompt" ? "剧本提取提示词已保存" : "剧本提取积分价格已保存");
    } catch (reason) { setError(errorMessage(reason, "剧本提取配置保存失败")); }
    finally { setSaving(false); }
  };
  return <section className="section-card default-model-config">
    <header><div><span className="kicker">{mode === "prompt" ? "SCRIPT EXTRACTION" : "FEATURE PRICING"}</span><h2>{mode === "prompt" ? "剧本提取提示词" : "剧本与视频提取定价"}</h2><p>{mode === "prompt" ? "设置剧本文件交给默认文本大模型时使用的忠实提取提示词。" : "设置每次剧本文件分析或视频理解生成分镜脚本固定扣除的积分；价格修改只影响后续任务。"}</p></div></header>
    {loading ? <div className="loading-card"><span className="spinner" />正在读取剧本提取配置…</div> : config ? <form onSubmit={save}>
      {mode === "prompt" ? <label>忠实提取提示词<textarea value={prompt} rows={16} minLength={100} maxLength={100000} onChange={(event) => setPrompt(event.target.value)} required /><small>应明确禁止发挥、补写和衍生，并要求输出完整结构化 JSON。</small></label>
        : <label>每次提取所需积分<input type="number" min="0" max="1000000" step="0.000001" value={creditCost} onChange={(event) => setCreditCost(Number(event.target.value))} required /><small>剧本文件和视频生成分镜脚本共用此固定价格；模型自身计费不会再次向用户重复扣除。</small></label>}
      {error && <div className="form-error">{error}</div>}{message && <div className="form-success">{message}</div>}
      <footer><button className="primary" disabled={saving || (mode === "prompt" && prompt.trim().length < 100)}>{saving ? "保存中…" : mode === "prompt" ? "保存提取提示词" : "保存功能定价"}</button></footer>
    </form> : <div className="form-error">{error || "剧本提取配置不可用"}</div>}
  </section>;
}
