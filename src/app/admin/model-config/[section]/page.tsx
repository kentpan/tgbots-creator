import { notFound,redirect } from "next/navigation";
import { requirePermission } from "@/lib/auth";
import { ModelConfigClient } from "@/components/admin/model-config/model-config-client";
const SECTIONS=["events","triggers","workflows","permissions","logs"] as const;
export const dynamic="force-dynamic";
export default async function ModelConfigSectionPage({params}:{params:Promise<{section:string}>}){await requirePermission("model-config:view");const {section}=await params;if(!SECTIONS.includes(section as typeof SECTIONS[number]))notFound();return <ModelConfigClient resource={section as typeof SECTIONS[number]}/>;}
