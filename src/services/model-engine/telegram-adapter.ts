import type { ModelEvent, ModelScope } from "./types";
type ChatLike={id:number|string;type?:string};
type UserLike={id:number|string;is_bot?:boolean};
/** 将 Telegram Update 转为统一事件。加群申请的 userId 始终取 from.id，chatId 取申请目标群组 ID。 */
export function normalizeTelegramUpdate(update:Record<string,unknown>,botId?:number):ModelEvent|null {
 const entry=(key:string)=>update[key] as Record<string,unknown>|undefined;
 const join=entry("chat_join_request");const callback=entry("callback_query");const message=entry("message")??entry("edited_message");const member=entry("chat_member")??entry("my_chat_member");
 const raw=join??callback??message??member;if(!raw)return null;
 const chat=(join?join.chat:callback?(callback.message as Record<string,unknown>|undefined)?.chat:raw.chat) as ChatLike|undefined;
 const from=(join?join.from:callback?callback.from:message?message.from:((raw.new_chat_member as Record<string,unknown>|undefined)?.user)) as UserLike|undefined;
 const scope:ModelScope=chat?.type==="channel"?"channel":chat?.type==="private"?"private":"group";
 const text=message?.text as string|undefined;const callbackData=callback?.data as string|undefined;
 const sourceType=join?"join_request":callback?"callback":message?"message": "member_update";
 const command=text?.startsWith("/")?text.slice(1).split(/[ @\s]/,1)[0]:undefined;
 return {botId,sourceType,scope,chatId:chat?String(chat.id):undefined,userId:from?String(from.id):undefined,text,command,callbackData,payload:{updateId:update.update_id,hasJoinRequest:Boolean(join),messageId:(message?.message_id??(callback?.message as Record<string,unknown>|undefined)?.message_id)}};
}
