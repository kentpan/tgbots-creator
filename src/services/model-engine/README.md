# Model Engine v3.0.0

本目录是独立通用模型运行层，不修改现有 Bot Composer/Handler，也不自动接管线上事件。

- `telegram-adapter.ts`：Telegram Update → 统一 `ModelEvent`；`chat_join_request` 中 `userId` 取 `from.id`，`chatId` 取目标群组 ID。
- `matcher.ts`：指令、内嵌 callback、自定义键盘文本、普通消息匹配。
- `permissions.ts`：按 group/channel/private 范围执行门禁与验证权限检查；配置缺失时 fail closed。
- `engine.ts`：触发器匹配、工作流节点执行、执行日志写入。通过 adapter 注入 Telegram/HTTP 操作，避免把 SDK 或业务实现耦合进引擎。
- `types.ts`：事件、触发器、工作流、节点与执行上下文契约。

## 节点 JSON 示例

```json
[
  {"id":"start","name":"欢迎","action":"send_message","config":{"text":"欢迎加入"},"next":"check"},
  {"id":"check","name":"是否通过验证","action":"condition","config":{"variable":"verified","equals":true,"then":"done","else":"retry"}},
  {"id":"done","name":"结束","action":"end","config":{}}
]
```

`http_request` 仅接受 HTTPS URL；延时最大 5 秒；单次执行最多 40 个节点；引擎不执行用户提供的 JS/eval。

## 接入原则

后续为每类 Telegram 更新新增薄适配器调用 `normalizeTelegramUpdate` 和 `dispatchModelEvent`，通过 adapter 注册 sendMessage、审批、禁言等动作。必须逐类接入、灰度和回归测试；不要直接将旧 handler 全量替换为模型引擎。TGAPI 申请保持独立业务工作流/会话命名空间，但可以复用事件标准化、触发器、权限与日志基础设施。

`send_message` 默认发送到当前 chat；加群申请工作流需要私聊申请者时，节点 config 使用 `{"target":"user","text":"..."}`。
