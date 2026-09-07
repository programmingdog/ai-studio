import type { Metadata } from "next";
import { InvitationRegister } from "@/components/InvitationRegister";

export const metadata: Metadata = { title: "客户端下载 · 影匠", description: "注册或下载影匠桌面客户端。", robots: { index: false, follow: false }, referrer: "no-referrer" };

export default function DownloadPage() {
  return <InvitationRegister />;
}
