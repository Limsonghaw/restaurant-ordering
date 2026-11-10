import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import { MockPanel } from "@/lib/ui/mock-panel";

export const metadata: Metadata = {
  title: "餐厅扫码点餐",
  description: "餐厅扫码点餐多店 SaaS",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-Hans">
      <body>
        {children}
        <MockPanel />
      </body>
    </html>
  );
}
