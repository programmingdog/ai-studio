import type { Metadata } from "next";
import "./globals.css";
import { ProductBrandProvider } from "@/components/ProductBrand";

export const metadata: Metadata = {
  title: "逐梦帧管理后台",
  description: "逐梦帧运营管理后台",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body><ProductBrandProvider>{children}</ProductBrandProvider></body>
    </html>
  );
}
