import type { BackgroundManager } from "../core/background/manager"
import type { BgTask } from "../core/background/types"
import type { PrismClient } from "../core/client-types"

type CommandInput = { command: string; sessionID: string; arguments: string }
type CommandOutput = { parts: Array<{ type: string; text?: string; [key: string]: unknown }> }

function pushText(output: CommandOutput, text: string): void {
  output.parts.push({ type: "text", text, synthetic: true })
}

function formatTaskTable(manager: BackgroundManager, sessionID: string): string {
  const tasks = manager.getTasksByParentSession(sessionID)
  if (tasks.length === 0) return "当前会话没有后台任务。"
  const rows = tasks
    .map((task) => {
      const model = task.model ? `${task.model.providerID}/${task.model.modelID}` : "-"
      const toolCalls = task.progress?.toolCalls ?? 0
      const queued = task.steeringQueue?.length ?? 0
      return `| \`${task.id}\` | ${task.description} | ${task.status} | ${model} | ${toolCalls} tool calls | ${
        queued > 0 ? `${queued} 条待投递` : "-"
      } |`
    })
    .join("\n")
  return `| task_id | 描述 | 状态 | 模型 | 工具调用 | 排队指令 |\n|---|---|---|---|---|---|\n${rows}`
}

function formatTaskOutput(manager: BackgroundManager, taskID: string, fullSession: boolean, serverUrl: string): string {
  const task = manager.getTask(taskID)
  if (!task) return `任务不存在: ${taskID}`
  const lines = [
    `任务 \`${taskID}\`: ${task.description}`,
    `状态: ${task.status}`,
  ]
  if (task.error) lines.push(`错误: ${task.error}`)
  if (task.model) lines.push(`模型: ${task.model.providerID}/${task.model.modelID}${task.retries > 0 ? ` (重试 ${task.retries} 次)` : ""}`)
  if (task.resultText) lines.push(`\n结果:\n${task.resultText.slice(0, 2000)}`)
  if (fullSession && task.sessionId) {
    lines.push(`\n完整会话: opencode attach ${serverUrl} --session ${task.sessionId}`)
    if (process.env.OPENCODE_SERVER_PASSWORD) {
      lines.push("（服务端已启用密码认证，attach 前需设置 OPENCODE_SERVER_PASSWORD 环境变量）")
    }
  }
  return lines.join("\n")
}

// Tasks are owned by the session that spawned them: a /bg or /split command
// typed in another session (e.g. a child pane) must not read or cancel them.
function checkTaskOwnership(
  manager: BackgroundManager,
  sessionID: string,
  taskID: string,
): { ok: true; task: BgTask } | { ok: false; error: string } {
  const task = manager.getTask(taskID)
  if (!task) return { ok: false, error: `任务不存在: ${taskID}` }
  if (task.parentSessionId !== sessionID) {
    return { ok: false, error: `无权操作其他会话的任务: ${taskID}` }
  }
  return { ok: true, task }
}

// Immediate feedback for subcommands that await network work in this hook
// (cancel → abort, send → resume). The command's output only lands after the
// hook returns, so without this the TUI shows nothing for the whole wait.
// Best-effort, same pattern as the manager's toasts.
function showToast(client: PrismClient, message: string): void {
  const toast = client.tui.showToast?.({
    body: { title: "Prism", message, variant: "info", duration: 4000 },
  })
  if (toast) void toast.catch(() => {})
}

// Deterministic subcommands run natively in the hook (status/output/cancel);
// everything else — /bg and /split task descriptions — falls through to the
// command template, where the main model calls bg_spawn / split_task with
// full streaming feedback. No LLM work ever runs inside this hook: it would
// block the TUI for the whole round.
export function createCommandExecuteBeforeHook(args: {
  manager: BackgroundManager
  serverUrl: string
  client: PrismClient
}) {
  return async (input: CommandInput, output: CommandOutput): Promise<void> => {
    const argumentsText = input.arguments.trim()

    if (input.command === "bg") {
      if (argumentsText === "status" || argumentsText === "list") {
        pushText(output, formatTaskTable(args.manager, input.sessionID))
        return
      }
      const outputMatch = argumentsText.match(/^(?:output|get)\s+(\S+)(\s+--full)?$/)
      if (outputMatch) {
        const taskID = outputMatch[1]!
        const owned = checkTaskOwnership(args.manager, input.sessionID, taskID)
        if (!owned.ok) {
          pushText(output, owned.error)
          return
        }
        pushText(output, formatTaskOutput(args.manager, taskID, outputMatch[2] !== undefined, args.serverUrl))
        return
      }
      const cancelMatch = argumentsText.match(/^(?:cancel)\s+(\S+)$/)
      if (cancelMatch) {
        const taskID = cancelMatch[1]!
        const owned = checkTaskOwnership(args.manager, input.sessionID, taskID)
        if (!owned.ok) {
          pushText(output, owned.error)
          return
        }
        showToast(args.client, `正在取消任务 \`${taskID}\`…`)
        const cancelled = await args.manager.cancelTask(taskID, { source: "/bg cancel" })
        pushText(output, cancelled ? `已取消任务 \`${taskID}\`` : `取消失败: 任务不存在或已结束 (${taskID})`)
        return
      }
      if (argumentsText === "cancel") {
        showToast(args.client, "正在取消当前会话的全部后台任务…")
        await args.manager.cancelAllByParentSession(input.sessionID, "/bg cancel")
        pushText(output, "已取消当前会话的全部后台任务")
        return
      }
      // resume|send <task_id> <追问/补充指令>: continue a finished task's
      // child session in place, or queue a steering message for a running
      // one (delivered at its current round's end, never interrupting it).
      const resumeMatch = argumentsText.match(/^(?:resume|send)\s+(\S+)\s+([\s\S]+)$/)
      if (resumeMatch) {
        const taskID = resumeMatch[1]!
        const owned = checkTaskOwnership(args.manager, input.sessionID, taskID)
        if (!owned.ok) {
          pushText(output, owned.error)
          return
        }
        try {
          // send() queues instantly for running/pending tasks, but a terminal
          // task resumes — which can wait up to 15s on a saturated group.
          if (owned.task.status !== "running" && owned.task.status !== "pending") {
            showToast(args.client, `正在恢复任务 \`${taskID}\`（如并发槽紧张需等待数秒）…`)
          }
          const result = await args.manager.send(taskID, resumeMatch[2]!)
          if (result.queued) {
            pushText(
              output,
              `补充指令已排队，将在任务 \`${taskID}\` 当前回合结束后投递（不打断执行，队列长度 ${result.queueLength}）。完成后会收到通知`,
            )
          } else {
            pushText(output, `任务 \`${taskID}\` 已恢复运行（追问已发送到其子会话），结束后会收到通知`)
          }
        } catch (error) {
          pushText(output, `发送失败: ${error instanceof Error ? error.message : String(error)}`)
        }
        return
      }
      return
    }

    if (input.command === "split") {
      if (argumentsText === "status" || argumentsText === "list") {
        pushText(output, formatTaskTable(args.manager, input.sessionID))
        return
      }
      const outputMatch = argumentsText.match(/^(?:output|get)\s+(\S+)$/)
      if (outputMatch) {
        const taskID = outputMatch[1]!
        const owned = checkTaskOwnership(args.manager, input.sessionID, taskID)
        if (!owned.ok) {
          pushText(output, owned.error)
          return
        }
        pushText(output, formatTaskOutput(args.manager, taskID, false, args.serverUrl))
        return
      }
      const cancelMatch = argumentsText.match(/^(?:cancel)\s+(\S+)$/)
      if (cancelMatch) {
        const taskID = cancelMatch[1]!
        const owned = checkTaskOwnership(args.manager, input.sessionID, taskID)
        if (!owned.ok) {
          pushText(output, owned.error)
          return
        }
        showToast(args.client, `正在取消任务 \`${taskID}\`…`)
        const cancelled = await args.manager.cancelTask(taskID, { source: "/split cancel" })
        pushText(output, cancelled ? `已取消任务 \`${taskID}\`` : "取消失败: 任务不存在或已结束")
        return
      }
      if (argumentsText === "cancel") {
        showToast(args.client, "正在取消当前会话的全部后台任务…")
        await args.manager.cancelAllByParentSession(input.sessionID, "/split cancel")
        pushText(output, "已取消当前会话的全部后台任务")
        return
      }
    }
  }
}
