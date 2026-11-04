"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import {
  createDeveloperAccount,
  deleteDeveloperAccount,
  getDeveloperAccount,
  updateDeveloperAccount,
} from "@/database/operations";
import { logOperation, requirePermission } from "@/lib/auth";

function accountPath(params: Record<string, string>): string {
  const query = new URLSearchParams(params).toString();
  return query ? `/admin/developer-accounts?${query}` : "/admin/developer-accounts";
}

export async function saveDeveloperAccountAction(formData: FormData): Promise<void> {
  const admin = await requirePermission("devaccounts:manage");
  const idRaw = String(formData.get("id") ?? "").trim();
  const phone = String(formData.get("phone") ?? "").trim();
  const apiId = String(formData.get("api_id") ?? "").trim();
  const apiHash = String(formData.get("api_hash") ?? "").trim();
  const remark = String(formData.get("remark") ?? "").trim();

  if (!phone || !apiId || !apiHash) redirect(accountPath({ error: "field-required" }));
  if (!/^\d{1,15}$/.test(apiId)) redirect(accountPath({ error: "invalid-api-id" }));

  const requestHeaders = await headers();
  if (idRaw && /^\d+$/.test(idRaw)) {
    const existing = await getDeveloperAccount(BigInt(idRaw));
    if (!existing) redirect(accountPath({ error: "invalid-id" }));
    await updateDeveloperAccount(BigInt(idRaw), {
      phone,
      apiId,
      apiHash,
      remark: remark || null,
    });
    await logOperation(admin, {
      action: "保存开发者账号",
      target: phone,
      headers: requestHeaders,
    });
  } else {
    await createDeveloperAccount({ phone, apiId, apiHash, remark: remark || null });
    await logOperation(admin, {
      action: "新增开发者账号",
      target: phone,
      headers: requestHeaders,
    });
  }
  revalidatePath("/admin/developer-accounts");
  redirect(accountPath({ saved: "1" }));
}

export async function deleteDeveloperAccountAction(formData: FormData): Promise<void> {
  const admin = await requirePermission("devaccounts:manage");
  const idRaw = String(formData.get("id") ?? "").trim();
  if (!idRaw || !/^\d+$/.test(idRaw)) redirect(accountPath({ error: "invalid-id" }));
  const existing = await getDeveloperAccount(BigInt(idRaw));
  if (!existing) redirect(accountPath({ error: "invalid-id" }));
  await deleteDeveloperAccount(existing.id);
  const requestHeaders = await headers();
  await logOperation(admin, {
    action: "删除开发者账号",
    target: existing.phone,
    headers: requestHeaders,
  });
  revalidatePath("/admin/developer-accounts");
  redirect(accountPath({ saved: "deleted" }));
}
