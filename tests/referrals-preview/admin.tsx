import { useState } from "react";
import { createRoot } from "react-dom/client";
import { DistributionConfigPanel, DistributionRecordsPanel } from "../../apps/admin-web/components/DistributionPanel";
import { UsersPanel } from "../../apps/admin-web/components/UsersPanel";
import "../../apps/admin-web/app/globals.css";
function Preview() {
  const [view, setView] = useState("config");
  return <main style={{ maxWidth: 1440, margin: "24px auto", padding: 24 }}><p data-test-status role="status">隔离测试：所有数据为模拟，不连接真实 API</p><nav className="table-actions" style={{ marginBottom: 24 }}>{["users", "config", "commissions", "withdrawals", "payouts"].map(item => <button key={item} className="secondary" onClick={() => setView(item)}>{item}</button>)}</nav>{view === "users" ? <UsersPanel token="preview-only" /> : view === "config" ? <DistributionConfigPanel token="preview-only" /> : <DistributionRecordsPanel key={view} token="preview-only" kind={view as "commissions" | "withdrawals" | "payouts"} />}</main>;
}
createRoot(document.getElementById("root")!).render(<Preview />);
