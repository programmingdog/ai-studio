import { useState } from "react";
import { createRoot } from "react-dom/client";
import { LowCreditReminderDialog } from "../src/components/LowCreditReminderHost";
import "../src/styles.css";
function Fixture() {
  const [open, setOpen] = useState(true);
  const [result, setResult] = useState("仅测试提醒界面，不调用购买接口");
  return <main style={{ padding: 24 }}><h1>低积分提醒组件测试</h1><p role="status">{result}</p><button onClick={() => setOpen(true)}>打开低积分提醒</button>{open && <LowCreditReminderDialog available={9.5} onDismiss={() => { setOpen(false); setResult("已关闭提醒"); }} onPurchase={() => { setOpen(false); setResult("进入积分套餐入口（测试，不创建订单）"); }} />}</main>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
