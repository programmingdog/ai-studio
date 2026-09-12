import { ChevronFirst, ChevronLast, ChevronLeft, ChevronRight } from "lucide-react";

export function RecordPagination({ page, total, totalPages, disabled = false, onPageChange, position }: { page: number; total: number; totalPages: number; disabled?: boolean; onPageChange: (page: number) => void; position: "top" | "bottom" }) {
  const pages = Math.max(1, totalPages);
  return <nav className={`record-pagination ${position}`} aria-label={`${position === "top" ? "顶部" : "底部"}记录分页`}>
    <button type="button" onClick={() => onPageChange(1)} disabled={disabled || page <= 1} aria-label="第一页"><ChevronFirst size={15} />首页</button>
    <button type="button" onClick={() => onPageChange(page - 1)} disabled={disabled || page <= 1} aria-label="上一页"><ChevronLeft size={15} />上一页</button>
    <span className="record-page-summary">第 <b>{page}</b> / {pages} 页，共 {total} 条</span>
    <button type="button" onClick={() => onPageChange(page + 1)} disabled={disabled || page >= pages} aria-label="下一页">下一页<ChevronRight size={15} /></button>
    <button type="button" onClick={() => onPageChange(pages)} disabled={disabled || page >= pages} aria-label="最后一页">末页<ChevronLast size={15} /></button>
  </nav>;
}
