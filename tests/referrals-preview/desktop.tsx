import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { InvitationCard, ReferralPanel } from "../../apps/desktop/src/components/ReferralPanel";
import "../../apps/desktop/src/styles.css";
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
createRoot(document.getElementById("root")!).render(<QueryClientProvider client={client}><main style={{ maxWidth: 840, margin: "24px auto", padding: 24 }}><p data-test-status role="status">隔离测试：不会创建真实提现申请</p><InvitationCard userId="preview" /><ReferralPanel userId="preview" /></main></QueryClientProvider>);
