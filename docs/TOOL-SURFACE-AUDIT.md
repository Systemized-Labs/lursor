# Tool surface audit — August 2026

An audit of every tool Lursor's agents can actually call, and the rework of tool
loading onto Anthropic's [tool search](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool)
structure (deferred definitions + on-demand discovery).

Method: agents were built through `build_deep_agent` and the exact
`ToolDefinition` list handed to the model was captured per mode via
`FunctionModel`, with native-tool resolution checked against real OpenRouter and
`custom:` (laios) model profiles. Findings are what the model sees, not what the
source implies.

## 1. Inventory

| Mode | function tools | native tools | tool-def weight |
| --- | --- | --- | --- |
| chat, default flags | 27 | WebFetch → local | — |
| chat, every flag + browser QA | 51 | WebSearch (cloud) | ~10.6k tokens |
| `/ask` (read-only) | 16 | WebSearch, WebFetch | — |
| `/plan` | 35 | as chat | — |

Injected instructions total ~1.4k tokens, so tool definitions were 7x the
prompt Lursor writes itself.

## 2. Findings

### 2.1 `/ask` + web search killed the turn on local models — FIXED

`_READONLY_TOOL_ALLOWLIST` allowlisted `"web_search"`. No tool is ever named
that: the local search tools are `duckduckgo_search`, `tavily_search`, and
`exa_search` (`web_search` is only ever the *native* provider tool, which is not
a function tool and cannot be name-filtered). The filter therefore stripped the
local fallback and left the unsupported native `WebSearchTool` with nothing to
fall back to, and pydantic-ai raised before the request:

```
UserError: Native tool(s) ['WebSearchTool'] not supported by this model. Supported: []
```

Verified matrix for an agent with `web_search=True`:

| provider | model | `/ask` before | `/ask` after |
| --- | --- | --- | --- |
| duckduckgo | local `custom:` | turn dies | searches |
| tavily / exa | any | silently no search | searches |
| duckduckgo | OpenRouter | works (native) | works (native) |

This is the same failure that caused the plan-mode allowlist to be deleted (see
the note above `ForceToolChoice` in `builder.py`); it stayed live in ask mode
because the read-only test asserted only that the roster was a *subset* of the
allowlist — which a dead entry passes.

Fix: allowlist the real local search tool names, and add a test that every
allowlist entry is a tool some build actually registers.

### 2.2 `screenshot` dumped a base64 PNG into the transcript — FIXED

Browser QA exposed the vendored `screenshot` tool alongside our `view_app`. It
returns `f"data:image/png;base64,{b64}"` as a **string**. Measured on a plain
1280x800 card layout: 75,653 PNG bytes → 100,872 base64 characters, roughly
25–34k tokens, which the model cannot see, and which stays in history (there is
no tool-result eviction; only `execute` output is capped).

`browser_qa.py` already documented this as the reason `view_app` exists, but the
broken tool was never hidden. Fix: drop it in
`BrowserQACapability.prepare_tools`, which was already filtering browser tool
defs. `view_app` (screenshot → vision model → description) is the replacement
and is named in the browser-QA instructions.

### 2.3 Open findings (not addressed here)

| # | Severity | Finding |
| --- | --- | --- |
| a | medium | The `/ask` prompt contradicts the `/ask` filter: the vendored console-toolset instructions still say "You have access to filesystem tools (ls, read_file, write_file, hashline_edit, glob, grep) and shell execution (execute)" while those tools are filtered out. |
| b | medium | The Tools registry (`Tool` rows, `agent_tools` links, `/api/tools`, the Customization → Tools tab that says "Register a tool to give your agents new capabilities") has no runtime effect — `build_deep_agent` never reads it. `builder.py` cites AGENTS.md for the deferral; AGENTS.md has no such note. |
| c | low | `edit_file` is recommended by the `execute` and `write_file` descriptions but is not registered. The `task` description rewrite in `builder.py` is the pattern for patching this. |
| d | low | `/ask` omits read-safe process/state tools: `read_output`, `list_shells`, `list_monitors`, `check_task`, `list_active_tasks`. |
| e | low | Our own browser tools ship undocumented parameters: `open_app(url)`, `view_app(question, full_page)`, `get_console_logs(errors_only)` have no `Args:` sections. |
| f | low | `exa_search_tool` is deprecated and removed in pydantic-ai v3, so the exa provider path breaks on that upgrade. On OpenRouter the DuckDuckGo selection is a no-op: every model profile reports `openai_chat_supports_web_search`, so native search always wins and `duckduckgo_search` never reaches the wire. |
| g | low | `navigate`, `click`, and `type_text` each append the full page markdown to their result, so a multi-step QA flow re-dumps the page every call. |

### 2.4 What held up

- `ToolErrorsAsText` is inserted first so it is the last-resort error hook; a
  raising tool cannot kill a run.
- `task` roster pinning works: `subagent_type` carries
  `enum: [general-purpose, research, planner]` and the description bullet is
  rewritten from the live roster.
- Browser QA is genuinely loopback-confined (`allowed_domains` plus a
  navigation route guard).
- Hindsight and the library's `MEMORY.md` toolset are mutually exclusive, and
  `hindsight_retain` is absent from read-only builds at both layers.

## 3. Tool loading rework — tool search

### 3.1 Why

Anthropic's guidance: tool selection accuracy degrades past 30–50 tools, and
tool search is worth it at 10+ tools or 10k+ tokens of definitions. The
fully-enabled roster was 51 tools / ~10.6k tokens, i.e. both thresholds.

### 3.2 How it works here

pydantic-ai implements the same structure the API doc describes, and picks the
transport per model:

- **Native path** (Anthropic direct, OpenAI Responses): deferred tools go on the
  wire with `defer_loading: true` and the provider runs discovery server-side.
- **Local path**: deferred tools are withheld from the wire and a `search_tools`
  function tool performs keyword discovery; discovered tools become visible for
  the rest of the run.

Lursor is always on the local path today — every model resolves to
`OpenAIChatModel` (OpenRouter) or `TolerantOpenAIChatModel` (`custom:`/laios),
and neither advertises the tool-search native tool. That is the portable path,
so the same behaviour holds for local models. If Lursor ever adds a direct
Anthropic provider, the native path engages with no code change.

Marking is done by `app/agents/tool_loading.py`: a `DeferNonCoreTools` capability
sets `defer_loading=True` on every tool outside the always-loaded core, and the
`ToolSearch` capability wraps the toolset. Both are appended last in
`build_deep_agent` so the tool-search wrapper sits outside every other
capability, and both run every step, so they compose with the read-only allowlist
and the `task` roster rewrite rather than bypassing them. Two tests pin that
composition: a write tool discovered mid-turn in `/ask` is still filtered out,
and a `task` tool discovered mid-turn still carries the `subagent_type` enum and
the rewritten roster bullet.

### 3.3 What stays always-loaded

The core set is "used in most turns, or named by an instruction block we
inject":

| Group | Tools |
| --- | --- |
| read + navigate | `ls`, `read_file`, `glob`, `grep` |
| edit | `write_file`, `hashline_edit` |
| shell + dev servers | `execute`, `run_in_background`, `list_shells`, `read_output`, `kill_shell` |
| planning board | `read_todos`, `write_todos`, `update_todo_statuses` |
| skills entry points | `list_skills`, `load_skill` |
| memory | `read_memory`, `write_memory`, `update_memory`, `hindsight_recall`, `hindsight_reflect`, `hindsight_retain` |
| web | `web_fetch`, `duckduckgo_search`, `tavily_search`, `exa_search` |
| attachments | `view_image` |

The shell trio, skills entry points and memory tools are core because the
directives Lursor injects name them by hand; hiding a tool the prompt tells the
model to call is the failure mode in 2.1 all over again.

Deferred: browser QA (13), async subagent control (7), monitors (3), granular
todo mutations (3), conversation utilities (2), skill extras (2), and `task`
(the single largest definition at ~850 tokens).

### 3.4 Threshold

Deferral engages only when at least `_MIN_DEFERRABLE` (8) tools would be
deferred, counted per step from the definitions actually present. Below that the
saving does not pay for a discovery round trip, and pydantic-ai emits no
`search_tools` tool when nothing is deferred. Consequence: `/ask` (16 tools,
mostly core) keeps its flat roster automatically, and so does any agent with
subagents, skills and browser QA switched off.

### 3.5 The discovery cue

Deferral's failure mode is an agent that was told to use a tool it cannot see and
concludes it has no such capability. Two things guard against it. Everything
Lursor's own directives name by hand is core. And the rest of the guidance — the
category map, plus "a tool your instructions name but your list lacks is
deferred, not missing: search for it" — lives in the `search_tools` tool
description, not the system prompt.

That placement is the deliberate part. pydantic-ai registers `search_tools` only
when something is actually deferred, so guidance carried there cannot outlive the
mechanism it describes; a system-prompt block would have to guess. It cannot even
guess accurately: instructions are assembled *before* tools are prepared on every
step, so any "did we defer?" flag read at instruction time is a step stale, and
wrong on the opening step — the one that matters.

The category keywords in that description (`browser`, `console`, `subagent`,
`monitor`, `skill`, `conversation`) are words that really occur in the deferred
tools' names and descriptions, because local discovery scores by token overlap
against exactly those two fields.

### 3.6 Measured effect

Fully-enabled agent on a no-native-tools model profile (the `custom:`/laios case,
where the local web tools are function tools too), `search_tools` included:

| | flat | deferred |
| --- | --- | --- |
| tools up front | 52 | 23 |
| tool-def weight | ~10.7k tokens | ~5.6k tokens |
| discovery cost | — | one `search_tools` call per turn that needs a deferred tool |

Roughly half, not the 85% Anthropic quotes for MCP aggregations — because the
core set here is deliberately wide (the whole coding loop, plus everything our
directives name). The tool-count drop below the 30-50 selection-accuracy band is
the bigger prize.

Cross-turn note: Lursor persists only user/assistant text, so live history — and
with it `discovered_tool_names` — resets each turn. A thread that uses browser QA
on every turn pays one search call per turn rather than once per thread.

### 3.7 Configuration

`TOOL_SEARCH_ENABLED` (`Settings.tool_search_enabled`, default `true`) turns the
whole mechanism off, restoring the flat roster.

### 3.8 Risks to watch

1. **Delegation** — `task` is deferred. If threads stop delegating, move `"task"`
   into `_CORE_TOOLS`; it costs ~850 tokens.
2. **Browser QA** — the biggest deferred group. The browser-QA directive names
   `open_app`/`view_app`, so it depends on 3.5 working.
3. **Small local models** — GLM/DeepSeek-class models may not reason about a
   two-step discovery. `TOOL_SEARCH_ENABLED=false` is the escape hatch; a
   per-provider gate is the next step if this shows up.
