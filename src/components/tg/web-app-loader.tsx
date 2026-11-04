"use client";

import { useEffect } from "react";
import { initTelegramWebApp } from "@/lib/webapp";

/**
 * Telegram WebApp SDK 按需加载器（v1.1.1）：
 *
 * 此前 telegram-web-app.js 通过根布局 beforeInteractive 注入到全站每个页面，
 * 并在挂载时无条件调用 ready/expand/setHeaderColor —— 普通浏览器访问也会
 * 初始化出一个「假装的」WebApp（version 6.0），控制台报
 * "Header color is not supported in version 6.0" 等警告。
 *
 * 现改为按需加载：
 * - 仅当 URL 中存在 Telegram 启动 Mini App 时必带的 tgWebAppData 参数
 *   （hash 或 query 中，如 #tgWebAppData=user=...&tgWebAppVersion=7.10）
 *   才注入 /js/telegram-web-app.js 并执行初始化；
 * - 普通浏览器直接访问（管理后台、落地页等）不加载任何 Telegram SDK，
 *   不再产生假 WebApp 与版本警告。
 */
export function WebAppLoader() {
  useEffect(() => {
    if (typeof window === "undefined") return;

    const launchedInsideTelegram =
      /tgWebAppData=/.test(window.location.hash) || /tgWebAppData=/.test(window.location.search);
    if (!launchedInsideTelegram) return;

    if (window.Telegram?.WebApp) {
      initTelegramWebApp();
      return;
    }

    const existing = document.querySelector<HTMLScriptElement>(
      'script[data-tg-web-app-sdk="1"]',
    );
    if (existing) {
      existing.addEventListener("load", () => initTelegramWebApp());
      return;
    }

    const script = document.createElement("script");
    script.src = "/js/telegram-web-app.js";
    script.async = true;
    script.dataset.tgWebAppSdk = "1";
    script.onload = () => initTelegramWebApp();
    document.head.appendChild(script);
  }, []);

  return null;
}
