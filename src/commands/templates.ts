import { BG_SESSION_NAV_HINT } from "../config/constants"

export interface PrismCommandDefinition {
  description: string
  template: string
  argumentHint: string
}

// Command template first-line markers: shared between hook (chat-message command turn check)
// and template constants to prevent silent mismatch from independent string drift.
export const BG_COMMAND_TEMPLATE_MARKER = "You are handling Prism's /bg command."
export const SPLIT_COMMAND_TEMPLATE_MARKER = "You are handling Prism's /split command."

// Unified exit point for child session real-time viewing instructions:
// shared across /bg, /split command templates and bg_spawn tool receipts.
export function navigationHint(tuiNavigation: boolean): string {
  return tuiNavigation
    ? `After launch, ${BG_SESSION_NAV_HINT}.`
    : "After launch, check progress via /bg status or bg_output."
}

// Command templates are passed verbatim to the LLM (opencode only replaces
// $ARGUMENTS / $1..$9 and @file references), so they are written as plain
// markdown — no fake XML blocks.
//
// Native command execution (0.5.0): task descriptions and deterministic subcommands
// are handled directly by the plugin in command.execute.before. The template only retains
// the duty of "relaying injected results" — $ARGUMENTS is intentionally omitted so the model
// will not bypass tools and execute tasks itself upon seeing the prompt. The only branch
// requiring model decisions is --parallel, where semantic decomposition is delegated to the LLM
// via an injected [Parallel Launch] instruction part.
export function createBgCommand(visionEnabled: boolean, tuiNavigation = true): PrismCommandDefinition {
  const parallelVisionRules = visionEnabled
    ? [
        "- Subtasks involving images: forwarded automatically to the corresponding child session, use vision_look to inspect images directly; if the image is a local file, include the file path in that subtask's prompt. Tasks involving images must run in the background via bg_spawn.",
      ]
    : []
  return {
    description: "Prism background task: launch independent subtasks in parallel and track progress",
    argumentHint:
      "<task description> | status [--all] | status <task_id> | output <task_id> | cancel <task_id> | resume|send <task_id> <follow-up/instruction>",
    template: [
      BG_COMMAND_TEMPLATE_MARKER,
      "",
      // Status table is a markdown pipe table (option a): model must retain | column delimiters
      // when relaying so web UI renders it as a table; rewriting to a list breaks rendering.
      "- Default (injected execution receipt or status table): relay the injected content completely to the user (including instruction and navigation lines; do not omit, compress, or reorder), do not invoke any tools (including bg_spawn), do not re-execute the task, do not rewrite as a list, do not add emoji or extra symbols; preserve table '|' column delimiters.",
      "- Only when injected content contains [Parallel Launch N=x] marker: decompose the task into N mutually independent subtasks, invoke bg_spawn N times concurrently in the same turn (never await sequentially), and inform the user of each subtask's ID and purpose after launch.",
      ...parallelVisionRules.map((line) => `  ${line}`),
      "- How to view execution progress: "
        + (tuiNavigation
          ? BG_SESSION_NAV_HINT + " (prefixed with [bg_ task id], cycle with ←/→). Do not poll by repeatedly calling bg_output."
          : "Check via /bg status or bg_output tool. Do not poll actively."),
      "- The parent session will automatically receive a summary notification when background tasks finish; no active polling is needed.",
    ].join("\n"),
  }
}

export function createSplitCommand(visionEnabled: boolean, tuiNavigation = true): PrismCommandDefinition {
  const visionLine = visionEnabled
    ? [
        "- Split subtasks involving images: subtasks use vision_look to read images.",
      ]
    : []
  return {
    description: "Prism task split: decompose complex tasks into subtasks and execute concurrently",
    argumentHint:
      "<task description> [--dry-run] [--sequential] [--max <n>] | status [--all] | status <run_id> | output <task_id> | cancel <sp_run_id> | cancel <task_id>",
    template: [
      SPLIT_COMMAND_TEMPLATE_MARKER,
      "",
      "- Default (injected execution result): relay the injected content completely to the user (including instructions and tips; do not omit, compress, or reorder), do not invoke any tools (including split_task), do not rewrite as a list, do not add emoji, preserve hierarchical structure and dependency notes, do not merge lines; preserve table '|' column delimiters.",
      "- Injected \"Intent check: no split needed\": relay the explanation as-is and suggest adding more details or setting split.intentCheck=false.",
      "- How to view subtask execution: "
        + (tuiNavigation
          ? BG_SESSION_NAV_HINT + " (prefixed with [bg_ task id])"
          : "Check via /split status or bg_output"),
      ...visionLine,
      "- Split subtasks execute concurrently in the background and automatically inject a summary notification upon completion; no active polling is needed.",
    ].join("\n"),
  }
}
