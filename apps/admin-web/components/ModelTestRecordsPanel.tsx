"use client";

import { useCallback, useEffect, useState } from "react";
import { apiRequest } from "@/lib/api";

type TestRecord = {
  id: string;
  provider_name: string;
  provider_code: string;
  model_alias: string;
  model_code: string;
  capability: string;
  credential_name: string;
  credential_hint: string;
  status: string;
  request_json: unknown;
  create_url: string;
  create_http_status: number | null;
  create_duration_ms: number | null;
  create_response_json: unknown;
  remote_task_id: string | null;
  query_endpoint: string | null;
  query_url: string | null;
  query_http_status: number | null;
  query_duration_ms: number | null;
  query_response_json: unknown;
  error_message: string | null;
  last_queried_at: string | null;
  created_at: string;
};

function statusTone(status: string) {
  if (status === "SUCCEEDED") return "good";
  if (status.includes("FAILED")) return "bad";
  return "warn";
}

function formatDate(value: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString("zh-CN", { hour12: false });
}

function errorMessage(reason: unknown) {
  return reason instanceof Error ? reason.message : "测试记录读取失败";
}

export function ModelTestRecordsPanel({ token }: { token: string }) {
  const [records, setRecords] = useState<TestRecord[] | null>(null);
  const [selected, setSelected] = useState<TestRecord | null>(null);
  const [error, setError] = useState("");
  const [queryingId, setQueryingId] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const rows = await apiRequest<TestRecord[]>("/admin/model-tests?limit=100", {}, token);
      setRecords(rows);
      setSelected((current) => current ? rows.find((row) => row.id === current.id) || null : null);
      setError("");
    } catch (reason) { setError(errorMessage(reason)); }
  }, [token]);
  useEffect(() => { void load(); }, [load]);

  const query = async (record: TestRecord) => {
    setQueryingId(record.id); setError("");
    try {
      const updated = await apiRequest<TestRecord>(`/admin/model-tests/${record.id}/query`, { method: "POST" }, token);
      setSelected(updated);
      await load();
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setQueryingId(null); }
  };

  if (error && !records) return <div className="form-error">{error}</div>;
  if (!records) return <div className="loading-card"><span className="spinner" />正在读取测试记录…</div>;
  return <>
    <section className="section-card table-card test-records-card">
      <header><div><span className="kicker">MODEL TEST HISTORY</span><h2>测试记录</h2><p>保存模型任务创建与查询的脱敏请求、响应、耗时和状态。</p></div><div className="record-header-actions"><span className="record-count">{records.length} 条</span><button className="secondary" onClick={() => void load()}>刷新</button></div></header>
      {error && <div className="form-error">{error}</div>}
      {records.length ? <div className="table-scroll"><table><thead><tr><th>供应商</th><th>模型</th><th>状态</th><th>创建接口</th><th>耗时</th><th>任务 ID</th><th>测试时间</th><th>操作</th></tr></thead><tbody>{records.map((record) => <tr key={record.id}>
        <td>{record.provider_name}</td><td>{record.model_alias}</td><td><span className={`status ${statusTone(record.status)}`}>{record.status}</span></td><td>{record.create_http_status ?? "—"}</td><td>{record.create_duration_ms ?? "—"} ms</td><td><code>{record.remote_task_id || "—"}</code></td><td>{formatDate(record.created_at)}</td><td><div className="table-actions"><button className="secondary" onClick={() => setSelected(record)}>查看</button>{record.remote_task_id && record.query_endpoint && <button className="secondary" disabled={queryingId === record.id} onClick={() => void query(record)}>{queryingId === record.id ? "查询中…" : "查询"}</button>}</div></td>
      </tr>)}</tbody></table></div> : <div className="empty-row">还没有模型测试记录，请从 AI 供应商中的模型卡片发起测试。</div>}
    </section>
    {selected && <div className="modal-backdrop"><div className="modal model-test-modal test-record-detail"><header><div><span className="kicker">TEST RECORD</span><h2>{selected.model_alias}</h2><p>{selected.provider_name} · {selected.model_code}</p></div><button type="button" onClick={() => setSelected(null)}>×</button></header>
      <div className="test-meta"><span className={`status ${statusTone(selected.status)}`}>{selected.status}</span><span>API Key：{selected.credential_name} · {selected.credential_hint}</span><span>创建：{selected.create_http_status ?? "—"} / {selected.create_duration_ms ?? "—"} ms</span><span>查询：{selected.query_http_status ?? "—"} / {selected.query_duration_ms ?? "—"} ms</span></div>
      {selected.error_message && <div className="form-error">{selected.error_message}</div>}
      <label>创建请求<pre>{JSON.stringify(selected.request_json, null, 2)}</pre></label>
      <label>创建响应<pre>{JSON.stringify(selected.create_response_json, null, 2)}</pre></label>
      {selected.query_response_json !== null && <label>最近查询响应<pre>{JSON.stringify(selected.query_response_json, null, 2)}</pre></label>}
      <footer>{selected.remote_task_id && selected.query_endpoint && <button className="primary" disabled={queryingId === selected.id} onClick={() => void query(selected)}>{queryingId === selected.id ? "查询中…" : "再次查询任务"}</button>}<button className="secondary" onClick={() => setSelected(null)}>关闭</button></footer>
    </div></div>}
  </>;
}
