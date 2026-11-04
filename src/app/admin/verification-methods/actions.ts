"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import {
  createVerificationMethod,
  deleteVerificationMethod,
  getVerificationMethod,
  updateVerificationMethod,
} from "@/database/operations";
import { logOperation, requirePermission } from "@/lib/auth";
import {
  parseCodeApiConfig,
  verifyCodeExternally,
} from "@/services/external-verify";
import { issueRadsCard } from "@/services/rads-issue";

export async function saveMethodAction(formData: FormData): Promise<void> {
  const admin = await requirePermission("methods:manage");
  const idRaw = String(formData.get("id") ?? "").trim();
  const name = String(formData.get("name") ?? "").trim();
  const configRaw = String(formData.get("config") ?? "").trim();
  const enabled = formData.get("enabled") === "1";

  if (!name) redirect("/admin/verification-methods?error=name-required");
  const parsed = parseCodeApiConfig(configRaw);
  if (!parsed) {
    redirect("/admin/verification-methods?error=invalid-config");
  }

  const configJson = JSON.stringify(parsed, null, 2);

  if (idRaw && /^\d+$/.test(idRaw)) {
    await updateVerificationMethod(BigInt(idRaw), {
      name,
      type: "code_api",
      config: configJson,
      enabled,
    });
    await logOperation(admin, {
      action: "更新验证方式",
      target: `#${idRaw} ${name}`,
      headers: await headers(),
    });
  } else {
    await createVerificationMethod({ name, type: "code_api", config: configJson, enabled });
    await logOperation(admin, {
      action: "创建验证方式",
      target: name,
      headers: await headers(),
    });
  }
  revalidatePath("/admin/verification-methods");
  redirect("/admin/verification-methods?saved=1");
}

export async function deleteMethodAction(formData: FormData): Promise<void> {
  const admin = await requirePermission("methods:manage");
  const idRaw = String(formData.get("id") ?? "").trim();
  if (!idRaw || !/^\d+$/.test(idRaw)) {
    redirect("/admin/verification-methods?error=invalid-id");
  }
  await deleteVerificationMethod(BigInt(idRaw));
  await logOperation(admin, {
    action: "删除验证方式",
    target: `#${idRaw}`,
    headers: await headers(),
  });
  revalidatePath("/admin/verification-methods");
  redirect("/admin/verification-methods?saved=deleted");
}

export async function testMethodAction(formData: FormData): Promise<void> {
  await requirePermission("methods:manage");
  const idRaw = String(formData.get("id") ?? "").trim();
  const code = String(formData.get("code") ?? "").trim();
  if (!idRaw || !/^\d+$/.test(idRaw)) {
    redirect("/admin/verification-methods?error=invalid-id");
  }
  if (!code) redirect("/admin/verification-methods?error=code-required");

  const method = await getVerificationMethod(BigInt(idRaw));
  if (!method) redirect("/admin/verification-methods?error=invalid-id");

  const parsed = parseCodeApiConfig(method.config);
  if (!parsed) redirect("/admin/verification-methods?error=invalid-config");

  const result = await verifyCodeExternally(parsed, {
    userId: 0n,
    username: null,
    code,
  });

  const target = `/admin/verification-methods?edit=${idRaw}&test=${result.ok ? "ok" : "fail"}&message=${encodeURIComponent(result.message)}`;
  redirect(target);
}

export async function issueCardAction(formData: FormData): Promise<void> {
  const admin = await requirePermission("methods:manage");
  const idRaw = String(formData.get("id") ?? "").trim();
  if (!idRaw || !/^\d+$/.test(idRaw)) {
    redirect("/admin/verification-methods?error=invalid-id");
  }
  const method = await getVerificationMethod(BigInt(idRaw));
  if (!method) redirect("/admin/verification-methods?error=invalid-id");

  const parsed = parseCodeApiConfig(method.config);
  if (!parsed) redirect("/admin/verification-methods?error=invalid-config");

  const title = String(formData.get("title") ?? "").trim();
  const priceRaw = String(formData.get("price") ?? "").trim();
  let price: number | undefined;
  if (priceRaw !== "") {
    const parsedPrice = Number(priceRaw);
    if (!Number.isFinite(parsedPrice) || parsedPrice < 0) {
      redirect(`/admin/verification-methods?edit=${idRaw}&error=invalid-price`);
    }
    price = parsedPrice;
  }

  const result = await issueRadsCard(parsed, { title, price });
  if (!result.ok || !result.key) {
    redirect(
      `/admin/verification-methods?edit=${idRaw}&issued=fail&message=${encodeURIComponent(result.message)}`,
    );
  }

  await logOperation(admin, {
    action: "卡密发卡",
    target: `#${idRaw} 卡密 ${result.key}`,
    headers: await headers(),
  });
  redirect(
    `/admin/verification-methods?edit=${idRaw}&issued=ok&key=${encodeURIComponent(result.key)}&url=${encodeURIComponent(result.shareUrl ?? "")}`,
  );
}
