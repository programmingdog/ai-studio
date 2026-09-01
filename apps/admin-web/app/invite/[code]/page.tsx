import type { Metadata } from "next";
import { InvitationRegister } from "@/components/InvitationRegister";

export const metadata: Metadata = { title: "好友邀请 · AI Video Studio", description: "通过好友邀请注册 AI Video Studio，并下载客户端。", robots: { index: false, follow: false }, referrer: "no-referrer" };
export default async function InvitePage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  return <InvitationRegister key={code.toUpperCase()} code={code.toUpperCase()} />;
}
