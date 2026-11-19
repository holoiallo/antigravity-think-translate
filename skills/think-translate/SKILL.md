---
name: think-translate
description: 打开或说明「思考翻译 (Think Translate)」右侧辅助面板插件。当用户希望查看中文思考过程、打开思考翻译面板、或询问如何配置思考翻译引擎时使用。
---

# 思考翻译 (Think Translate)

当用户请求打开思考翻译面板或使用 `/think-translate` 时：

1. 直接在回复中提供如下可点击的面板入口（不要输出 `plugin://` 链接）：

   [思考翻译](sidecar://think-translate/think_panel/)

2. 简要提示面板能力：
   - 工具调用间隙会通过 `PostInvocation` Hook 自动把纯中文思考译文以引用块内联到主聊天流（仅用户可见，不占用模型上下文）。
   - 右侧辅助面板完整同步当前对话的 `PLANNER_RESPONSE` 思考过程（含最后一轮直接回答），支持 **译文 / 双语 / 原文** 全局与单卡片独立切换、代码块保护、持久化缓存及失败一键重试。
   - 默认使用免密钥的 **Bing 翻译**，可在面板右上角设置中切换 Google 翻译或 OpenAI / DeepSeek / Ollama 兼容接口，也可开关主聊天流内联插入。
