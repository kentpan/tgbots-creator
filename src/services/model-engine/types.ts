export type ModelScope = "group" | "channel" | "private";
export type ModelTriggerType = "command" | "inline_button" | "custom_keyboard" | "message" | "join_request" | "member_update" | "callback";
export type ModelNodeAction = "send_message" | "http_request" | "condition" | "delay" | "approve_join" | "reject_join" | "ban_user" | "unban_user" | "switch_node" | "end";
export interface ModelEvent { botId?: number; sourceType: string; scope: ModelScope; chatId?: string; userId?: string; text?: string; command?: string; callbackData?: string; payload?: Record<string, unknown>; occurredAt?: string; }
export interface ModelTrigger { id: number; trigger_type: ModelTriggerType; match_json: string; workflow_id: number | null; permission_ids_json: string; }
export interface ModelWorkflowNode { id: string; name: string; action: ModelNodeAction; config: Record<string, unknown>; next?: string | null; onError?: string | null; }
export interface ModelWorkflow { id: number; nodes_json: string; entry_node_id: string | null; permission_ids_json: string; }
export interface ModelExecutionContext { event: ModelEvent; variables: Record<string, unknown>; node: ModelWorkflowNode; }
