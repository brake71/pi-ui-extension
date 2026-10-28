[English](README.md) | [简体中文](README.zh-CN.md)

# pi-ui-extension

A fullscreen terminal UI extension for [Pi Coding Agent](https://github.com/earendil-works/pi). Manage sessions, inspect context usage, view Tool/MCP activity, and adjust tool output and Thinking display—all from one sidebar.

## Preview

<img width="1377" height="744" alt="pi-ui-extension preview" src="https://github.com/1993yihuan/pi-ui-extension/releases/download/v1.7.1/preview.png" />

## Quick start

Requires **Pi Coding Agent >= 1.3.0**, **Node.js >= 22.19.0**, and **Pi fullscreen mode**.

```bash
pi install npm:pi-ui-extension
pi --tui-mode fullscreen
```

The right sidebar appears automatically. It is not available in regular TUI mode.

## Features

| Panel | Purpose |
| --- | --- |
| **SESSIONS** | Recent sessions, pinning, and management |
| **CTX** | Model, context usage, input/output/cache tokens, and expandable composition |
| **VIEW** | Display modes, Tool/MCP statistics, and resource shortcuts |

Panels support mouse interaction, scrolling, and terminal resizing. Session management, resource browsing, and mode selection use centered dialogs: navigate with ↑/↓ and Enter, or close with Esc. While a dialog is open, background sidebar actions are paused. Resource details are read-only and scrollable.

### Sessions and cleanup

The **SESSIONS** panel lists recent sessions for the current project. Click a session to switch, or use its actions to rename (`✎`), pin/unpin (`☆` / `★`), delete (`×`), and refresh (`↻`). Pinned sessions appear first.

The number beside each title counts **user questions**; assistant replies and tool results are excluded. For example, `3 · 55m` means three questions and an update 55 minutes ago.

Open **Advanced Sessions** with `≡` or `/sessions-manager` to:

- Search by title or ID.
- Sort by recent/oldest activity, question count, or title, with pinned sessions first.
- Browse sessions in pages of eight.
- Switch, rename, pin/unpin, or move a session to trash.

Click `⊗` in the SESSIONS title bar to preview bulk cleanup. The preview shows eligible and protected/unavailable totals, with reasons such as current session, pinned, active in another Pi instance, or unavailable.

**Deletion safeguards:**

- The current session cannot be deleted. Switch, rename, and cleanup operations require Pi to be idle.
- Bulk cleanup protects pinned sessions and sessions known to be active in another Pi instance.
- Every deletion requires explicit confirmation; **Cancel is selected by default**. Sessions changed during confirmation are skipped.
- Deleted sessions go to the system trash. They cannot be restored from Pi.
- **Recently modified historical sessions are eligible for cleanup.** There is no five-minute grace period.
- **Pi instances without this extension cannot be detected reliably.** Avoid bulk cleanup if another such instance may be using saved sessions.

### Resource shortcuts and MCP

Expand VIEW to find four vertically stacked resource shortcuts below the usage statistics:

- **AGENTS.md** — browse instruction resources and read the full selected file.
- **Skills** — browse available skills and their descriptions.
- **Extensions** — view installed or loaded extensions.
- **MCP** — view server configuration and available connection status.

The **MCP Status Center** is read-only. **Configured, registered, or loaded does not mean connected**; some servers have no confirmed connection status available. Sensitive credentials are not displayed. Use Pi's `/mcp` manager for connection diagnostics, sign-in, and configuration changes.

### CTX: compact context summary

At startup CTX is open, while SESSIONS and VIEW are collapsed. It shows the model, Thinking level, context usage percentage and bar, and `in / out / cache` provider-reported token totals for the active branch. The context-window percentage is not the same as input/output totals accumulated across model requests. Click **Composition** for English-language estimates of `System`, `Tools`, `Messages`, `Tool Results`, `Summary`, `Other`, and `Images`.

**Token composition is a local estimate**, intended to help understand context usage. It is not exact provider usage or billing data.

### VIEW: tool output and Thinking

Three full-width rows (Normal, Compact, Hidden) control both tool output and Thinking. The default is **Compact**.

| Mode | Tools | Thinking |
| --- | --- | --- |
| **Normal** | Full tool output and details | Full Thinking text |
| **Compact** (default) | Compact, indented summaries | Collapsed title such as `+ Thought · 1.3s`; click the title to read the full Thinking text |
| **Hidden** | Tool output hidden | Read-only status and measured time; no Thinking body |

Switch with the sidebar buttons, **Ctrl+Shift+O**, or `/tool-view normal|compact|hidden|status`. The selection is saved and also updates existing messages in the current session. Display modes do not affect tool execution or usage statistics.

Compact supports `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`, and `codemode`. Each call has its own summary with output counts, elapsed time when available, and running/failure status:

```text
+ Thought · 0.7s
  ›  codemode
    ⎿  1 call · 1 ok │ 59 lines · 85ms
  ›  bash  git status
    ⎿  12 lines · 45ms
```

Click `›` to expand a supported tool's details, including Codemode scripts, nested calls, output, and errors. Click `⌄` to return to the Compact summary. Third-party tools retain their own display.

Compact Thinking starts collapsed. Click the title to expand or collapse it while the model is thinking or after it finishes:

| State | Title | Body |
| --- | --- | --- |
| Thinking, collapsed | Animated indicator + `Thinking` | Hidden |
| Thinking, expanded | Animated indicator + `Thinking` | Complete text, updated as it streams |
| Finished, collapsed | `+ Thought · 1.3s` | Hidden |
| Finished, expanded | `− Thought · 1.3s` | Complete text |

Expanded text starts directly below the title and wraps to the terminal width. Grey quote bars continue through paragraph breaks, and one blank row separates the body from the first tool call. Each block opens independently and stays open through streaming updates, terminal resizing, and completion. Clicking the body or surrounding padding, scrolling, and other mouse buttons do not toggle it.

Elapsed time measures the Thinking phase, not the whole response. Values below a minute keep one decimal; longer values use `1m05s`. When timing is unavailable, such as in restored history, the title omits it. A live title can appear before the first text arrives. Hidden always keeps the body hidden.

**Thinking visibility:** Enable Pi's native Thinking visibility (`hideThinkingBlock: false`) for Compact/Hidden Thinking titles to appear. Pi's own hide control (`Ctrl+T`) keeps its native behavior.

### Tool / MCP usage statistics

Below VIEW, tools are grouped by execution source:

| Group | Meaning |
| --- | --- |
| **DIRECT TOOLS** | Tools called directly by the model, including a Codemode parent call |
| **NESTED TOOLS** | Calls inside another tool, such as `bash` executed by Codemode |
| **MCP** | Attribution of those calls to MCP servers, not additional executions |

**RUN** shows calls in the current agent run. **TOTAL** shows accumulated calls in the current session branch. Counts follow the selected session or branch where history is available. **Do not add MCP totals to Direct + Nested**, as that counts the same calls twice. Long lists remain scrollable.

### Directory and branch footer

A compact footer displays the current working directory and Git branch, when available. Long paths shorten to fit the terminal.

## Installation and updates

| Action | Command |
| --- | --- |
| Install latest npm release | `pi install npm:pi-ui-extension` |
| Pin v1.9.10 | `pi install npm:pi-ui-extension@1.9.10` |
| Install from GitHub | `pi install git:github.com/1993yihuan/pi-ui-extension` |
| Pin a Git tag | `pi install git:github.com/1993yihuan/pi-ui-extension@v1.9.10` |
| Install only for the current project | `pi install --local npm:pi-ui-extension` |
| Update unpinned packages | `pi update --extensions` |
| List installed packages | `pi list` |
| Remove npm package | `pi remove npm:pi-ui-extension` |
| Remove Git package | `pi remove git:github.com/1993yihuan/pi-ui-extension` |

Project-local installation requires Pi to trust the project. Pinned versions do not automatically move to newer releases.

### Upgrading from v1.9.2 or earlier

**Compatibility change:** v1.9.3 drops support for Pi 1.2.x. Upgrade Pi Coding Agent to **>= 1.3.0 before updating this extension**; its Pi TUI runtime must also be >= 1.3.0. Node.js >= 22.19.0 and fullscreen mode are still required.

1. Check `command -v pi`, `pi --version`, `node --version`, and `pi list`. If npm-global and Bun-global installations coexist, upgrade the installation that supplies the active `pi` command.
2. Upgrade Pi using that installation's package manager, then verify the active version again.
3. Install `pi install npm:pi-ui-extension@1.9.10` (add `--local` for a project installation), restart Pi, and run `pi --tui-mode fullscreen`. Check global and project package entries so an older pinned copy is not still loaded.
4. Confirm the sidebar, Compact tool expansion and mouse alignment, Thinking expansion (with native Thinking visibility enabled), session switching, and Tool/MCP statistics.

If you must stay on Pi 1.2.x, use `pi install` with the package source `npm:pi-ui-extension@1.9.2`, or pin the Git source to `@v1.9.2`; preserve the original global/project scope. Pinned versions do not upgrade automatically. A successful installation alone does not establish host compatibility.

CI verifies Pi SDK **1.3.0 and 1.4.0** on Node.js **22.19.0 and 24**. The declared `>=1.3.0` range also permits other versions, but they are not individually verified by this matrix. This release adds no session/configuration format migration.

## Common questions

- **No sidebar:** Start Pi in fullscreen mode and widen the terminal if needed.
- **Missing Thinking title:** Enable Pi's native Thinking visibility and check the selected VIEW mode.
- **Uncertain MCP connection:** Open `/mcp` for diagnostics and sign-in.
- **Unexpected Pi version:** Check `pi --version` and `pi list` to confirm the active version and installed packages.

## License

[MIT](LICENSE).
