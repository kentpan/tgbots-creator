import type { ModelEvent, ModelTrigger } from "./types";
function parse(value: string): Record<string, unknown> { try { return JSON.parse(value) as Record<string, unknown>; } catch { return {}; } }
export function matchesModelTrigger(trigger: ModelTrigger, event: ModelEvent): boolean {
 const cfg = parse(trigger.match_json);
 const type = String(cfg.type ?? trigger.trigger_type);
 const text = event.text ?? "";
 if (type === "command") return (event.command ?? text.split(/\s/,1)[0].replace(/^\//,"")) === String(cfg.command ?? "").replace(/^\//,"");
 if (type === "inline_button" || type === "callback") return event.callbackData === String(cfg.callback_data ?? cfg.value ?? "");
 if (type === "custom_keyboard") return text.trim() === String(cfg.button_text ?? "").trim();
 if (type === "message") { const needle = String(cfg.keyword ?? ""); const mode = String(cfg.match ?? "contains"); return mode === "exact" ? text === needle : mode === "starts_with" ? text.startsWith(needle) : mode === "regex" ? safeRegex(needle,text) : text.includes(needle); }
 return trigger.trigger_type === event.sourceType;
}
function safeRegex(pattern: string, text: string): boolean { if (pattern.length > 160) return false; try { return new RegExp(pattern,"i").test(text); } catch { return false; } }
export function scopeMatches(expected: string, actual: string): boolean { return expected === "all" || expected === actual; }
