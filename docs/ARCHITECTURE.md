# Architecture and compatibility notes

[Back to README](../README.md) · [简体中文 README](../README.zh-CN.md) · [Development](DEVELOPMENT.md)

These notes document implementation details and conservative compatibility choices of `pi-ui-extension`. The extension does **not** modify the installed Pi Core files or replace underlying tool execution functions. However, some guarded UI interactions depend on the shape of known Pi host components—not exclusively on public APIs.

## Fullscreen UI and resources

The extension composes three responsive panels in Pi's fullscreen terminal UI:

- **SESSIONS** — quick history, advanced manager, and pinning.
- **CTX** — compact context usage and expandable composition estimates.
- **VIEW** — unified tool/Thinking modes, direct/nested/MCP usage, and resource shortcuts.

The sidebar supports mouse events, wheel scrolling, terminal resizing, and scrollable panels in smaller spaces. Its owned panels share render output by width within each layout frame; the cache is cleared at the next root layout pass, so model, usage, and theme updates remain live. Regular TUI is not a supported host layout. Footer rendering reports the working directory and Git branch and clips long paths to fit the terminal.

Resource shortcuts inspect current project/Pi instruction, skill, extension, and MCP resources. They do not attempt to load or connect missing resources.

## Centered modal UX

The extension uses Pi’s public `ctx.ui.custom()` API with `overlay: true` and a centered, theme-aware frame rather than relying on the native editor-bottom `select`/`confirm`/`input` dialogs. This covers the Sessions manager (paging, sort, action menu, search), rename, bulk cleanup, resource/MCP pickers and read-only details, and the Tool View mode selector. The implementation lives in `extensions/dialogs/`; no Pi Core source or TUI prototype is modified.

Selection overlays retain keyboard and mouse controls; multi-page content is read-only and scrollable. Capturing overlays block background sidebar actions and cancel pending clicks or divider drags; non-capturing resize previews remain interactive. Read-only previews cache wrapped rows until their width changes. Selecting among multiple AGENTS.md resources opens the full selected file. Confirmations are deliberately cancellation-first: Enter without moving selection chooses **Cancel**, Esc cancels, and a destructive action requires selecting **Move to Trash**. The command that performs a single Session trash move is the only confirmation owner for both sidebar and advanced manager, avoiding duplicate dialogs. Before deletion it rechecks idle state, current-session ID, file path/identity/mtime and activity reported by other Pi instances. The existing bulk-cleanup safety rechecks remain intact. Non-interactive/test hosts can fall back to native Pi UI calls when `ctx.ui.custom` is unavailable.

## Session management and safety

The quick session list favors the current session and pinned sessions; pins persist as IDs in `pi-ui-extension/session-pins.json` under the Pi agent directory. Pins do not save message bodies. The quick sidebar supports `☆`/`★` without opening `/sessions-manager`, with lower-priority buttons hidden when space is limited.

The visible session number counts **top-level user question messages** from a session's JSONL history, not all Pi messages. Assistant messages, tool results and nested operations are not counted. The sidebar and advanced manager share a session catalog: each refresh discovers files and checks identity, size, mtime and ctime, but only new or changed histories are streamed again. A single pass extracts the title, activity time and question count without retaining all assistant/tool bodies. Files changed during a read are discarded and retried on a later refresh; unavailable histories are omitted. Destructive commands continue to use fresh SDK discovery and the independent safety checks below, never the display cache as deletion authority.

Advanced management (`/sessions-manager` or `≡`) offers paging (eight records), search, sorting, pinning, renaming, switching and confirmed trash moves. Switching and mutating saved session state requires Pi to be idle.

**Bulk cleanup safeguards:**

1. Never delete the current session or pinned sessions.
2. Exclude sessions advertised as active by Pi instances running this extension. These instances keep private activity metadata under `pi-ui-extension/active-sessions/` in Pi's agent directory and clear it on normal shutdown.
3. Include recently modified historical sessions, while rejecting symbolic links, non-files and unavailable session paths. There is **no five-minute inactivity rule**.
4. Show a centered, cancellation-first preview before deletion: eligible and protected/unavailable counts, broken down by current, pinned, active-in-another-Pi, and unavailable-file reasons. Even a zero-eligible preview explains what was protected and has no destructive action.
5. Immediately before moving each file to trash, recheck current-session identity, pin state, active records, file identity, size, mtime and ctime. Skip sessions changed during confirmation.

A Pi process **not running this extension cannot be reliably detected** by this mechanism. Avoid bulk cleanup when such processes may be using historical sessions. Explicit single-session deletion still requires confirmation. Files changed during the modal or reported active are skipped. The removal of the quiet period increases the risk for Pi processes that do not run this extension, so the preview warns about that limitation.

## CTX estimation and refresh

CTX starts open with the active model, Thinking level, context percentage and bar, and provider-reported `in / out / cache` tokens accumulated for the active branch. Composition starts collapsed; clicking it reveals English category names and image count. Input/output totals across requests are distinct from current context-window utilization. Sessions and View start collapsed; resource shortcuts are four rows at the bottom of View.

The `System`, `Tools`, `Messages`, `Tool Results`, `Summary`, and `Other` breakdown uses **local heuristic token estimates**. It is for composition and trend analysis, **not provider-exact tokenization or billing**. For tools, prefer the actual observable provider-request tool payload; before a provider request is available, estimate Pi's enabled tool schemas instead.

Restoration uses the SDK's active session projection, including context edits and compaction. Removed or replaced content is not reintroduced when a run settles; system messages are accounted for separately through the effective system prompt.

Provider-reported input, output, and cache-read/write totals are restored from assistant messages on the active branch and updated as new assistant messages finish. No elapsed-time ticker is needed for this compact view.

Pi emits `before_agent_start` for user prompts and idle custom-triggered runs. Tool/MCP **RUN** counters reset for each agent run, not strictly for each user question. A cancelled/aborted run should not be reported as a tool failure.

## Thinking display and measured duration

The VIEW selector (`Normal`, `Compact`, `Hidden`) is shared across tool transcript and assistant Thinking presentation; there is no second Thinking selector or persistence file. The mode is stored in `tool-view-mode.json`, and changing it refreshes previously rendered content in the current session.

- **Normal** keeps native tool transcripts and complete Thinking.
- **Compact** defaults to a collapsed title: a live Braille indicator with `Thinking` while the run streams, then `+ Thought · 1.3s` (or `−` while expanded). Supported built-in tools use concise summaries.
- **Hidden** suppresses tool transcripts and never renders Thinking body text, including during streaming; it shows only a read-only title with the measured time when available.

Compact titles are the only click target. A title click toggles that block; body clicks, the message's own left/right output padding, the wheel, and other buttons never toggle it, because the extension owns the region child instead of Pi's native `thinkingVisibilityOverrides` handler. An expanded block renders the complete Thinking text through a Markdown component rebuilt from the native child's theme and default text style, minus this extension's transformer. The body starts on the row directly below the title (no blank row in between), and every body row — paragraph breaks included — carries `theme.quoteBorder("│ ")` on the message's padding column; a paragraph row keeps its height and shows the bar alone, so the column stays continuous. Pi adds its own blank row after Thinking only when more visible text or Thinking follows. A following tool row supplies its own leading blank instead, except that Compact trims it for the tools this extension renders — and only while its Compact spacing guard (below) is active. So an expanded body supplies a single blank row after its last line only before such a tool; a third-party or MCP tool keeps Pi's native leading blank, and the body never adds a second gap there either. A following reply, an error or abort notice, and a collapsed title keep Pi's own spacing with no second gap.

Horizontal alignment follows Pi rather than the extension: the message output padding is read from the native Markdown child (its `paddingX`, which is `AssistantMessageComponent.outputPad`), validated as a finite non-negative integer and clamped, and used for the title, for the quote bar, and for the reserved right margin. The title therefore starts on the same column as the reply text, and body text clears the padding plus the two bar columns. If that padding cannot be read, a safe default of 1 is assumed. As a final safety net every rendered row — header, body, and the trailing blank row — is clipped to the terminal width, so even a one-column terminal with double-width CJK or emoji cannot overflow.

Expansion is stored in a `WeakMap` keyed by the `AssistantMessageComponent` instance and the Thinking run index. It therefore survives text deltas, `invalidate()`, resize, and the end of thinking, stays independent per message and per run, and never keys off body text. Adjacent Thinking blocks still merge into one run, exactly as Pi groups them.

Timing uses Pi's observable `thinking_start` and `thinking_end` events for the Thinking segment wall clock. It does **not** claim to measure a model's private internal work or its entire response time. `ThinkingTiming.status()` reports `complete` as soon as an explicit `thinking_end` arrives, even while the assistant message is still streaming, so the title settles before `message_end`. Phase and timing trust are tracked separately: an ended run is complete even when no time could be trusted (missing start, empty run, ambiguous content), while the duration is only shown for a measured run. Anything below a minute keeps one decimal (`1.3s`, `10.0s`); a minute or more uses the compact `1m05s` form. Historical sessions, ambiguous identical content, and interrupted runs report `complete` with no duration rather than inventing a timer, and the label then shows just `+ Thought`. A narrow terminal may truncate the title rather than wrap it.

Pi's native `hideThinkingBlock=true` short-circuits the extension's Markdown transformation. For Compact/Hidden Thinking titles to appear, set native visibility to **on** (`hideThinkingBlock=false`, or Pi's corresponding control). A region Pi already renders as its hidden `Text` label is left untouched, so `Ctrl+T` keeps its native behavior, and the same switch (plus Pi's per-run override map) prevents the extra live title for a run that is still empty.

Pi skips a Thinking run with no text yet, so a run that has only emitted `thinking_start` would render nothing. The adapter appends one live title for that trailing empty run, using the run index the real region will receive, so a user who opens the empty title still sees the body once the first delta arrives. The title is only added when the whole contiguous trailing run is empty (an empty block next to a rendered run never adds a second title) and when the run's phase is still `streaming`; an empty run that already ended, or a run the message has moved past, leaves no title behind.

Normal keeps Pi's native body and click handler. The display uses Pi's public `registerMarkdownTransformer()` and `setHiddenThinkingLabel()` APIs. The component adapter is shape-gated: it only rewrites region children of components built with this extension's transformer, refuses unknown Markdown/region shapes, unwraps its own previous patch generation on `/reload` (including the older click-guard generation), and lets incompatible Pi layouts fall back to the title-only transformer and native interaction. Compatible host layouts remain enabled across Pi version updates; an exact-version whitelist no longer disables working Thought clicks after an upgrade. Installation fails closed: when a marker is present but `updateContent` is no longer the patch that marker recorded, another patch sits on top, so nothing is unwrapped, nothing is re-wrapped, and `installCompactThinkingAdapter()` returns `false` rather than stacking onto or breaking someone else's patch.

VIEW controls display only: reasoning settings, transcript source content, tool execution and stored session data are not altered.

## Compact tool presentation and guarded spacing

The extension registers custom display renderers through Pi's **public** `registerToolRenderer()` interface for these built-in tools:

`read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`, `codemode`.

It never replaces tool definitions or execution functions. Special native renderers (including certain Skill-related reads and failed-tool details) and unrelated third-party tools retain their own presentation when needed for correctness.

In Compact, supported tools use a dimmed result branch, consistent indentation and `›`/`⌄` chevrons:

```text
+ Thought · 0.7s
  ›  codemode
    ⎿  1 call · 1 ok │ 59 lines · 85ms
  ›  bash  git status
    ⎿  12 lines · 45ms
```

Output line counts use `line/lines` (or `out` as a narrow-screen fallback), while elapsed duration and the compact `│` group separator are dimmer than primary statistics. Each tool call remains independent—even when multiple tools follow one Thinking segment. There is no cross-message tree connection, inferred grouping, or inserted group divider. Completed successful calls omit the redundant green `✓`, while ongoing (`… Running`), failed (`✗ Failed`) and partially failed (`! Partial`) calls still show meaningful state labels. The `│` metric separator only divides meaningful metric groups, never the first status-to-metric transition. Output and duration labels shorten or truncate on narrow terminals; the `⎿` decoration may be omitted first.

Supported built-in tools, **including Codemode**, can be clicked to expand Pi's **native** details without leaving Compact. Collapsed Codemode shows just the tool name plus nested-call status/count, output size and duration. Its input script line count is intentionally omitted. An expanded Codemode shows the native script, nested tool calls and arguments, output and errors; clicking again restores the two-line Compact summary. The native renderer retains its own expanded state and display logic. Normal still uses Pi's full native rendering; Hidden removes transcript rows without cancelling execution or usage accounting.

**Why a host UI adapter exists:** Pi 1.3.0 and 1.4.0 self-rendered tool components insert a leading blank row before each tool. Public tool renderer APIs cannot control that space. Compact therefore uses a deliberately limited compatibility adapter to remove **exactly one expected blank row** for renderers owned by this extension, and adjusts the mouse y-coordinate so click expansion still targets the right row. It does not add or remove Thinking rows or change third-party, Normal or Hidden layouts; the expanded Thinking body only reads whether the guard is active to know if the tool row after it still supplies that blank.

The adapter:

- Accepts compatible host method layouts, checked against Pi 1.3.0/1.4.0, without an exact-version whitelist.
- Validates expected render/mouse method shape before patching; incompatible or previously patched shapes fail closed.
- Accounts for the difference between unbundled SDK (`event.y - 1`) and the official minified Pi CLI (`event.y-1`). The bundled CLI may use a different class instance from the project SDK.
- Resolves the **running** official `dist/bundle/cli.js` executable and patches the classes exported by its sibling `dist/bundle/index.js`, which shares runtime chunks with the CLI. Also patches the SDK classes if distinct. Unknown executable layouts keep their native behavior.
- The Thinking adapter checks the native region's structure rather than relying on `instanceof` across separately bundled Pi TUI classes.
- Marks extension-owned renderers to avoid rewriting every tool, offsets click coordinates, and avoids stacked wrappers across reloads.
- Is covered by real Pi component tests and bundled/unbundled layout checks. Unsupported hosts keep Pi's original spacing.

These adapters operate on host **runtime UI components**, not on Pi Core source files or the underlying tool execution methods. Consequently, claims that *all* rendering customization uses exclusively public APIs would be inaccurate. The design prioritizes bounded, testable adjustments and safe fallback.

## Tool/MCP counting and attribution

VIEW distinguishes actual tool executions from their attribution:

| Category | Counted activity |
| --- | --- |
| **DIRECT TOOLS** | Top-level model-issued tool calls; a Codemode parent is one direct call |
| **NESTED TOOLS** | `executeTool()` calls made by parent tools, including Codemode's nested `bash`/`read` |
| **MCP** | An attribution of known direct/nested calls to a server, **not new executions** |

The panel displays **RUN** (current agent run) and **TOTAL** (active session branch). A tool used both directly and inside a parent appears separately in Direct and Nested. Adding MCP totals to the Direct+Nested grand total would double-count the same executions; don't do it.

During execution, `tool_execution_end` provides observations and `parentToolCallId` identifies nested tool calls. The extension also restores persisted top-level tool results and Pi's `nestedCalls.calls` for the active branch, de-duplicating by call ID. Session/branch changes rebuild totals. MCP server discovery may arrive after calls; re-attribution should not create extra executions or duplicate historical counts. Gateway and `mcpScript` calls are attributed where supported, alongside native Pi `mcp__server__tool` names.

The RUN counter is reset by each new run, session reload or branch switch; TOTAL is cumulative for the active session branch. Names under Direct/Nested align consistently; display metadata and counts shrink with the width of the sidebar.

## MCP state, privacy and limitations

The read-only MCP center combines native/global and trusted-project configuration, project enable/disable overrides (including Pi `enabled: false`), extension registration through `pi.registerMcpServer()`, and observable reports from `pi-mcp-adapter/status/v1`.

**Configuration, registration and loading are not evidence of connectivity.** Report Connected/Connecting/Failed only when an adapter explicitly confirms those states. Pi does not expose complete native MCP connection health to ordinary UI extensions. Use the active `/mcp` manager for live diagnostics, reconnecting, authenticating or changing configuration.

MCP status UI never displays commands, raw endpoint URLs, headers, tokens, environment values, or raw error messages. Cached health from a previous session is discarded on reload rather than shown as current.

## Dependency and release considerations

The Pi coding-agent and TUI packages are peer dependencies to avoid bundling duplicate host instances. The code still protects against the real CLI's separately bundled UI runtime via explicit host shape checks. Pi **1.3.0** is the minimum supported version; CI tests Node 22.19.0/24 × Pi SDK 1.3.0/1.4.0.

Published npm tarballs contain runtime TypeScript sources but not `*.test.ts`. The full test suite and release workflow are described in [Development](DEVELOPMENT.md); there is no need to ship these architecture notes in the npm tarball when the main README links to the GitHub copies.
