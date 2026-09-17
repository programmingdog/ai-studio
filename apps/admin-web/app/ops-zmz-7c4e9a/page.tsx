import type { Metadata } from "next";
import { AdminApp } from "@/components/AdminApp";

export const metadata: Metadata = {
  title: "运营管理 · 逐梦帧",
  robots: { index: false, follow: false, noarchive: true, nosnippet: true },
  referrer: "no-referrer",
};

export default function OperationsAdminPage() {
  return <AdminApp />;
}
