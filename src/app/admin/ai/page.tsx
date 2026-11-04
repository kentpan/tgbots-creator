import { requirePermission } from "@/lib/auth";
import { AiPageClient } from "./ai-page-client";

export const dynamic = "force-dynamic";

export default async function AiConfigPage() {
  await requirePermission("ai:view");
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">AI 配置</h1>
        <p className="text-sm text-muted-foreground">
          管理多个 AI 模型提供方（OpenAI 兼容协议），支持自动/指定模型、接口限速与调用统计。
          机器人 AI 客服等功能的模型下拉浮层均来自这里。
        </p>
      </div>
      <AiPageClient />
    </div>
  );
}
