import { executeRun, queryAll, queryOne } from "@/database/client";
import { matchesModelTrigger } from "./matcher";
import { checkModelPermissions } from "./permissions";
import type { ModelEvent, ModelTrigger, ModelWorkflow, ModelWorkflowNode } from "./types";
const MAX_NODES = 40;
const ALLOWED_ACTIONS = new Set(["send_message","http_request","condition","delay","approve_join","reject_join","ban_user","unban_user","switch_node","end"]);
function json<T>(v: unknown, fallback: T): T { try { return typeof v === "string" ? JSON.parse(v) as T : fallback; } catch { return fallback; } }
export async function dispatchModelEvent(event: ModelEvent, adapters: { sendMessage?: (chatId:string,text:string)=>Promise<unknown>; http?: (url:string,method:string,body:unknown)=>Promise<unknown>; telegramAction?: (action:string,event:ModelEvent,config:Record<string,unknown>)=>Promise<unknown> } = {}): Promise<{ matched: number; executions: number }> {
 const started=Date.now();
 const entries=await queryAll<{id:number;bot_id:number|null;source_type:string;scope:string;chat_id:string|null;config_json:string}>("SELECT id,bot_id,source_type,scope,chat_id,config_json FROM model_event_entries WHERE enabled=1 AND source_type=? AND (bot_id IS NULL OR bot_id=?)",[event.sourceType,event.botId??null]);
 let matched=0, executions=0;
 for(const entry of entries){ if(entry.scope!=="all"&&entry.scope!==event.scope)continue; if(entry.chat_id&&entry.chat_id!==event.chatId)continue;
  const triggers=await queryAll<ModelTrigger>("SELECT id,trigger_type,match_json,workflow_id,permission_ids_json FROM model_triggers WHERE enabled=1 AND event_entry_id=?",[entry.id]);
  for(const trigger of triggers){if(!matchesModelTrigger(trigger,event)||!trigger.workflow_id)continue;const triggerGate=await checkModelPermissions(json<number[]>(trigger.permission_ids_json,[]),event);if(!triggerGate.allowed)continue;matched++; const workflow=await queryOne<ModelWorkflow>("SELECT id,nodes_json,entry_node_id,permission_ids_json FROM model_workflows WHERE id=? AND enabled=1",[trigger.workflow_id]);if(!workflow)continue;const workflowGate=await checkModelPermissions(json<number[]>(workflow.permission_ids_json,[]),event);if(!workflowGate.allowed)continue;
   const log=await executeRun("INSERT INTO model_execution_logs(bot_id,event_entry_id,trigger_id,workflow_id,scope,chat_id,user_id,status,input_json,created_at) VALUES(?,?,?,?,?,?,?,'running',?,CURRENT_TIMESTAMP)",[event.botId??null,entry.id,trigger.id,workflow.id,event.scope,event.chatId??null,event.userId??null,JSON.stringify(event)]);
   let status="success",errorText:string|null=null,current:string|null=workflow.entry_node_id,lastNodeId:string|null=null,output:Record<string,unknown>={};const nodes=json<ModelWorkflowNode[]>(workflow.nodes_json,[]);const byId=new Map(nodes.map(n=>[n.id,n]));let steps=0;
   try{while(current&&steps++<MAX_NODES){const node=byId.get(current);if(!node)throw new Error(`节点不存在: ${current}`);lastNodeId=node.id;if(!ALLOWED_ACTIONS.has(node.action))throw new Error(`不允许的节点动作: ${node.action}`);const cfg=node.config??{};
    if(node.action==="send_message"){const target=cfg.target==="user"?event.userId:event.chatId;if(!target||!adapters.sendMessage)throw new Error("send_message adapter 未配置或缺少目标 chatId/userId");output.last=await adapters.sendMessage(String(target),String(cfg.text??""));}
    else if(node.action==="http_request"){if(!adapters.http)throw new Error("HTTP adapter 未配置");const url=String(cfg.url??"");if(!/^https:\/\//i.test(url))throw new Error("HTTP 节点仅允许 HTTPS URL");output.last=await adapters.http(url,String(cfg.method??"POST"),cfg.body??{});}
    else if(node.action==="condition"){const key=String(cfg.variable??"");const equals=cfg.equals;current=Object.is(event.payload?.[key],equals)?String(cfg.then??node.next??""):String(cfg.else??node.next??"");continue;}
    else if(node.action==="delay"){const ms=Math.max(0,Math.min(5000,Number(cfg.ms??0)));if(ms)await new Promise(r=>setTimeout(r,ms));}
    else if(node.action!=="end"&&node.action!=="switch_node"){if(!adapters.telegramAction)throw new Error(`Telegram adapter 未配置: ${node.action}`);output.last=await adapters.telegramAction(node.action,event,cfg);}
    current=node.action==="end"?null:(node.action==="switch_node"?String(cfg.target_node??""):node.next??null);
   }if(steps>=MAX_NODES&&current)throw new Error("工作流超过最大节点执行数");
   }catch(e){status="failed";errorText=e instanceof Error?e.message:String(e);}
   executions++;await executeRun("UPDATE model_execution_logs SET status=?,current_node_id=?,output_json=?,error_text=?,duration_ms=? WHERE id=?",[status,lastNodeId,JSON.stringify(output),errorText,Date.now()-started,log.lastInsertRowid]);
  }
 }
 return {matched,executions};
}
