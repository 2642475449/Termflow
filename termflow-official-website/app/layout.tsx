import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

const title = "Termflow — Keep AI coding in flow";
const description =
  "Termflow 是为 Windows 打造的本地优先 AI 编程工作台，将 Claude Code、Codex、Antigravity CLI 与 OpenCode 汇入同一条项目、终端、Git 和变更审阅流程。";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host =
    requestHeaders.get("x-forwarded-host") ??
    requestHeaders.get("host") ??
    "termflow.local";
  const protocol =
    requestHeaders.get("x-forwarded-proto") ??
    (host.includes("localhost") || host.endsWith(".local") ? "http" : "https");
  const origin = `${protocol}://${host}`;
  const ogImage = new URL("/og.png", origin).toString();

  return {
    metadataBase: new URL(origin),
    title,
    description,
    applicationName: "Termflow",
    alternates: { canonical: origin },
    icons: {
      icon: "/favicon.png",
      shortcut: "/favicon.png",
    },
    openGraph: {
      type: "website",
      url: origin,
      siteName: "Termflow",
      title,
      description,
      locale: "zh_CN",
      alternateLocale: "en_US",
      images: [
        {
          url: ogImage,
          width: 1536,
          height: 1024,
          alt: "Termflow — AI agents. One native workflow.",
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [ogImage],
    },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
