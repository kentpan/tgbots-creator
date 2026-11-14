import { requirePermission } from "@/lib/auth";
import { BotsFactoryClient } from "@/components/admin/bots-factory/bots-factory-client";
export const dynamic = "force-dynamic";
export default async function BotsFactoryPage() {
  await requirePermission("model-config:view");
  return <BotsFactoryClient />;
}
