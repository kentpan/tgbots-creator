import { requirePermission } from "@/lib/auth";
import { BackupClient } from "./backup-client";

export const dynamic = "force-dynamic";

export default async function BackupPage() {
  await requirePermission("settings:view");
  return <BackupClient />;
}
