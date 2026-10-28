[English](README.md) | [简体中文](README.zh-CN.md)

# pi-ui-extension

为 [Pi Coding Agent](https://github.com/earendil-works/pi) 提供的全屏终端 UI 扩展。在右侧边栏中统一管理会话、查看上下文使用量、观察工具 / MCP 调用，并调整工具输出和 Thinking 的显示方式。

## 界面预览

<img width="1377" height="744" alt="pi-ui-extension 界面预览" src="https://github.com/1993yihuan/pi-ui-extension/releases/download/v1.7.1/preview.png" />

## 快速开始

需要 **Pi Coding Agent >= 1.3.0**、**Node.js >= 22.19.0** 和 **Pi fullscreen 模式**。

```bash
pi install npm:pi-ui-extension
pi --tui-mode fullscreen
```

启动后右侧边栏自动出现。普通 TUI 模式不支持右侧边栏。

## 功能介绍

| 面板 | 功能 |
| --- | --- |
| **SESSIONS** | 最近会话、置顶和管理 |
| **CTX** | 模型、上下文使用量、输入 / 输出 / 缓存 Token 及可展开的组成明细 |
| **VIEW** | 显示模式、Tool/MCP 调用统计和资源快捷入口 |

支持鼠标、滚轮和终端缩放。会话管理、资源浏览和模式选择使用居中弹窗：可用 ↑/↓ 和 Enter 选择，Esc 关闭。弹窗打开时，背景边栏操作暂停。资源详情支持只读查看和滚动。

### 会话与清理

**SESSIONS** 展示当前项目的最近会话。点击会话可切换，也可使用重命名（`✎`）、置顶 / 取消置顶（`☆` / `★`）、删除（`×`）和刷新（`↻`）操作。置顶会话优先显示。

标题旁的数字表示**用户提问次数**，不包含 AI 回复和工具结果。例如，`3 · 55m` 表示三次提问、55 分钟前更新。

点击标题栏的 `≡` 或运行 `/sessions-manager` 打开**高级会话管理**：

- 按标题或 ID 搜索。
- 按最近 / 最早更新、提问次数或标题排序，置顶会话始终优先。
- 每页浏览 8 条会话。
- 切换、重命名、置顶 / 取消置顶，或将会话移入回收站。

点击 SESSIONS 标题栏的 `⊗` 预览批量清理。弹窗展示可删除和受保护 / 不可用的数量，并说明当前会话、置顶、其他 Pi 正在使用或不可用等原因。

**删除保护：**

- 当前会话不能删除。切换、重命名和清理操作需在 Pi 空闲时执行。
- 批量清理保护置顶会话，以及已知正在被其他 Pi 实例使用的会话。
- 每次删除都需明确确认，**默认选中 Cancel**。确认期间发生变化的会话会被跳过。
- 删除的会话进入系统回收站，无法从 Pi 内恢复。
- **最近修改过的历史会话也可清理**，没有五分钟保护期。
- **没有加载本扩展的其他 Pi 实例无法被可靠检测**。如果此类实例可能正在使用历史会话，请勿批量清理。

### 资源快捷入口与 MCP

展开 VIEW 后，在调用统计下方可以看到纵向排列的四类资源快捷入口：

- **AGENTS.md**：浏览指令资源，并查看所选文件的完整正文。
- **Skills**：浏览可用技能及其说明。
- **Extensions**：查看安装或加载的扩展。
- **MCP**：查看服务器配置和可用的连接状态。

**MCP 状态中心**为只读界面。**已配置、已注册或已加载，不代表已经连接**；部分服务器没有可确认的连接状态。界面不展示凭据等敏感信息。连接诊断、登录和配置修改请使用 Pi 的 `/mcp` 管理器。

### CTX 简洁上下文摘要

启动时 CTX 展开，SESSIONS 和 VIEW 折叠。CTX 显示模型、Thinking Level、上下文使用百分比和进度条，以及当前会话分支内由模型服务报告的 `in / out / cache` Token 累计量。上下文使用率不同于多次请求累计的输入 / 输出 Token。点击 **Composition** 可展开英文组成明细：`System`、`Tools`、`Messages`、`Tool Results`、`Summary`、`Other` 和 `Images`。

**Token 组成是本地估算值**，用于了解上下文使用情况，不等于模型厂商的精确用量或计费数据。

### VIEW 工具输出与 Thinking

三行纵向排列的模式按钮（Normal、Compact、Hidden）共同控制工具输出和 Thinking，默认 **Compact**。

| 模式 | 工具输出 | Thinking |
| --- | --- | --- |
| **Normal** | 完整工具输出与详情 | 完整 Thinking 正文 |
| **Compact**（默认） | 缩进紧凑摘要 | 默认折叠为 `+ Thought · 1.3s` 这类标题；点击标题可展开完整 Thinking 正文 |
| **Hidden** | 隐藏工具输出 | 只读展示状态与测得的耗时，不显示 Thinking 正文 |

点击边栏按钮、按 **Ctrl+Shift+O**，或输入 `/tool-view normal|compact|hidden|status` 切换。选择会自动保存，并同步更新当前会话中已经显示的消息。显示模式不影响工具执行和调用统计。

Compact 支持 `read`、`bash`、`edit`、`write`、`grep`、`find`、`ls` 和 `codemode`。每次调用独立显示摘要，包括输出数量、可用的耗时，以及运行中 / 失败状态：

```text
+ Thought · 0.7s
  ›  codemode
    ⎿  1 call · 1 ok │ 59 lines · 85ms
  ›  bash  git status
    ⎿  12 lines · 45ms
```

点击 `›` 可展开受支持工具的详情，包括 Codemode 脚本、内嵌调用、输出和错误；点击 `⌄` 收起并返回 Compact 摘要。第三方工具保留各自的显示方式。

Compact 的 Thinking 默认折叠。点击标题即可展开或收起，思考中与完成后都可以：

| 状态 | 标题 | 正文 |
| --- | --- | --- |
| 思考中，折叠 | 动态指示 + `Thinking` | 隐藏 |
| 思考中，展开 | 动态指示 + `Thinking` | 完整显示，随输出实时更新 |
| 已完成，折叠 | `+ Thought · 1.3s` | 隐藏 |
| 已完成，展开 | `− Thought · 1.3s` | 完整显示 |

展开后的正文紧接标题下一行，按终端宽度换行；灰色竖线贯穿正文和段落空行，正文末尾与首个工具调用之间保留一行空白。各段思考可以独立展开，展开状态在流式更新、终端缩放和思考完成后保持。点击正文、标题周围的空白、滚轮滚动和其他鼠标按钮都不会切换展开状态。

耗时只计算思考阶段，不包含整条回复的其他用时。不足一分钟保留一位小数，更长的用时采用 `1m05s` 形式。恢复历史会话等无法可靠计时的情况下，标题省略耗时。尚无正文时也可显示进行中标题。Hidden 始终隐藏正文。

**Thinking 显示设置：** 请开启 Pi 原生 Thinking 可见性（`hideThinkingBlock: false`），以显示 Compact / Hidden 的 Thinking 标题。Pi 自带的隐藏开关（`Ctrl+T`）保持原生作用。

### Tool / MCP 调用统计

VIEW 下方按调用来源分组：

| 分类 | 含义 |
| --- | --- |
| **DIRECT TOOLS** | 模型直接调用的工具，包括 Codemode 父调用 |
| **NESTED TOOLS** | 在另一个工具内部执行的调用，如 Codemode 内部的 `bash` |
| **MCP** | 上述调用归属到 MCP 服务器的统计，不是额外执行 |

**RUN** 表示当前 Agent 运行中的调用，**TOTAL** 表示当前会话分支的累计调用。有历史记录时，统计会随所选会话或分支切换。**MCP 数量不可与 Direct + Nested 相加**，否则会重复计数。长列表可滚动查看。

### 目录与分支页脚

精简页脚显示当前工作目录及 Git 分支（如存在）。长路径会自动缩短以适配终端宽度。

## 安装与更新

| 操作 | 命令 |
| --- | --- |
| 安装最新 npm 版本 | `pi install npm:pi-ui-extension` |
| 固定 v1.9.10 | `pi install npm:pi-ui-extension@1.9.10` |
| 从 GitHub 安装 | `pi install git:github.com/1993yihuan/pi-ui-extension` |
| 固定 Git tag | `pi install git:github.com/1993yihuan/pi-ui-extension@v1.9.10` |
| 仅当前项目安装 | `pi install --local npm:pi-ui-extension` |
| 更新非固定版本 | `pi update --extensions` |
| 列出已配置扩展 | `pi list` |
| 卸载 npm 扩展 | `pi remove npm:pi-ui-extension` |
| 卸载 Git 扩展 | `pi remove git:github.com/1993yihuan/pi-ui-extension` |

项目级安装需要 Pi 信任当前项目。固定版本不会自动升级到后续版本。

### 从 v1.9.2 或更早版本升级

**兼容性变更：** v1.9.3 停止支持 Pi 1.2.x。请**先将 Pi Coding Agent 升级到 >= 1.3.0，再更新本扩展**；Pi TUI 运行时也必须 >= 1.3.0。Node.js >= 22.19.0 和 fullscreen 模式的要求保持不变。

1. 检查 `command -v pi`、`pi --version`、`node --version` 和 `pi list`。若 npm-global 与 Bun-global 安装并存，请升级实际提供当前 `pi` 命令的安装。
2. 使用对应安装渠道的包管理器升级 Pi，再次确认当前执行的版本。
3. 执行 `pi install npm:pi-ui-extension@1.9.10`（项目级安装添加 `--local`），重启 Pi，并以 `pi --tui-mode fullscreen` 启动。检查全局和项目级配置，避免仍加载旧的固定版本。
4. 确认边栏、Compact 工具展开及鼠标点击位置、Thinking 展开（需开启原生 Thinking 可见性）、会话切换和 Tool/MCP 统计正常。

如果必须保留 Pi 1.2.x，请继续使用 v1.9.2，或使用 `pi install` 将安装来源指定为 `npm:pi-ui-extension@1.9.2`，或将 Git 来源固定到 `@v1.9.2`；保持原来的全局或项目安装范围。固定版本不会自动升级。安装成功本身不能证明宿主兼容。

CI 验证的是 Node.js **22.19.0 / 24** 与 Pi SDK **1.3.0 / 1.4.0** 的组合。`>=1.3.0` 声明允许其他版本，但矩阵未逐一验证。本版本未新增会话或配置格式迁移。

## 常见问题

- **边栏不显示：** 以 fullscreen 模式启动 Pi；必要时增大终端宽度。
- **Thinking 标题不出现：** 开启 Pi 原生 Thinking 可见性，并检查当前 VIEW 模式。
- **MCP 连接不确定：** 使用 `/mcp` 进行诊断或登录。
- **Pi 版本异常：** 用 `pi --version` 和 `pi list` 确认当前版本及已安装的扩展。

## License

本项目采用 [MIT License](LICENSE) 开源协议。
