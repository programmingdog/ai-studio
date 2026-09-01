import { createRoot } from "react-dom/client";
import { InvitationRegister } from "../../apps/admin-web/components/InvitationRegister";
import "../../apps/admin-web/app/globals.css";
createRoot(document.getElementById("root")!).render(<><p data-test-status role="status" style={{ margin: 8 }}>隔离测试：无真实邮件或注册</p><InvitationRegister code="TEST2345" /></>);
