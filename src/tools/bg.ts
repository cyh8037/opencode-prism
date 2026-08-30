import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import { BG_WAIT_DEFAULT_MS, BG_WAIT_MAX_MS } from "../config/constants"
import type { BackgroundManager } from "../core/background/manager"
import { collectImageFollowParts } from "../core/background/image-follow"
import type { PrismClient } from "../core/client-types"
import { navigationHint } from "../commands/templates"

// LLM-facing tools for the background engine. Commands (/bg, /split) are the
// primary UX; these tools let the model drive the same engine mid-task.
export function createBgTools(
  manager: BackgroundManager,
  opts: { visionEnabled?: boolean; autoTrigger?: boolean; client?: PrismClient; directory?: string; tuiNavigation?: boolean } = {},
): Record<string, ToolDefinition> {
  // With the vision feature disabled the child sessions also lose vision_look
  // from their tool lists — the read-image guidance must not point at a tool
  // that would fail with "not found".
  const visionEnabled = opts.visionEnabled ?? true
  const visionGuidance = visionEnabled
    ? " When images are involved: image attachments in the current message are forwarded to the child session automatically (subtask uses vision_look to read images); if the image is a local file or from earlier messages, include the local path/URL in prompt and instruct the subtask to read it with vision_look."
    : ""
  // Strategy A (background.autoTrigger, read on plugin load): model can proactively
  // invoke bg_spawn under scenarios listed in the description without waiting for explicit
  // user request. Boundaries are stated clearly in description.
  const autoTriggerGuidance =
    opts.autoTrigger ?? true
      ? "\n[Autonomous Trigger Guidelines] You may proactively invoke this tool (without explicit user request) and immediately inform the user that execution has moved to the background for:\n1. Time-consuming wide-scope read-only research, codebase searches, log analysis, or documentation lookups;\n2. Compilation, full test suites, or performance benchmarks isolated from current edits;\n3. Multiple mutually independent submodules/tasks (launch multiple bg_spawn calls in the same turn).\n[Non-applicable Scenarios] Interactive multi-turn dialogues requiring real-time user confirmation; editing the same set of files as the main session; destructive operations (deleting data, modifying production environments). Do not invoke if uncertain."
      : ""
  return {
    bg_spawn: tool({
      description:
        "Launch a background subtask (runs concurrently in an isolated session). Suitable for asynchronous work like exploration, research, or parallel implementation. The parent session receives an aggregated summary notification when finished." +
        autoTriggerGuidance +
        visionGuidance,
      args: {
        description: tool.schema.string().describe("Brief task description for notifications and status display"),
        prompt: tool.schema.string().describe("Complete instructions for the subtask"),
        agent: tool.schema.string().optional().describe("Optional OpenCode agent name"),
      },
      async execute(args: { description: string; prompt: string; agent?: string }, ctx) {
        try {
          let parts: Array<Record<string, unknown>> | undefined
          if (args.prompt) {
            parts = [{ type: "text", text: args.prompt, synthetic: true }]
          }
          if (opts.client && visionEnabled) {
            const followImages = await collectImageFollowParts({
              client: opts.client,
              directory: opts.directory,
              sessionID: ctx.sessionID,
            })
            if (followImages) parts = [...(parts ?? []), ...followImages]
          }
          const task = await manager.launch({
            description: args.description,
            prompt: args.prompt,
            parts,
            parentSessionId: ctx.sessionID,
            agent: args.agent,
          })
          const model = task.model ? `model ${task.model.providerID}/${task.model.modelID}` : ""
          return (
            `Background task enqueued: \`${task.id}\` (${task.description}) ${model}\n`
            + `Use bg_output("${task.id}") to query status, bg_cancel("${task.id}") to cancel.\n`
            + navigationHint(opts.tuiNavigation ?? true)
          )
        } catch (error) {
          return `Failed to launch background task: ${error instanceof Error ? error.message : String(error)}`
        }
      },
    }),

    bg_output: tool({
      description: "Query the status or result of a background task.",
      args: {
        taskId: tool.schema.string().describe("Task ID (bg_ prefix)"),
      },
      async execute(args: { taskId: string }, ctx: { sessionID: string }) {
        const task = manager.getTask(args.taskId)
        if (!task) return `Task not found or expired: ${args.taskId}`
        if (task.parentSessionId !== ctx.sessionID) {
          return `Unauthorized: cannot access tasks from another session: ${args.taskId}`
        }
        const lines = [`Task \`${task.id}\`: ${task.description}`, `Status: ${task.status}`]
        if (task.error) lines.push(`Error: ${task.error}`)
        if (task.status === "running" || task.status === "pending") {
          const toolCalls = task.progress?.toolCalls ?? 0
          lines.push(`Progress: ${toolCalls} tool calls${task.progress?.lastTool ? `, latest: ${task.progress.lastTool}` : ""}`)
          const queued = task.steeringQueue?.length ?? 0
          if (queued > 0) lines.push(`Queued steering instructions: ${queued} (will deliver after current turn ends)`)
        }
        if (task.resultText) lines.push(`\nResult:\n${task.resultText.slice(0, 2000)}`)
        return lines.join("\n")
      },
    }),

    bg_cancel: tool({
      description: "Cancel a background task (aborts its child session and releases concurrency slot).",
      args: {
        taskId: tool.schema.string().describe("Task ID (bg_ prefix)"),
      },
      async execute(args: { taskId: string }, ctx: { sessionID: string }) {
        const task = manager.getTask(args.taskId)
        if (task && task.parentSessionId !== ctx.sessionID) {
          return `Unauthorized: cannot cancel tasks from another session: ${args.taskId}`
        }
        const cancelled = await manager.cancelTask(args.taskId, { source: "bg_cancel" })
        return cancelled ? `Cancelled task \`${args.taskId}\`` : `Failed to cancel: task not found or already finished (${args.taskId})`
      },
    }),

    bg_send: tool({
      description:
        "Send steering instructions to a background task. While running: message queues and delivers at turn boundary (without interrupting execution, child session context fully preserved); when finished: continues dialogue in the child session (resumes run). Useful for supplying new info, correcting direction, or adding constraints.",
      args: {
        taskId: tool.schema.string().describe("Task ID (bg_ prefix)"),
        message: tool.schema.string().describe("Steering instruction content (new decisions, corrections, extra requirements, etc.)"),
      },
      async execute(args: { taskId: string; message: string }, ctx: { sessionID: string }) {
        const task = manager.getTask(args.taskId)
        if (!task) return `Task not found or expired: ${args.taskId}`
        if (task.parentSessionId !== ctx.sessionID) {
          return `Unauthorized: cannot operate on tasks from another session: ${args.taskId}`
        }
        try {
          const result = await manager.send(args.taskId, args.message)
          if (result.queued) {
            return (
              `Steering instruction queued, will deliver after task's current turn ends: \`${args.taskId}\` (queue length ${result.queueLength}). ` +
              "Task continues running, and a notification will be received upon completion."
            )
          }
          return `Task \`${args.taskId}\` resumed running (follow-up sent to child session), notification will be received upon completion`
        } catch (error) {
          return `Failed to send steering instruction: ${error instanceof Error ? error.message : String(error)}`
        }
      },
    }),

    bg_wait: tool({
      description:
        "Wait for background tasks to finish (blocks until specified tasks or all pending tasks in the current session reach a terminal state, or timeouts returning current status). Use when background results are required to proceed (e.g. before summarization); do not use for polling a single task (bg_output is preferred).",
      args: {
        taskIds: tool.schema
          .array(tool.schema.string())
          .optional()
          .describe("List of task IDs to wait for; omitted = all pending tasks in current session; explicit empty array = nothing to wait for, returns immediately"),
        timeoutMs: tool.schema
          .number()
          .optional()
          .describe(`Maximum wait time in milliseconds (default ${BG_WAIT_DEFAULT_MS}, max ${BG_WAIT_MAX_MS})`),
      },
      async execute(
        args: { taskIds?: string[]; timeoutMs?: number },
        ctx: { sessionID: string },
      ) {
        const unknown: string[] = []
        const foreign: string[] = []
        let ids: string[]
        // Explicit [] is NOT the default: a caller naming zero tasks means
        // "nothing to wait for" and must not block on the session's whole
        // backlog; only an omitted argument widens the scope.
        if (args.taskIds !== undefined) {
          ids = []
          for (const id of args.taskIds) {
            const task = manager.getTask(id)
            if (!task) unknown.push(id)
            else if (task.parentSessionId !== ctx.sessionID) foreign.push(id)
            else ids.push(id)
          }
        } else {
          ids = manager
            .getTasksByParentSession(ctx.sessionID)
            .filter((task) => task.status === "running" || task.status === "pending")
            .map((task) => task.id)
        }
        if (ids.length === 0) {
          const notes = [
            unknown.length > 0 ? `not found or expired: ${unknown.join(", ")}` : "",
            foreign.length > 0 ? `unauthorized access to other session tasks: ${foreign.join(", ")}` : "",
          ].filter(Boolean)
          return `No background tasks to wait for.${notes.length > 0 ? ` (${notes.join("; ")})` : ""}`
        }

        const timeout = Math.min(Math.max(args.timeoutMs ?? BG_WAIT_DEFAULT_MS, 1_000), BG_WAIT_MAX_MS)
        const { tasks, timedOut } = await manager.waitForTasks(ids, timeout)

        const lines: string[] = []
        if (timedOut) lines.push(`Wait timed out (${timeout}ms), current status:`)
        else lines.push(`Wait completed (${tasks.length} tasks):`)
        for (const task of tasks) {
          lines.push(`- \`${task.id}\` ${task.description}: ${task.status.toUpperCase()}`)
          if (task.error) lines.push(`  Error: ${task.error.slice(0, 120)}`)
          if (task.resultText) lines.push(`  Result: ${task.resultText.slice(0, 200)}`)
        }
        if (timedOut) lines.push("", "You can call bg_wait again to continue waiting, or use bg_output(task_id) to check details.")
        return lines.join("\n")
      },
    }),
  }
}
