---
name: think-translate
description: 打开或说明「思考翻译 (Think Translate)」右侧辅助面板插件。当用户希望查看中文思考过程、侧边栏提问翻译、Swarm 多智能体对话翻译、打开思考翻译面板、或询问如何配置思考翻译引擎时使用。
---

# 思考翻译 (Think Translate)

当用户请求打开思考翻译面板或使用 `/think-translate` 时：

1. 直接在回复中提供如下可点击的面板入口（不要输出 `plugin://` 链接）：

   [思考翻译](sidecar://think-translate/think_panel/)

2. 简要提示面板能力：
   - **三大实时翻译视图（顶部标签页切换 + `⚡ 智能跟随`）**：
     - **`💭 主思考`**：实时同步当前主会话所有 `PLANNER_RESPONSE` 思考过程。
     - **`💬 侧边栏提问`**：自动关联并原位翻译侧边栏「支线提问 (`Side Questions` / `/btw`)」的思考与回复正文、主会话/子代理弹出的 `ask_question` 英文提问与选项卡片、以及普通子智能体（`Subagents`，如 `research` / `browser`）的任务简报、后台思考与返回报告。
     - **`🐝 Swarm 多智能体`**：自动同步并原位翻译 Swarm 概览与计划（`plan.json` / `view.json`）、公共消息板对话（`board.jsonl` 中的简报、审查报告与 `@mention` 讨论，支持点击 `#seq` 引用跳转高亮）、以及各 Swarm Worker 成员各自的后台思考过程。
   - **原位切换与符号保护**：支持全局与单卡片 **译文 / 双语 / 原文** 切换，自动保护围栏代码块、行内代码、URL、`@mention`、`@#channel`、`#seq` 引用号、`[done]` / `[stall]` 标签与文件路径不被机翻破坏。
   - **多翻译引擎**：默认使用免密钥的 **Bing 翻译**，可在面板右上角设置中切换 Google 翻译或 OpenAI / DeepSeek / Ollama 兼容接口。
