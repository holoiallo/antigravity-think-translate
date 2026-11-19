# 思考翻译插件 (Antigravity Think Translate)

参考 DeepSeek Harness 思考翻译（Reasoning Translation）体验构建的 Antigravity 插件：在不修改原始对话日志与模型上下文的前提下，在右侧辅助面板实时将 Agent 的英文思考过程（`thinking`）翻译为简体中文。

插件零第三方 npm 依赖，仅依赖 Node.js 内置模块与 Antigravity 运行时提供的 `sidecar_sdk`。

## 核心特性

- **不污染会话上下文**：纯显示层只读读取 `transcript.jsonl` / `transcript_full.jsonl`，绝不改写对话历史或提示词。
- **右侧辅助面板（主力体验）**：
  - 实时同步当前会话所有 `PLANNER_RESPONSE` 思考步骤（包含最后一轮不调用工具的直接回复）。
  - 支持 **仅译文 / 双语对照 / 仅原文** 全局及单卡片独立切换，支持搜索筛选、单卡/全部折叠、一键复制与跟随控制。
  - 针对长会话流式刷新优化：采用 keyed 增量 DOM 更新、180ms 滚轮手势冷却窗口与 `Cache-Control: no-store` 防缓存，避免滚动跳顶或打断滚轮惯性。
- **主聊天流内联 Hook（可选，取决于宿主版本）**：
  - 提供 `PostInvocation` Hook（`hooks/post_invocation.mjs`），在工具调用间隙通过 `metadata.user_markdown`（`systemMessage: ""`）向主聊天流输出纯中文思考引用块（不进入模型上下文）。
  - **兼容性说明**：在 Antigravity `44.9.1` 中，宿主暂未在主聊天流渲染空 `systemMessage` + `metadata.user_markdown` 注入步骤，目前推荐直接使用右侧辅助面板查看实时中文思考。
- **开箱即用 + 多翻译引擎**：
  - **Bing 翻译（默认，免 API Key）**：开箱即可使用。
  - **Google 翻译（免 API Key）**：适合有国际网络环境的用户。
  - **OpenAI / DeepSeek / Ollama 兼容接口**：可自定义 Base URL、模型名称与 API Key（支持本地 Ollama）。
- **持久化缓存与容错保护**：翻译结果按内容哈希持久化缓存到本地 `sidecar_data` 目录；网络或接口异常时保留原文并展示错误提示与一键 **重试** 按钮，绝不静默丢弃内容。
- **代码块与行内代码保护**：自动跳过围栏代码块，并将行内 `` `code` `` 与 URL 作为占位符保护，避免变量名、命令与路径被机翻破坏。

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
2. 默认开启 **自动翻译** 与 **跟随** 模式；用鼠标滚轮向上翻看历史步骤时会自动暂停跟随，滚回底部后自动恢复，也可点击「回到底部最新思考」按钮一键跳转。
3. 点击面板右上角齿轮图标，可切换翻译引擎（Bing / Google / OpenAI 兼容接口）、配置 DeepSeek / Ollama 参数、切换默认显示模式、开关主聊天流内联 Hook 或清空缓存。

## 目录结构

```text
think-translate/
├── plugin.json                      # 插件元数据与推荐提示词
├── hooks.json                       # PostInvocation 生命周期 Hook 配置
├── assets/
│   └── logo.svg                     # 插件图标
├── hooks/
│   └── post_invocation.mjs          # 工具调用间隙内联思考译文 Hook
├── sidecars/
│   └── think_panel/
│       ├── sidecar.json             # 辅助面板 Sidecar 声明
│       ├── package.json             # ESM 模块配置
│       ├── main.mjs                 # Sidecar HTTP 服务与路由
│       ├── transcript.mjs           # 只读会话日志解析（含 transcript_full 回源）
│       ├── translator.mjs           # 翻译引擎、代码块保护与本地持久化缓存
│       ├── index.html               # 面板页面结构
│       ├── styles.css               # 面板样式（自适应亮/暗主题）
│       └── app.js                   # 面板交互、增量渲染与防跳顶滚动管理
└── skills/
    └── think-translate/
        └── SKILL.md                 # /think-translate 技能入口说明
```

## 开源协议

[MIT License](LICENSE)
