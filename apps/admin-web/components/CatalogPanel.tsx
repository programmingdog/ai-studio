"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { apiRequest } from "@/lib/api";

type CatalogKind = "visual-styles" | "creative-types";
type Category = { record_id: string; code: string; name: string; description: string; sort_order: number; status: string; item_count: number };
type CatalogItem = { record_id: string; code: string; category_id: string; category: string; name: string; description: string; prompt: string; sort_order: number; status: string };
type CategoryForm = Omit<Category, "record_id" | "item_count">;
type ItemForm = Omit<CatalogItem, "record_id" | "category">;

const emptyCategory: CategoryForm = { code: "", name: "", description: "", sort_order: 10, status: "ACTIVE" };
const emptyItem: ItemForm = { code: "", category_id: "", name: "", description: "", prompt: "", sort_order: 10, status: "ACTIVE" };

export function CatalogPanel({ token, kind }: { token: string; kind: CatalogKind }) {
  const title = kind === "visual-styles" ? "画风设定" : "创作类型";
  const [categories, setCategories] = useState<Category[]>([]);
  const [items, setItems] = useState<CatalogItem[]>([]);
  const [categoryEditor, setCategoryEditor] = useState<Category | "new" | null>(null);
  const [itemEditor, setItemEditor] = useState<CatalogItem | "new" | null>(null);
  const [selectedCategory, setSelectedCategory] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    const [nextCategories, nextItems] = await Promise.all([
      apiRequest<Category[]>(`/admin/catalogs/${kind}/categories`, {}, token),
      apiRequest<CatalogItem[]>(`/admin/catalogs/${kind}/items`, {}, token),
    ]);
    setCategories(nextCategories.map((row) => ({ ...row, sort_order: Number(row.sort_order), item_count: Number(row.item_count) })));
    setItems(nextItems.map((row) => ({ ...row, sort_order: Number(row.sort_order) })));
  }, [kind, token]);

  useEffect(() => { setError(""); setMessage(""); void load().catch((reason) => setError(reason instanceof Error ? reason.message : "读取失败")); }, [load]);
  const visibleItems = useMemo(() => selectedCategory ? items.filter((item) => item.category_id === selectedCategory) : items, [items, selectedCategory]);
  const removeCategory = async (category: Category) => { if (!window.confirm(`确定删除分类“${category.name}”吗？`)) return; try { await apiRequest(`/admin/catalogs/${kind}/categories/${category.record_id}`, { method: "DELETE" }, token); setMessage("分类已删除"); await load(); } catch (reason) { setError(reason instanceof Error ? reason.message : "删除失败"); } };
  const removeItem = async (item: CatalogItem) => { if (!window.confirm(`确定删除“${item.name}”吗？`)) return; try { await apiRequest(`/admin/catalogs/${kind}/items/${item.record_id}`, { method: "DELETE" }, token); setMessage("条目已删除"); await load(); } catch (reason) { setError(reason instanceof Error ? reason.message : "删除失败"); } };

  return <>
    <section className="section-card catalog-header"><header><div><span className="kicker">SERVER CATALOG</span><h2>{title}</h2><p>分类与条目保存在独立数据表中，启用的数据会直接提供给客户端。</p></div><div className="catalog-header-actions"><button className="secondary" onClick={() => setCategoryEditor("new")}>新建分类</button><button className="primary" disabled={!categories.length} onClick={() => setItemEditor("new")}>新增{title}</button></div></header>{error && <div className="form-error">{error}</div>}{message && <div className="form-success">{message}</div>}</section>
    <div className="catalog-layout">
      <section className="list-card catalog-categories"><header><div><span className="kicker">CATEGORIES</span><h2>分类设定</h2></div><button className={!selectedCategory ? "primary" : "secondary"} onClick={() => setSelectedCategory("")}>全部</button></header><div className="catalog-category-list">{categories.map((category) => <article className={selectedCategory === category.record_id ? "selected" : ""} key={category.record_id} onClick={() => setSelectedCategory(category.record_id)}><div><strong>{category.name}</strong><small>{category.code} · {category.item_count} 条</small></div><span className={`status ${category.status === "ACTIVE" ? "good" : "bad"}`}>{category.status}</span><footer><button onClick={(event) => { event.stopPropagation(); setCategoryEditor(category); }}>编辑</button><button onClick={(event) => { event.stopPropagation(); void removeCategory(category); }}>删除</button></footer></article>)}</div></section>
      <section className="section-card catalog-items"><header><div><span className="kicker">ITEMS</span><h2>{selectedCategory ? categories.find((category) => category.record_id === selectedCategory)?.name : `全部${title}`}</h2></div><span className="record-count">{visibleItems.length} 条</span></header><div className="catalog-item-grid">{visibleItems.map((item) => <article key={item.record_id}><header><div><span>{item.category}</span><strong>{item.name}</strong><small>{item.code}</small></div><span className={`status ${item.status === "ACTIVE" ? "good" : "bad"}`}>{item.status}</span></header><p>{item.description || "暂无说明"}</p><div className="catalog-prompt">{item.prompt}</div><footer><small>排序 {item.sort_order}</small><div><button className="secondary" onClick={() => setItemEditor(item)}>编辑</button><button className="secondary" onClick={() => void removeItem(item)}>删除</button></div></footer></article>)}</div>{!visibleItems.length && <div className="empty-row">当前分类暂无数据</div>}</section>
    </div>
    {categoryEditor && <CategoryModal title={title} value={categoryEditor === "new" ? emptyCategory : categoryEditor} editing={categoryEditor !== "new"} onClose={() => setCategoryEditor(null)} onSubmit={async (form) => { const path = categoryEditor === "new" ? `/admin/catalogs/${kind}/categories` : `/admin/catalogs/${kind}/categories/${categoryEditor.record_id}`; await apiRequest(path, { method: categoryEditor === "new" ? "POST" : "PATCH", body: JSON.stringify(form) }, token); setCategoryEditor(null); setMessage("分类已保存"); await load(); }} />}
    {itemEditor && <ItemModal title={title} categories={categories} value={itemEditor === "new" ? { ...emptyItem, category_id: selectedCategory || categories[0]?.record_id || "" } : itemEditor} editing={itemEditor !== "new"} onClose={() => setItemEditor(null)} onSubmit={async (form) => { const path = itemEditor === "new" ? `/admin/catalogs/${kind}/items` : `/admin/catalogs/${kind}/items/${itemEditor.record_id}`; await apiRequest(path, { method: itemEditor === "new" ? "POST" : "PATCH", body: JSON.stringify(form) }, token); setItemEditor(null); setMessage(`${title}已保存`); await load(); }} />}
  </>;
}

function CategoryModal({ title, value, editing, onClose, onSubmit }: { title: string; value: CategoryForm; editing: boolean; onClose: () => void; onSubmit: (value: CategoryForm) => Promise<void> }) {
  const [form, setForm] = useState(value); const [error, setError] = useState(""); const [saving, setSaving] = useState(false);
  const submit = async (event: FormEvent) => { event.preventDefault(); setSaving(true); setError(""); try { await onSubmit(form); } catch (reason) { setError(reason instanceof Error ? reason.message : "保存失败"); } finally { setSaving(false); } };
  return <div className="modal-backdrop"><form className="modal" onSubmit={submit}><header><div><span className="kicker">CATEGORY</span><h2>{editing ? "编辑" : "新建"}{title}分类</h2></div><button type="button" onClick={onClose}>×</button></header><div className="two-columns"><label>分类编码<input value={form.code} onChange={(event) => setForm({ ...form, code: event.target.value })} placeholder="例如 movie" required /></label><label>分类名称<input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} required /></label></div><label>分类说明<input value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} /></label><div className="two-columns"><label>排序<input type="number" min="0" value={form.sort_order} onChange={(event) => setForm({ ...form, sort_order: Number(event.target.value) })} /></label><label>状态<select value={form.status} onChange={(event) => setForm({ ...form, status: event.target.value })}><option value="ACTIVE">启用</option><option value="DISABLED">停用</option></select></label></div>{error && <div className="form-error">{error}</div>}<footer><button className="secondary" type="button" onClick={onClose}>取消</button><button className="primary" disabled={saving}>{saving ? "保存中…" : "保存"}</button></footer></form></div>;
}

function ItemModal({ title, categories, value, editing, onClose, onSubmit }: { title: string; categories: Category[]; value: ItemForm; editing: boolean; onClose: () => void; onSubmit: (value: ItemForm) => Promise<void> }) {
  const [form, setForm] = useState(value); const [error, setError] = useState(""); const [saving, setSaving] = useState(false);
  const submit = async (event: FormEvent) => { event.preventDefault(); setSaving(true); setError(""); try { await onSubmit(form); } catch (reason) { setError(reason instanceof Error ? reason.message : "保存失败"); } finally { setSaving(false); } };
  return <div className="modal-backdrop"><form className="modal catalog-item-modal" onSubmit={submit}><header><div><span className="kicker">CATALOG ITEM</span><h2>{editing ? "编辑" : "新增"}{title}</h2></div><button type="button" onClick={onClose}>×</button></header><div className="two-columns"><label>条目编码<input value={form.code} onChange={(event) => setForm({ ...form, code: event.target.value })} placeholder="稳定英文编码" required /></label><label>所属分类<select value={form.category_id} onChange={(event) => setForm({ ...form, category_id: event.target.value })}>{categories.map((category) => <option value={category.record_id} key={category.record_id}>{category.name}</option>)}</select></label></div><label>名称<input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} required /></label><label>适用说明<input value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} /></label><label>提示词<textarea value={form.prompt} onChange={(event) => setForm({ ...form, prompt: event.target.value })} required /></label><div className="two-columns"><label>排序<input type="number" min="0" value={form.sort_order} onChange={(event) => setForm({ ...form, sort_order: Number(event.target.value) })} /></label><label>状态<select value={form.status} onChange={(event) => setForm({ ...form, status: event.target.value })}><option value="ACTIVE">启用</option><option value="DISABLED">停用</option></select></label></div>{error && <div className="form-error">{error}</div>}<footer><button className="secondary" type="button" onClick={onClose}>取消</button><button className="primary" disabled={saving}>{saving ? "保存中…" : "保存"}</button></footer></form></div>;
}
