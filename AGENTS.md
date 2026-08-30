# AGENTS.md — Prism Repository Agent Collaboration Contract

This document serves as the **supreme engineering contract** for AI Agents working in this repository. All code modifications, testing, and reviews must strictly adhere to these guidelines.

---

## 1. Project Positioning & Hard Boundaries

**Prism (`opencode-prism`)** is a multi-model empowerment plugin for OpenCode, providing three core capabilities:
- **Vision Interpretation (`Vision`)**: Automatic interpretation of image attachments in tool outputs (via two-stage `messages.transform`) + manual inspection via `vision_look`.
- **Background Parallelism (`Background`)**: Native `/bg` command and `bg_*` tools executing in isolated child sessions concurrently, supporting runtime steering (`bg_send`), blocking barriers (`bg_wait`), and summary notifications injected back to the parent session.
- **Task Splitting (`Split`)**: Native `/split` command and `split_task` tool for dependency DAG scheduling and execution (starting subtasks ASAP once dependencies resolve) with automated result aggregation.

### 🚨 Zero-Tolerance Rules (Absolute Red Lines)
1. **Zero Extra Runtime Dependencies**: Production dependencies are strictly locked to `@opencode-ai/plugin` and `zod` (externalized at build time). Introducing any other npm packages or depending on APIs outside standard OpenCode harnesses is strictly forbidden.
2. **Hooks Never Throw Outwardly**: All hooks must be wrapped with `guardHook` (`src/shared/hook-guard.ts`). Internal exceptions must be logged via `log()` and swallowed. Hook errors bubble up as session error events in OpenCode, which severely corrupts TUI rendering.
3. **No Console Pollution**: Never use `console.log/error/info` (which leaks into the TUI and breaks interface rendering). Route all diagnostics through `src/shared/log.ts` (`PRISM_LOG_FILE` overridable).
4. **Single Ingress Gate for Parent Prompts**: All internal messages injected into parent sessions (except native hook returns) **must pass through `PromptGate`** (`src/core/prompt-gate.ts`). Direct naked calls to `client.session.prompt` or `promptAsync` are strictly prohibited.

---

## 2. Architectural Mental Model & Responsibility Map

```
src/
├── index.ts                 # Plugin entrypoint: wires config → gate → services → hooks → tools
├── config/                  # Multi-layer config loader with field-level fallback validation
├── core/
│   ├── prompt-gate.ts       # Central prompt injection gate (reservations, deduplication, idle-wait, retries)
│   ├── background/          # Background subtask manager (concurrency control, lifecycle scheduling)
│   ├── split/               # Task splitting (Planner -> Plan-Schema -> Scheduler -> Service)
│   └── vision/              # Vision pipeline (Pipeline -> Interpreter -> ModelTracker -> Detector)
├── models/                  # Provider/model reference resolution and error classification
├── hooks/                   # Single-responsibility hook factories (createXxxHook)
├── tools/                   # LLM-callable tools (vision_look / bg_* / split_task)
├── commands/                # /bg, /split command templates (in-place registration via config hook)
└── shared/                  # Logging (log), guards (hook-guard), API result parsing (api-result), schemas
```

### Core Hooks Quick Reference
| Hook | Trigger Point | Core Responsibility | Contracts & Invariants |
|---|---|---|---|
| `command-execute-before` | User command input | Intercepts `/bg` & `/split`: deterministic subcommands and **task descriptions** execute natively (spawn/query/cancel/DAG schedule) with instant receipts; only `/bg --parallel N` is delegated to LLM decomposition. | Template only relays injected receipts. **Never await LLM polling inside hooks** (sub-second I/O is allowed). LLM turns always occur in OpenCode; duplicate execution prevention relies on "templates omitting `$ARGUMENTS` + strict model instructions". |
| `tool-execute-after` | Tool execution return | Auto-interpretation (Trigger A): intercepts tool outputs containing image attachments. | Strictly guarded by the triple-gate defense. |
| `chat-message` | Before message dispatch | Chat image hint: injects `vision_look` reminder for text-only models (zero-blocking). | **Must strictly satisfy the Chat-Message Part Integrity Contract**. |
| `chat-params` | Chat parameter generation | Read-only: feeds `CurrentModelTracker` (tracks current model and multimodal capability). | Read-only consumer; never modifies parameters. |
| `event` | OpenCode event stream | Forwards events consumed by the background engine; cleans up Gate/Tracker on `session.deleted`. | Listens to session lifecycle. |
| `config` | Plugin initialization | Registers `/bg` and `/split` command templates in-place. | **Modifies `configInput` in-place; return value is discarded** (verified in OpenCode 1.18). |

---

## 3. Core Architectural Invariants (Load-Bearing Structures)

> ⚠️ **Warning**: The following mechanisms were established after extensive testing and production incident analyses. **Refactoring, simplifying, or removing code for "deduplication" in these areas is strictly forbidden.**

### 3.1 Triple-Gate Defense for Vision
- Setting `config.vision.enabled: false` is a total kill-switch: `vision_look` is unregistered and automatic interpretation is disabled.
- Gate checks are hardcoded and intentionally duplicated across three checkpoints: `tool-execute-after`, `getVisionModel` (`src/index.ts`), and `pipeline.onToolOutput`. Comments in each location cross-reference the others. Do not remove any of these checks.

### 3.2 Child Session Tool Isolation & Recursion Defense
- **Hard Tool Filtering**:
  - Background child sessions strictly disable `bg_*` and `question` tools (`childToolFilters` in `manager.ts`); `vision_look` is retained when vision is enabled (to allow async vision tasks to inspect images) and removed when disabled.
  - Synchronous vision interpretation sessions use `VISION_CHILD_TOOL_FILTERS` to disable all Prism tools and `question`.
- **Load-Bearing Runtime Guards**: The primary barrier against recursive storms is `isInterpretationSession` (active in `vision-look`, `pipeline.onToolOutput`, and `chat-message`). **Removing this guard causes recursive child session storms.**
- **Checklist for New Autonomous Tool Invocations (`autoTrigger`)**:
  1. Verify child tool filters cover the new entrypoint (`childToolFilters` / `JSON_CHILD_TOOL_FILTERS`, including one-off JSON sessions);
  2. Ensure recursion guards cover child session variations;
  3. Ensure execution budgets (`MAX_TOOL_CALLS`) apply to newly spawned sessions;
  4. Ensure `resultText` authority (`validateSessionHasOutput` always overrides event-path text via the Messages API).

### 3.3 Message Construction & Client Invocation Contract
- **Chat-Message Part Contract**: Dynamic parts pushed in `chat-message` **must** include `id` (prefixed with `prt_`), `sessionID`, and `messageID` (sourced from `output.message.id`). Missing fields cause persistence failure ("invalid user part before save" session freeze bug).
- **Client 4xx/5xx Contract**: OpenCode client 4xx/5xx errors are resolved as `{ error }` rather than rejected promises.
  - Always use `errorInfoFromResult` (`src/shared/api-result.ts`) to determine failure.
  - Resolved rejections are the **only** safe, retryable failure class; thrown errors indicate the request may have already landed, where blind retries could cause duplicate injections.

### 3.4 Model Inheritance & Configuration Fallback
- **Three-Tier Model Fallback Chain**: `Session object` → `Latest message info.model` → `Config default model`. When the parent session switches models via `/models`, subsequent tasks follow automatically.
- **Field-Level Configuration Fallback**: Invalid fields fall back to their defaults individually while preserving valid fields in the same section (e.g. invalid `vision.mode` falls back to default while retaining valid timeouts).
- **Version Behavior Dependency Matrix**:

| Dependency | Introduced | Host Behavior Verified |
|---|---|---|
| `chat.message` / `chat.params` / `tool.execute.*` / `event` / `config` | 1.0.0 | 1.18.25 |
| `command.execute.before` (parts merge into command message; command triggers LLM turn) | **1.2.0** | 1.18.25 |
| `experimental.chat.messages.transform` / `experimental.chat.system.transform` | 1.2.0 | 1.18.25 |
| `client.session.status` (busy/retry fields) | ≥1.4 | 1.18 |
| TUI child session navigation (`parentID` grouping) | 1.15.0 | 1.15.0 / 1.18.25 |
| `client.tui.*` (unversioned runtime surface, not in SDK types) | — | Probed via `isTuiClient` |

Prism officially supports **OpenCode ≥ 1.15.0** (specifically hardened and tested on 1.18.x).

### 3.5 Tolerant Zod Parsing at Data Boundaries
- All external data boundaries (SDK returns, event properties, message histories, LLM JSON outputs) **must be parsed using tolerant Zod schemas**. Avoid manual `typeof`/`isRecord`/`as` casting chains.
- Shared schemas are centralized in `src/shared/session-data.ts` and `src/shared/api-result.ts`.
- Three tolerant rules:
  1. Safe item-by-item parsing (skip bad records instead of rejecting the whole payload);
  2. Field-level fallback (`.optional().catch(undefined)`);
  3. Fail-closed semantics for untrusted system states (e.g. if `sessionStatusMapSchema` fails, defer task completion checks to avoid prematurely aborting running tasks).

### 3.6 Injected-Text Contract
- **Dashboards & tables must use GFM Markdown Pipe Tables without ` ```text ` fences**: Web UI code blocks have unequal CJK-to-ASCII font proportions (~1.67×), causing box-drawing characters to misalign. Markdown pipe tables parse into native HTML tables in web views while maintaining fixed-width alignment in TUI.
- **Pure hierarchical indentation (dry-run plans, run details) must retain ` ```text ` fences** to prevent markdown parsers from collapsing whitespace.
- **Command templates must not contain `$ARGUMENTS`**: Task descriptions are handled natively in hooks. Leaving `$ARGUMENTS` in templates tempts models to execute tasks directly without calling tools.

### 3.7 Language & Interface Boundary Contract
Prism strictly enforces a decoupled, two-tier language boundary:
1. **Human UI Layer (100% Natural Chinese)**:
   - Covers all user-facing surfaces: TUI toasts (`client.tui.showToast`), native command interception receipts (`command-execute-before`), usage hints (`用法: /bg ...`), status boards, and error diagnostics.
   - Forbid cryptic mechanical translations or internal jargon (e.g. forbid "leader key" or "inject back to parent"; use explicit shortcut hints like `Ctrl+X + ↓` and natural action descriptions like `在此自动汇总结果`).
2. **LLM Protocol Layer (100% Standard English)**:
   - Covers all model-facing surfaces: tool schemas (`description` and `args` in `src/tools/*.ts`), system prompt instruction templates (`src/commands/templates.ts`), and synthetic reminders/tool returns fed into model turns.
   - Never mix arbitrary Chinese phrases into protocol definitions, ensuring maximum semantic comprehension and tool invocation reliability across global multi-model harnesses.

---

## 4. Development & Testing Standards

### Runtime & Language Conventions
- **Runtime**: Pure Bun environment (`bun test` / `bun run typecheck` / `bun run build`).
- **TypeScript**: Strict mode enabled with `noUncheckedIndexedAccess` and `verbatimModuleSyntax` (types must use `import type`).
- **Commit Conventions**: Conventional Commits (`feat:`, `fix:`, `chore:`, `release:`).
- **No Autonomous Commits**: Agents must never run `git commit` or `git push` without explicit user instruction. Completion means code, tests, and documentation are ready for user inspection.

### Testing & QA Protocols (Mandatory)
1. **"Typecheck passes" ≠ Complete**: Unit tests cannot verify complex OpenCode hook lifecycles or message injections.
2. **Strict Test Boundaries**:
   - **Unit Tests (`tests/*.test.ts`)**: Test pure business logic (schema validation, state machines, topological sorts, config fallbacks).
   - **Real Sandbox QA (`scripts/qa/sandbox-run.sh`)**: All changes touching hook triggers, child session lifecycles, or message re-injection must be verified in an isolated XDG sandbox using `opencode serve` + HTTP API automation.
3. **Written QA Evidence**: Verification findings and outputs must be documented under `docs/qa/YYYY-MM-DD-<topic>.md`.
4. **Documentation Synchronization**: All user-facing changes (configurations, commands, tools, runtime behaviors) must be kept in sync with `README.md`.

---

## 5. Configuration & Release

### Configuration Priority
1. `PRISM_CONFIG=/path/to/config.jsonc` (Exclusive override)
2. Project-level `.prism/prism.jsonc` (Traversed upwards from current directory to `$HOME`)
3. User-level `~/.prism/prism.jsonc`
4. Built-in defaults

### Release Workflow
1. Bump version in `package.json` (e.g. `0.4.0-beta.2`).
2. Create an isolated release commit (e.g. `release: 0.4.0-beta.2`).
