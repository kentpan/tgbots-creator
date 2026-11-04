import { NextResponse } from "next/server";
import { getCurrentAdmin, hasPermission } from "@/lib/auth";
import { executeMenuApi, type MenuApiConfig, type MenuTemplateVars } from "@/services/menu-config";

export async function POST(request: Request): Promise<NextResponse> {
  const admin = await getCurrentAdmin();
  if (!admin) {
    return NextResponse.json({ ok: false, text: "未登录" }, { status: 401 });
  }
  if (!hasPermission(admin, "bots:view")) {
    return NextResponse.json({ ok: false, text: "无权限" }, { status: 403 });
  }

  let payload: { api?: MenuApiConfig; vars?: Partial<MenuTemplateVars> };
  try {
    payload = (await request.json()) as { api?: MenuApiConfig; vars?: Partial<MenuTemplateVars> };
  } catch {
    return NextResponse.json({ ok: false, text: "请求体不是合法 JSON" }, { status: 400 });
  }

  if (!payload.api || typeof payload.api.url !== "string" || !payload.api.url.trim()) {
    return NextResponse.json({ ok: false, text: "接口地址未配置" }, { status: 400 });
  }

  const vars: MenuTemplateVars = {
    chat_id: "-1001998877661",
    user_id: "777000",
    username: "preview_user",
    first_name: "预览",
    last_name: "用户",
    chat_title: "预览群组",
    message_id: "1024",
    ...(payload.vars ?? {}),
  };

  const result = await executeMenuApi(payload.api, vars);
  return NextResponse.json({ ok: result.ok, text: result.text, status: result.status });
}
