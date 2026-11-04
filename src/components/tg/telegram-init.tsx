"use client";

import { useEffect } from "react";
import { initTelegramWebApp } from "@/lib/webapp";

export function TelegramInit() {
  useEffect(() => {
    initTelegramWebApp();
  }, []);

  return null;
}
