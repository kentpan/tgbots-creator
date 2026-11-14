import { NextRequest, NextResponse } from "next/server";
import { executeRun, queryAll, queryOne } from "@/database/client";
import { getCurrentAdmin, hasPermission } from "@/lib/auth";

const TABLES = {
 events: { table:"model_event_entries", fields:["bot_id","name","source_type","scope","chat_id","config_json","enabled"], required:["name","source_type"] },
 triggers: { table:"model_triggers", fields:["bot_id","event_entry_id","name","trigger_type","match_json","workflow_id","permission_ids_json","enabled"], required:["name","trigger_type","event_entry_id"] },
 workflows: { table:"model_workflows", fields:["bot_id","name","description","nodes_json","entry_node_id","permission_ids_json","enabled"], required:["name"] },
 permissions: { table:"model_permissions", fields:["bot_id","name","permission_type","scope","config_json","enabled"], required:["name","permission_type"] },
 logs: { table:"model_execution_logs", fields:[], required:[] },
} as const;
type Resource=keyof typeof TABLES;
const isResource=(s:string):s is Resource=>s in TABLES;
const fail=(message:string,status=400)=>NextResponse.json({error:message},{status});
export async function GET(req:NextRequest,{params}:{params:Promise<{resource:string}>}){
 const admin=await getCurrentAdmin();if(!admin)return fail("未登录",401);if(!hasPermission(admin,"model-config:view"))return fail("无权查看模型配置",403);
 const {resource}=await params;if(!isResource(resource))return fail("未知资源");const cfg=TABLES[resource];const url=new URL(req.url);const page=Math.max(1,Number(url.searchParams.get("page")??1)||1);const pageSize=Math.min(100,Math.max(5,Number(url.searchParams.get("pageSize")??10)||10));const offset=(page-1)*pageSize;
 const where=resource==="logs"?"1=1":"1=1";const count=await queryOne<{total:number}>(`SELECT COUNT(*) AS total FROM ${cfg.table} WHERE ${where}`);const rows=await queryAll(`SELECT * FROM ${cfg.table} WHERE ${where} ORDER BY id DESC LIMIT ? OFFSET ?`,[pageSize,offset]);return NextResponse.json({rows,page,pageSize,total:Number(count?.total??0),pages:Math.ceil(Number(count?.total??0)/pageSize)});
}
export async function POST(req:NextRequest,{params}:{params:Promise<{resource:string}>}){
 const admin=await getCurrentAdmin();if(!admin)return fail("未登录",401);if(!hasPermission(admin,"model-config:manage"))return fail("无权修改模型配置",403);
 const {resource}=await params;if(!isResource(resource)||resource==="logs")return fail("该资源不支持创建");const cfg=TABLES[resource];let body:Record<string,unknown>;try{body=await req.json() as Record<string,unknown>}catch{return fail("JSON 格式错误")};
 for(const f of cfg.required)if(body[f]===undefined||body[f]===null||String(body[f]).trim()==="")return fail(`缺少必填字段: ${f}`);
 const fields=cfg.fields.filter(f=>body[f]!==undefined);const vals=fields.map(f=>body[f] as string|number|null);const sqlFields=[...fields,"created_at","updated_at"];const placeholders=sqlFields.map(()=>"?").join(",");const result=await executeRun(`INSERT INTO ${cfg.table}(${sqlFields.join(",")}) VALUES(${placeholders})`,[...vals,new Date().toISOString(),new Date().toISOString()]);return NextResponse.json({id:result.lastInsertRowid},{status:201});
}
export async function PUT(req:NextRequest,{params}:{params:Promise<{resource:string}>}){
 const admin=await getCurrentAdmin();if(!admin)return fail("未登录",401);if(!hasPermission(admin,"model-config:manage"))return fail("无权修改模型配置",403);
 const {resource}=await params;if(!isResource(resource)||resource==="logs")return fail("该资源不支持更新");const cfg=TABLES[resource];let body:Record<string,unknown>;try{body=await req.json() as Record<string,unknown>}catch{return fail("JSON 格式错误")};const id=Number(body.id);if(!Number.isSafeInteger(id)||id<1)return fail("ID 无效");const fields=cfg.fields.filter(f=>body[f]!==undefined);if(!fields.length)return fail("没有可更新字段");const values=fields.map(f=>body[f] as string|number|null);const result=await executeRun(`UPDATE ${cfg.table} SET ${fields.map(f=>`${f}=?`).join(",")},updated_at=? WHERE id=?`,[...values,new Date().toISOString(),id]);if(!result.changes)return fail("记录不存在",404);return NextResponse.json({ok:true});
}
export async function DELETE(req:NextRequest,{params}:{params:Promise<{resource:string}>}){
 const admin=await getCurrentAdmin();if(!admin)return fail("未登录",401);if(!hasPermission(admin,"model-config:manage"))return fail("无权删除模型配置",403);
 const {resource}=await params;if(!isResource(resource)||resource==="logs")return fail("运行日志不可删除");const id=Number(new URL(req.url).searchParams.get("id"));if(!Number.isSafeInteger(id)||id<1)return fail("ID 无效");const result=await executeRun(`DELETE FROM ${TABLES[resource].table} WHERE id=?`,[id]);if(!result.changes)return fail("记录不存在",404);return NextResponse.json({ok:true});
}
