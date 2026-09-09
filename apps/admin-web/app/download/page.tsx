import type { Metadata } from "next";
import { InvitationRegister } from "@/components/InvitationRegister";

export const metadata: Metadata = { title: "客户端下载 · 逐梦帧", description: "注册或下载逐梦帧桌面客户端。", robots: { index: false, follow: false }, referrer: "no-referrer" };

export default function DownloadPage() {
  return <InvitationRegister />;
}
