# Plan — Prompt Library & Prompt Studio

Status: **Implemented** · Owner: TBD · Last updated: 2026-07-10

> Built as specified. Open questions resolved: built-in templates are read-only
> with a "duplicate to customize" action; generation uses the agent's own model
> (falling back to `settings.default_model`); v1 uses a spinner (no streaming);
> Generate/Improve work pre-save from form state. Verified end-to-end against a
> live model; backend tests + frontend typecheck/build/lint all pass.

Improve the quality of agent system prompts in Lursor by giving users two ways
to get a good `Agent.instructions` value from the UI:

1. **Prompt Library** — browse and apply curated, reusable prompt templates
   (distilled from the `system_prompts_leaks/` collection).
2. **Prompt Studio** — AI-generate a prompt from a one-line brief, or improve
   the current prompt, using the LLM plumbing Lursor already has.

The two reinforce each other: the generator's meta-prompt is authored from the
same patterns mined from the leaks that the curated templates embody.

---

## 1. Problem

The system prompt is the single biggest lever on agent quality, but today it is
a bare `<Textarea>` in `frontend/src/pages/agents/agent-form-dialog.tsx` bound to
`Agent.instructions` (`backend/app/db/models.py:109`). There is:

- no starting point (users face a blank box),
- no reuse across agents,
- no quality scaffolding (role / capabilities / tone / constraints / tool-use /
  output format),
- no awareness of which capabilities the agent actually has enabled
  (`include_todo`, `include_subagents`, `include_skills`, `web_search`,
  `thinking`, attached skills/tools).

We have a large reference corpus in `system_prompts_leaks/` (279 markdown files
by vendor), but the files are mostly huge and product-specific — reference
material for *patterns*, not drop-in reusable prompts.

## 2. Goals / non-goals

**Goals**
- Apply a curated template into the Instructions field in ≤2 clicks.
- Generate a polished prompt from a short brief, and improve an existing one.
- Make "improve" capability-aware (tailored to the agent's enabled features).
- Reuse existing infrastructure (Skill CRUD pattern, OpenRouter/pydantic-ai
  plumbing). No new external dependencies.

**Non-goals (this iteration)**
- Versioning / diff history of prompts.
- Prompt evaluation / scoring / A-B testing.
- Sharing templates between users (Lursor is single-tenant today).
- Importing all 279 raw leak files (see §7 — deliberately excluded as noise).

## 3. Design overview

Two backend surfaces, two UI surfaces.

```
Customization page                         Agent form dialog (Instructions field)
┌───────────────────────────┐             ┌───────────────────────────────────┐
│ Agents | Skills | Tools |  │             │ Instructions                      │
│ [Prompts]  ← new tab       │             │ ┌───────────────────────────────┐ │
│                            │             │ │ <textarea>                    │ │
│ CRUD over PromptTemplate   │             │ └───────────────────────────────┘ │
│ (mirrors Skills)           │             │ [Start from template ▾]           │
└───────────────────────────┘             │ [✦ Generate]  [✦ Improve current] │
                                           └───────────────────────────────────┘
        │                                            │            │
        ▼                                            ▼            ▼
  GET/POST/PATCH/DELETE                      POST /agents/prompt/generate
  /api/prompt-templates                      POST /agents/prompt/improve
        │                                            │
        ▼                                            ▼
  prompt_templates table                     build_deep_agent plumbing
  (seeded from distilled leaks)              (resolve_model + meta-prompt)
```

## 4. Backend

### 4.1 Data model — `PromptTemplate`

New table mirroring `Skill` (`backend/app/db/models.py`). Same shape plus a
`category` for grouping and an `is_builtin` flag so seeded rows can be
distinguished (and protected from deletion in the UI if we choose).

```python
class PromptTemplate(TimestampMixin, table=True):
    """A reusable system-prompt template applied into Agent.instructions."""
    __tablename__ = "prompt_templates"

    name: str = Field(index=True)
    description: str = ""
    category: str = "general"     # e.g. "coding", "research", "support", "extraction"
    content: str = ""             # the prompt body (markdown/plain)
    is_builtin: bool = False      # seeded vs user-created
```

No relationship to `Agent` — a template is *copied into* `instructions`, not
linked. This is the key difference from `Skill` (which is attached many-to-many
and rendered at run time). Copying keeps agents self-contained and editable
after applying.

### 4.2 Schemas — `backend/app/schemas/prompt_template.py`

`PromptTemplateCreate` / `Update` / `Read`, identical style to
`schemas/skill.py`.

### 4.3 CRUD API — `backend/app/api/prompt_templates.py`

Copy `api/skills.py` verbatim, swapping the model/schema. Register in
`app/main.py`'s router loop. Route prefix `/prompt-templates`.

### 4.4 Generation API — extend `backend/app/api/agents.py`

Two endpoints that call the LLM via the existing builder plumbing.

```
POST /api/agents/prompt/generate
  body: { brief: str, config: AgentPromptContext }
  -> { instructions: str }

POST /api/agents/prompt/improve
  body: { current: str, config: AgentPromptContext }
  -> { instructions: str }
```

`AgentPromptContext` is a lightweight subset of the agent config so the output
is capability-aware:

```python
class AgentPromptContext(BaseModel):
    name: str = ""
    description: str = ""
    include_todo: bool = False
    include_subagents: bool = False
    include_skills: bool = False
    include_memory: bool = False
    include_plan: bool = False
    web_search: bool = False
    thinking: ThinkingLevel = ThinkingLevel.off
    skill_names: list[str] = []
    tool_names: list[str] = []
    model: str | None = None
```

**Implementation.** A small helper `app/agents/prompt_author.py` builds a
one-shot `pydantic_ai.Agent` using `resolve_model(...)` (reuse from
`builder.py`) with the **meta-prompt** as its instructions (see §6). It sends a
single user message containing the brief/current prompt + a rendered summary of
the enabled capabilities, and returns the model's text. Model defaults to
`settings.default_model`; custom providers resolved the same way as chat runs.

Streaming is a nice-to-have; v1 returns the full string (generation is short).
The frontend shows a spinner. If we want token streaming later, reuse the AG-UI
SSE approach from `chat.py`.

### 4.5 Seeding — extend `backend/scripts/seed.py`

Add curated builtin templates (see §7). Idempotent: upsert by `name` where
`is_builtin=True`, so re-running `seed.py` refreshes builtin content without
duplicating or clobbering user templates.

## 5. Frontend

### 5.1 API + types — `frontend/src/api/prompt-templates.ts`, `api/types.ts`

Copy `api/skills.ts` (query keys + hooks). Add `PromptTemplate` /
`PromptTemplateInput` types. Add `agentsApi.generatePrompt` /
`improvePrompt` in `api/agents.ts`.

### 5.2 Prompts tab — Customization page

- Add `"prompts"` to `TABS` in `pages/customization/customization-page.tsx`.
- New `pages/prompts/prompts-page.tsx` + `prompt-form-dialog.tsx`, cloned from
  the Skills pages. Group the list by `category`; badge builtin templates.
- Add nav redirect in `App.tsx` (`/prompts` → `/customization?tab=prompts`).

### 5.3 Instructions field enhancements — `agent-form-dialog.tsx`

Under the Instructions textarea, add a row of actions:

- **Start from template ▾** — a picker (reuse `Select` or a small command
  dialog) listing templates grouped by category. On pick: if the field is
  non-empty, confirm replace (reuse `confirm-dialog.tsx`); else insert.
- **✦ Generate** — opens a tiny inline input for a one-line brief, calls
  `/agents/prompt/generate` with the current form's capability flags, fills the
  textarea with the result.
- **✦ Improve current** — calls `/agents/prompt/improve` with the current
  instructions + capability flags; replaces the textarea (with confirm).

All three respect the CLAUDE.md UI rules (semantic `text-foreground` /
`text-muted-foreground`, no absolute colors, no `container`). Buttons disabled
while a request is in flight; errors surfaced via `toast`.

## 6. The meta-prompt (grounding from the leaks)

The generator/improver is only as good as its meta-prompt. We author it once,
in `app/agents/prompt_author.py`, distilling the recurring structure observed
across `system_prompts_leaks/` (Anthropic, OpenAI, Cursor, etc.). Skeleton:

> You are a prompt engineer. Produce a system prompt for an AI agent given a
> brief and its runtime capabilities. Structure the output as: **Role & goal**,
> **Capabilities & how to use them** (only for enabled tools/features),
> **Tone & style**, **Constraints & safety**, **Output format**. Be specific and
> testable; prefer positive instructions and concrete examples over vague
> adjectives. Do not invent tools the agent doesn't have. Return only the prompt
> text, no preamble.

Capability injection: the helper renders the enabled flags into a bullet list
appended to the user message (e.g. "Web search: enabled — instruct the agent to
cite sources"; "Subagents: enabled — instruct delegation of large tasks"), so
the output only references real capabilities.

## 7. Seed / leak-distillation strategy

We do **not** import the 279 raw files (huge, product-specific, mostly not
reusable). Instead, ship ~6–10 hand-curated, generic role templates whose
structure follows §6. Proposed starter set:

| name                    | category   | gist |
|-------------------------|------------|------|
| General assistant       | general    | precise, helpful, asks when ambiguous |
| Coding agent            | coding     | plan → edit → verify; matches repo conventions |
| Code reviewer           | coding     | correctness + simplification, severity-ranked |
| Research analyst        | research   | multi-source, cites, separates fact vs inference |
| Support agent           | support    | friendly, scoped, escalates, no hallucinated policy |
| Structured extractor    | extraction | strict schema/JSON, no commentary |
| Writing/editor          | writing    | tone-matched, tightens prose |
| Data/SQL analyst        | analysis   | validates assumptions, shows query + result |

Each is written fresh (avoids copying any vendor's proprietary prompt verbatim —
see LICENSE note below) but informed by the leak patterns. A follow-up
`scripts/import_leaks.py` (optional, out of scope for v1) could load the raw
files into a separate read-only "reference" category for power users.

**Licensing/attribution note:** treat leak files as reference only. Curated
templates are original text describing generic roles, not reproductions of any
specific vendor prompt.

## 8. Build phases

1. **Backend model + CRUD.** `PromptTemplate` table, schema, `api/prompt_templates.py`,
   router registration. Migration handled by `init_db` (SQLModel create_all).
2. **Seed.** Curated builtin templates in `seed.py`, upsert-by-name.
3. **Frontend library.** API layer, types, Prompts tab, list + form dialog.
4. **Template picker.** "Start from template" on the Instructions field.
5. **Generation backend.** `prompt_author.py` + `/prompt/generate` & `/improve`.
6. **Generation UI.** Generate / Improve buttons wired to the form's capabilities.

Phases 1–4 ship the Library with no LLM calls; 5–6 add the Studio.

## 9. Open questions

1. Should builtin templates be editable/deletable, or read-only with a
   "duplicate to customize" action? (Leaning: read-only + duplicate.)
2. Generate/Improve model — always `settings.default_model`, or let the user
   pick (e.g. reuse the agent's own model)? (Leaning: default, with the agent's
   model as override if set.)
3. Do we want token streaming for generation in v1, or is a spinner fine?
   (Leaning: spinner; stream later.)
4. Where should "Generate/Improve" live if the agent isn't saved yet — they only
   need form state, not a persisted agent, so this works pre-save. Confirm UX.

## 10. Files touched (estimate)

**New**
- `backend/app/db/models.py` (+`PromptTemplate`)
- `backend/app/schemas/prompt_template.py`
- `backend/app/api/prompt_templates.py`
- `backend/app/agents/prompt_author.py`
- `frontend/src/api/prompt-templates.ts`
- `frontend/src/pages/prompts/prompts-page.tsx`
- `frontend/src/pages/prompts/prompt-form-dialog.tsx`

**Edited**
- `backend/app/main.py` (register router)
- `backend/app/api/agents.py` (+generate/improve)
- `backend/scripts/seed.py` (curated templates)
- `frontend/src/api/types.ts`, `api/agents.ts`
- `frontend/src/pages/customization/customization-page.tsx`
- `frontend/src/pages/agents/agent-form-dialog.tsx`
- `frontend/src/App.tsx` (redirect)
