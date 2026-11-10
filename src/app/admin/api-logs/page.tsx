import { requirePermission } from "@/lib/auth";
import { ApiLogsClient } from "./api-logs-client";

export const dynamic = "force-dynamic";

export default async function ApiLogsPage() {
  await requirePermission("logs:view");
  return <ApiLogsClient />;
}
