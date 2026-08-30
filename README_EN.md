# Prism (`opencode-prism`)

[中文文档](./README.md) · [English Documentation](./README_EN.md)

Multi-model empowerment harness for OpenCode: automated vision interpretation, isolated background subtasks, and DAG-based complex task decomposition.

---

## Quick Start

### 1. Install Plugin
Add `opencode-prism` to your global configuration (`~/.config/opencode/opencode.json`) or project root `opencode.json` (requires **opencode ≥ 1.15.0**):

```jsonc
{
  "plugin": ["opencode-prism"]
}
```
*OpenCode downloads and caches the plugin automatically via Bun upon startup.*

### 2. Verify Installation
Restart OpenCode and run any Prism command to verify:

```text
/bg status
/split "Refactor auth module and update unit tests" --dry-run
```

---

## What This Is

Prism extends OpenCode into a multi-agent orchestration engine with zero external runtime dependencies:

- **Vision Interpretation Pipeline**: Automatic tool-output image interpretation + manual `vision_look` inspection with goal-directed focus.
- **Native Background Parallelism**: Native `/bg` command execution with instant receipts, image attachment forwarding, runtime steering (`bg_send`), and blocking barrier synchronization (`bg_wait`).
- **DAG Task Splitting & Scheduling**: `/split` decomposes complex tasks into dependency DAGs with intent-gate checks and ASAP subtask execution.
- **GFM Table Visualizer**: Markdown pipe tables that render perfectly across both TUI (fixed-width alignment) and Web UI (HTML table parsing without CJK font ratio distortion).
- **Hardened Message Gate (`PromptGate`)**: Single safe entry point for child-to-parent message injection with turn deduplication, wait-for-idle dispatch, and automatic retries.

---

## Architecture

```
                       ┌───────────────────────────────────────────────┐
                       │              OpenCode Host (TUI / Web)        │
                       └───────────────────────┬───────────────────────┘
                                               │
               ┌───────────────────────────────┴───────────────────────────────┐
               │                  Prism Plugin Engine (`index.ts`)             │
               │                                                               │
               │   Hooks: command-execute-before · tool-execute-after          │
               │          chat-message · chat-params · event · config          │
               └───────┬───────────────────────┬───────────────────────┬───────┘
                       │                       │                       │
         ┌─────────────▼─────────────┐   ┌─────▼─────────────┐   ┌─────▼─────────────┐
         │     Background Manager    │   │ Split DAG Service │   │  Vision Pipeline  │
         │  (Concurrency Limiter /   │   │(Planner / Intent /│   │(Interpreter /     │
         │   Steering Queue / TUI)   │   │  ASAP Scheduler)  │   │ Model Tracker)    │
         └─────────────┬─────────────┘   └─────┬─────────────┘   └─────┬─────────────┘
                       │                       │                       │
                       └───────────────────────┼───────────────────────┘
                                               │
                               ┌───────────────▼───────────────┐
                               │   PromptGate (Single Ingress) │
                               │(Dedupe / Idle-wait / Retries) │
                               └───────────────┬───────────────┘
                                               │ (Parent Notification)
                               ┌───────────────▼───────────────┐
                               │     Parent Chat Session       │
                               └───────────────────────────────┘
```

| Engine Layer | Core Component | Responsibility |
|---|---|---|
| **Command & Ingress** | `command-execute-before` | Intercepts `/bg` & `/split` for instant native execution without LLM latency. |
| **Execution Core** | `BackgroundManager` | Manages child session lifecycles, concurrency slots, steering message queues, and error recovery. |
| **Orchestration Core**| `SplitService` & `Scheduler` | Evaluates task complexity, generates task DAGs, and executes subtasks ASAP once dependencies clear. |
| **Multimodal Core** | `VisionPipeline` | Manages tool output image detection, format validation, and dedicated interpretation sessions. |
| **Parent Ingress** | `PromptGate` | Serializes, deduplicates, and dispatches background completion and aggregate summaries to parent session. |

---

## Components

| Category | Component | Description |
|---|---|---|
| **Command** | `/bg` | Native background task runner: launch, monitor, steer (`send`/`resume`), and cancel subtasks. |
| **Command** | `/split` | Native task decomposition: intent check, dry-run plan review, DAG execution, and status inspection. |
| **Tool** | `bg_spawn` | Proactively or explicitly launch an isolated background session (inherits parent model). |
| **Tool** | `bg_output` | Query execution status, tool-call progress, queued steering messages, or task results. |
| **Tool** | `bg_send` | Send follow-up steering instructions to running tasks or resume completed tasks. |
| **Tool** | `bg_cancel` | Abort a background subtask and immediately release its concurrency slot. |
| **Tool** | `bg_wait` | Blocking synchronization barrier that awaits background task completion before summarization. |
| **Tool** | `split_task` | Decompose multi-step, multi-module tasks into DAG subtasks with automated result aggregation. |
| **Tool** | `vision_look` | Dedicated image inspection tool supporting chat images (`"last"`), local paths, URLs, and `[Image N]` refs. |
| **Visualizer** | `renderBgDashboard` | Renders GFM pipe tables for background task status and resource pool occupancy. |
| **Visualizer** | `renderSplitDag` | Renders wave-based or hierarchical DAG dependency execution trees. |

---

## Workflows & Usage

### 1. Background Parallelism (`/bg`)

Execute long-running research, tests, or submodules in independent child sessions:

```text
/bg Refactor auth module and write unit tests        # Native launch: returns task ID immediately
/bg Benchmark competitor APIs --parallel 3          # Model-assisted: decomposes into 3 concurrent subtasks
/bg Analyze current system diagram [with screenshot] # Auto-forwards current message image to child session
/bg status                                          # Renders live GFM pipe status table
/bg status --all                                    # Shows complete history including terminated tasks
/bg status bg_a1b2c3d4e5f6                          # Shows detailed progress and tool calls for a task
/bg output bg_a1b2c3d4e5f6                          # Retrieves task output, errors, and results
/bg output bg_a1b2c3d4e5f6 --full                   # Includes opencode attach hint for session inspection
/bg send bg_a1b2c3d4e5f6 "Do not touch public APIs" # Steer running task: queues for next turn boundary
/bg resume bg_a1b2c3d4e5f6 "Proceed to phase 2"     # Resume finished task in existing child session
/bg cancel bg_a1b2c3d4e5f6                          # Cancels a specific background task
/bg cancel                                          # Cancels all pending/running tasks in current session
```

#### Status Dashboard Example (`/bg status`)
```text
PRISM BACKGROUND TASKS (Running: 2, Queued: 1)
| ID              | Description      | Status     | Duration | Progress |
| --------------- | ---------------- | ---------- | -------- | -------- |
| bg_a1b2c3d4e5f6 | Refactor auth    | RUNNING    | 42s      | 12 calls |
| bg_e5f6a7b8c9d0 | Run E2E tests    | RUNNING    | 18s      | 3 calls  |
| bg_9f8e7d6c5b4a | Benchmark db     | QUEUED     | -        | queued   |

+ 3 finished: 2 COMPLETED, 1 CANCELLED (Use /bg status --all to see full history)
Pool: anthropic/claude-3-7-sonnet: 2/5 running
```

#### Live TUI Navigation
Every background task runs in a real OpenCode session (`[bg_xxxxxxxx] Description (prism)`):
- In OpenCode TUI, press **`Ctrl+X` then `↓`** to view real-time subtask output streaming.
- Use `←` / `→` to switch between active subtasks, and `↑` to return to the parent session.
- These are the default TUI keybindings (customizable via OpenCode's `keybinds` configuration).

---

### 2. Complex Task Decomposition (`/split`)

Break down multi-step architectural or refactoring jobs into a dependency graph:

```text
/split "Migrate landing page to Tailwind CSS" --dry-run   # Preview DAG breakdown without execution
/split "Migrate landing page to Tailwind CSS"             # Plan -> Execute DAG -> Aggregate summary
/split "Large refactoring" --sequential                  # Execute subtasks sequentially in order
/split "Large refactoring" --max 6                       # Cap subtasks (2–12, clamped automatically)
/split status                                            # Shows active split run DAG tree
/split status sp_7f8a9b0c                                # Shows specific run DAG details
/split cancel sp_7f8a9b0c                                # Cancels run; marks dependent tasks SKIPPED
```

#### DAG Hierarchy Example (`/split status`)
```text
[prism split] sp_7f8a9b0c (1/4 tasks finished)

  Wave 1 (No dependencies, started immediately)
  [t1] Extract core component library    COMPLETED (35s, 8 tools)
  [t2] Upgrade Tailwind config files     RUNNING   (15s, 3 tools)

  Wave 2 (Depends on Wave 1, starts ASAP when dependencies finish)
  [t3] Refactor Header component         BLOCKED   (Waiting for: t1)
  [t4] Refactor Footer page              BLOCKED   (Waiting for: t1, t2)
```

---

### 3. Vision Interpretation (`vision_look`)

1. **Automatic Interpretation**: When tools emit images (e.g. browser screenshots), Prism intercepts output in `messages.transform` / `tool-execute-after` and appends `[prism vision]` interpretation text directly.
2. **Manual Inspection (`vision_look`)**:
   - Chat images & screenshots: `vision_look(images: "last", goal: "Extract form fields")`
   - Local files: `vision_look(images: ["./docs/arch.png"], goal: "Review component layout")`
   - Remote URLs: `vision_look(images: ["https://example.com/mockup.png"])`

---

## Configuration

Configuration resolution hierarchy:
1. Environment override: `PRISM_CONFIG=/path/to/config.jsonc` (takes exclusive precedence)
2. Project-level: `.prism/prism.jsonc` (searched upwards from working directory to `$HOME`)
3. User-level: `~/.prism/prism.jsonc`
4. Built-in defaults

```jsonc
{
  "vision": {
    "enabled": true,                             // Master switch (false unregisters vision_look)
    "model": "",                                 // provider/model (e.g. "openai/gpt-4o"); empty = inherit parent model
    "mode": "sync",                              // "sync" (blocks tool output) | "async" (spawns bg task)
    "tools": ["read"]                            // Filter intercepted tools; omitted = all; [] = disable auto-intercept
  },
  "background": {
    "concurrency": 5,                            // Maximum concurrent subtasks per provider/model
    "autoTrigger": true                          // Allow model to autonomously invoke bg_spawn for long-running tasks
  },
  "split": {
    "tool": true,                                // Master toggle for split_task tool and /split command
    "intentCheck": true,                         // Fast intent classifier to prevent over-splitting simple tasks
    "autoTrigger": true                          // Allow model to autonomously invoke split_task on complex tasks
  }
}
```

---

## Permissions & Safety Boundaries

| Scope | Security & Runtime Contract |
|---|---|
| **Zero Runtime Dependencies** | Production dependencies are strictly locked to `@opencode-ai/plugin` and `zod`. No external binaries or native modules. |
| **Hook Error Absorption** | All hooks are guarded by `guardHook`. Exceptions are written to logs and never thrown into OpenCode TUI. |
| **No Console Pollution** | Zero `console.log/error/info` usage. Diagnostic logs write exclusively to `~/.local/share/opencode/log/prism.log` (overridable via `PRISM_LOG_FILE`). |
| **Child Tool Isolation** | Background child sessions strictly disable `bg_*` and `question` tools. Vision child sessions disable all Prism tools to prevent recursive storms. |
| **Remote Image Fetch** | Only `http://` and `https://` protocols are fetched (capped at 4MB/image, verified via magic numbers). |
| **Single Ingress Gate** | All asynchronous injections into parent session must pass through `PromptGate` for serialization and deduplication. |

---

## Development

```bash
bun install
bun test              # Run unit test suite (schemas, scheduler, state machines, visualizers)
bun run typecheck     # Strict TypeScript type check (tsc --noEmit)
bun run build         # Bundle plugin to dist/index.js
```

### Source Tree
```
src/
├── index.ts                 # Plugin entrypoint: wires configs, gate, services, hooks, tools
├── config/                  # Multi-layer JSONC config loader with field-level fallback
├── core/
│   ├── prompt-gate.ts       # Central parent session prompt injection gate
│   ├── background/          # Background task manager, concurrency limiter, visualizer
│   ├── split/               # DAG planner, intent classifier, ASAP scheduler, service
│   └── vision/              # Multimodal pipeline, image detector, interpreter, model tracker
├── models/                  # Provider/model resolution and error classifiers
├── hooks/                   # command-execute-before, chat-message, tool-execute-after, etc.
├── tools/                   # Tool definitions: bg_spawn, bg_send, bg_wait, split_task, vision_look
├── commands/                # Command templates and argument hints for /bg and /split
└── shared/                  # Logging, hook guards, API result parsers, session data schemas
```

---

## License

MIT License. See [LICENSE](./LICENSE) for details.
