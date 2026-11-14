import { queryAll } from "@/database/client";
import type { ModelEvent } from "./types";
export async function checkModelPermissions(ids: number[], event: ModelEvent): Promise<{allowed:boolean;reason?:string}> {
 if(!ids.length)return {allowed:true};
 const rows=await queryAll<{id:number;permission_type:string;scope:string;config_json:string}>(`SELECT id,permission_type,scope,config_json FROM model_permissions WHERE enabled=1 AND id IN (${ids.map(()=>"?").join(",")})`,ids);
 if(rows.length!==ids.length)return {allowed:false,reason:"引用的权限配置不存在或已停用"};
 for(const row of rows){if(row.scope!=="all"&&row.scope!==event.scope)return {allowed:false,reason:`权限 ${row.id} 不适用于 ${event.scope}`};let config:Record<string,unknown>={};try{config=JSON.parse(row.config_json) as Record<string,unknown>}catch{}
  if(row.permission_type==="gate"&&event.payload?.unlocked!==true)return {allowed:false,reason:`门禁未解锁: ${row.id}`};
  if(row.permission_type==="verification"&&event.payload?.verified!==true)return {allowed:false,reason:`验证未通过: ${row.id}`};
  if(config.allowed_user_ids&&Array.isArray(config.allowed_user_ids)&&event.userId&&!config.allowed_user_ids.map(String).includes(event.userId))return {allowed:false,reason:`用户无权执行权限 ${row.id}`};
 }
 return {allowed:true};
}
