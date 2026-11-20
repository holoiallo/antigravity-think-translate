# 思考翻译插件 (Antigravity Think Translate) v1.1.0

参考 DeepSeek Harness 思考翻译（Reasoning Translation）体验构建的 Antigravity 插件：在不修改原始对话日志与模型上下文的前提下，在右侧辅助面板实时将 **主会话思考过程**、**侧边栏提问（支线提问 `/btw`、`ask_question` 提问卡片、子智能体 Subagents）** 以及 **Swarm 多智能体对话（概览计划、消息板 `board.jsonl`、各 Worker 后台思考）** 自动原位翻译为简体中文。

插件零第三方 npm 依赖，仅依赖 Node.js 内置模块与 Antigravity 运行时提供的 `sidecar_sdk`。

## 核心特性

- **不污染会话上下文**：纯显示层只读解析 `transcript.jsonl`、`transcript_full.jsonl`、`annotations/*.pbtxt`、`.system_generated/subagents/*.json` 与 `.system_generated/swarm/*`，绝不改写对话历史或提示词。
- **三大原位翻译标签页 + `⚡ 智能跟随`**：
  1. **`💭 主思考`**：实时同步当前主会话所有 `PLANNER_RESPONSE` 思考步骤（包含最后一轮不调用工具的直接回复思考）。
  2. **`💬 侧边栏提问`**：
     - **支线提问 (`Side Questions` / `/btw`)**：自动通过 `annotations/<convId>.pbtxt` 关联当前主会话下的所有侧边栏支线提问，原位翻译每个支线的模型思考过程（`thinking`）、英文回复正文（`content`）与英文提问，并附带提问上下文提示条。
     - **`ask_question` 提问与选项卡片**：自动识别主会话、支线提问或子智能体发出的 `ask_question` 工具调用，将英文题干、单选/多选选项及用户已选回答原位对照翻译。
     - **普通子智能体 (`Subagents`)**：自动关联合并 `research`、`browser` 等子智能体的任务简报（Brief）、后台思考过程与最终返回报告。
     - 支持按具体支线/子代理来源芯片筛选，以及按「💭 思考 / 💬 回复/报告 / ❓ 提问卡」图层自由开关。
  3. **`🐝 Swarm 多智能体`**：
     - **Swarm 概览与计划 (`plan.json` / `view.json`)**：原位翻译 Swarm 总目标（Goal）、当前阶段（Phase）、重点关注（Attention）、工作流分组（Workstreams / Threads）、成员分工（Tasks）、风险提示（Risks）与里程碑（Milestones）。
     - **Swarm 公共消息板 (`board.jsonl`)**：1:1 还原原生 Swarm 消息板卡片（彩色成员头像、`@sender`、`#channel` 频道、`→ @recipients` 接收者、`**#seq**` 消息序号），支持点击正文中的 `#13` 等引用编号一键平滑滚动定位并高亮目标消息。
     - **Swarm 各 Worker 后台思考 (`members.json` -> 各成员 `transcript.jsonl`)**：自动关联合并各 Worker 智能体（如 `argon-reviewer`、`opus_critic`、`hydro_prep`）各自的后台思考链，支持在时间流中穿插查看或点击顶部成员芯片（带运行中/等待中/已结束状态灯）单独筛选某个成员的全部发言与思考。
  4. **`⚡ 智能跟随`（跨通道自动切换）**：开启后，主会话思考、侧边栏提问或 Swarm 多智能体中任一通道产生新内容时，面板自动切换到最新活跃标签页并平滑滚动到底部；若用户正在向上翻阅历史或关闭了智能跟随，非当前标签页会以醒目的蓝点提示未读动态。
- **增量解析与防跳顶滚动管理**：
  - 针对超长会话（数十 MB `transcript_full.jsonl`）采用按 `step_index` 的增量回源缓存，轮询耗时低于 `15ms`。
  - 前端采用 keyed 增量 DOM 协调与 180ms 滚轮手势冷却窗口，杜绝流式刷新时的滚动跳顶。
- **开箱即用 + 多翻译引擎 + 专有符号保护**：
  - 支持 **Bing 翻译（默认免 Key）**、**Google 翻译（免 Key）** 与 **OpenAI / DeepSeek / Ollama 兼容接口**。
  - 自动跳过围栏代码块，并将行内 `` `code` ``、URL、`@mention`、`@#channel`、`#seq` 引用号、`[done]` / `[stall]` / `[P0]` / `[P1]` 标签及 Windows 文件路径作为占位符保护，避免机翻破坏技术标识符。

## 安装方法

将本仓库克隆到 Antigravity 全局插件目录 `~/.gemini/config/plugins/think-translate`：

### Windows (PowerShell)

```powershell
git clone https://github.com/holoiallo/antigravity-think-translate.git "$env:USERPROFILE\.gemini\config\plugins\think-translate"
```

### macOS / Linux

```bash
git clone https://github.com/holoiallo/antigravity-think-translate.git ~/.gemini/config/plugins/think-translate
```

克隆完成后：
1. 在 Antigravity 的 **Customizations / Plugins** 页面启用 **思考翻译 (Think Translate)**。
2. **重启一次 Antigravity** 以拉起插件 Sidecar 服务。

## 使用方式

1. 在对话界面右上角 `+` 菜单中打开 **思考翻译** 辅助面板，或在对话中发送 `/think-translate` 获取一键打开入口。
2. 顶部支持切换 **`💭 主思考`**、**`💬 侧边栏提问`**、**`🐝 Swarm 多智能体`** 三个标签页，并可开关 **`⚡ 智能跟随`**（自动跳到最新产生内容的通道）与 **`跟随`**（自动滚到底部）。
3. 点击面板右上角齿轮图标，可切换翻译引擎（Bing / Google / OpenAI 兼容接口）、配置 DeepSeek / Ollama 参数、切换默认显示模式、开关各通道自动翻译或清空缓存。

## 目录结构

```text
think-translate/
├── plugin.json                      # 插件元数据与推荐提示词 (v1.1.0)
├── hooks.json                       # PostInvocation 生命周期 Hook 配置
├── assets/
│   └── logo.svg                     # 插件图标
├── hooks/
│   └── post_invocation.mjs          # 工具调用间隙内联思考译文 Hook
├── sidecars/
│   └── think_panel/
│       ├── sidecar.json             # 辅助面板 Sidecar 声明
│       ├── package.json             # ESM 模块配置
│       ├── main.mjs                 # Sidecar HTTP 服务与多通道状态路由
│       ├── transcript.mjs           # 只读解析主思考、支线提问、Subagents 与 Swarm 数据
│       ├── translator.mjs           # 翻译引擎、专有符号/代码块保护与本地持久化缓存
│       ├── index.html               # 面板三标签页与设置弹窗页面结构
│       ├── styles.css               # 面板样式（自适应亮/暗主题）
│       └── app.js                   # 多标签交互、智能跟随、增量渲染与防跳顶滚动管理
└── skills/
    └── think-translate/
        └── SKILL.md                 # /think-translate 技能入口说明
```

## 开源协议

[MIT License](LICENSE)
