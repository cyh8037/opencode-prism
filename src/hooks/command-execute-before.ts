import type { BackgroundManager } from "../core/background/manager"
import type { BgTask } from "../core/background/types"
import type { PrismClient } from "../core/client-types"
import { renderBgDashboard } from "../core/background/visualizer"
import { renderRunDetails, renderSplitRuns } from "../core/split/visualizer"
import type { SplitRunRegistry } from "../core/split/registry"

type CommandInput = { command: string; sessionID: string; arguments: string }
type CommandOutput = { parts: Array<{ type: string; text?: string; [key: string]: unknown }> }

function pushText(output: CommandOutput, text: string): void {
  output.parts.push({ type: "text", text, synthetic: true })
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
  registry: SplitRunRegistry
}) {
  return async (input: CommandInput, output: CommandOutput): Promise<void> => {
    const argumentsText = input.arguments.trim()

    if (input.command === "bg") {
      // /bg status bg_xxx:单个任务的表格视图(与 /split status sp_xxx 对称)。
      // 无论任务是否已结束都以表格展示当前状态(foldCompleted: false),
      // 不依赖状态更新事件。
      const taskStatusMatch = argumentsText.match(/^(?:status|list)\s+(bg_\S+)$/)
      if (taskStatusMatch) {
        const taskID = taskStatusMatch[1]!
        const owned = checkTaskOwnership(args.manager, input.sessionID, taskID)
        if (!owned.ok) {
          pushText(output, owned.error)
          return
        }
        pushText(
          output,
          renderBgDashboard([owned.task], args.manager.getConcurrencySnapshot(), { foldCompleted: false }),
        )
        return
      }
      if (argumentsText === "status" || argumentsText === "list" || argumentsText === "status --all" || argumentsText === "list --all") {
        // --all 展开已结束任务(默认折叠为摘要行)
        const showAll = argumentsText.includes("--all")
        pushText(
          output,
          renderBgDashboard(
            args.manager.getTasksByParentSession(input.sessionID),
            args.manager.getConcurrencySnapshot(),
            { foldCompleted: !showAll },
          ),
        )
        return
      }
      // status/list 前缀命中但变体未识别(如 "status --al"、"status xxx --all")
      // 必须拦下给用法提示:否则会穿透到底部"任务描述"语义,把用户敲错的
      // 状态查询当成任务 spawn 出去。
      if (/^(?:status|list)(?:\s|$)/.test(argumentsText)) {
        pushText(output, "用法: /bg status [--all] 或 /bg status <task_id>(bg_ 前缀,单个任务表格视图)")
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
      // /split status sp_xxx:展开单个 run 的完整 DAG 明细(折叠视图的展开
      // 入口)。status 命名空间三个变体:status(折叠)/ status --all(全展开)/
      // status sp_xxx(指定 run)——run 的明细是看板,归 status 语义。
      const runStatusMatch = argumentsText.match(/^(?:status|list)\s+(sp_\S+)$/)
      if (runStatusMatch) {
        const runID = runStatusMatch[1]!
        const run = args.registry.getRun(runID)
        if (!run) {
          pushText(output, `拆分任务不存在或已过期: ${runID}`)
          return
        }
        if (run.sessionID !== input.sessionID) {
          pushText(output, `无权查看其他会话的拆分任务: ${runID}`)
          return
        }
        pushText(output, renderRunDetails(run))
        return
      }
      if (argumentsText === "status" || argumentsText === "list" || argumentsText === "status --all" || argumentsText === "list --all") {
        // 拆分看板 + 独立任务合并视图(R2):run 的任务在 DAG 区块内展示,
        // 不属于任何 run 的后台任务以 INDEPENDENT TASKS 区块保留可见性。
        // 默认折叠全部终态的 run(--all 展开)。
        const showAll = argumentsText.includes("--all")
        const runs = args.registry.getRunsByParentSession(input.sessionID)
        const tasks = args.manager.getTasksByParentSession(input.sessionID)
        pushText(output, renderSplitRuns(runs, tasks, { foldCompleted: !showAll }))
        return
      }
      // status/list 前缀命中但变体未识别:拦下给用法提示,防止穿透到任务
      // 描述语义(与 /bg 同理由)。
      if (/^(?:status|list)(?:\s|$)/.test(argumentsText)) {
        pushText(output, "用法: /split status [--all] 或 /split status <run_id>(sp_ 前缀,单个 run 的 DAG 明细)")
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
      // /split cancel sp_xxx:按整个 run 取消(遍历该 run 的全部子任务,
      // 已结束的跳过;未结束的级联 SKIPPED 由调度器处理)。
      const runCancelMatch = argumentsText.match(/^cancel\s+(sp_\S+)$/)
      if (runCancelMatch) {
        const runID = runCancelMatch[1]!
        const run = args.registry.getRun(runID)
        if (!run) {
          pushText(output, `拆分任务不存在或已过期: ${runID}`)
          return
        }
        if (run.sessionID !== input.sessionID) {
          pushText(output, `无权取消其他会话的拆分任务: ${runID}`)
          return
        }
        showToast(args.client, `正在取消拆分任务 \`${runID}\` 的全部子任务…`)
        let cancelled = 0
        for (const task of run.tasksByPlanID.values()) {
          // 终态任务跳过:manager.cancelTask 对它们返回 false,没必要发起调用
          if (task.status === "completed" || task.status === "error" || task.status === "cancelled") continue
          // skipNotification:逐任务 cancel 的 CANCELLED toast 会在整批取消时
          // 刷屏;汇总反馈由下方单条 toast + 命令回执 + split 聚合报告承担
          // (与 cancelAllByParentSession 的既有语义一致)。
          const ok = await args.manager.cancelTask(task.id, { source: "/split cancel run", skipNotification: true })
          if (ok) cancelled++
        }
        if (cancelled > 0) {
          showToast(args.client, `已取消拆分任务 \`${runID}\` 的 ${cancelled} 个子任务`)
        }
        pushText(
          output,
          cancelled > 0
            ? `已取消拆分任务 \`${runID}\` 的 ${cancelled} 个子任务（其余已完成）`
            : `拆分任务 \`${runID}\` 的子任务均已结束，无需取消`,
        )
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
