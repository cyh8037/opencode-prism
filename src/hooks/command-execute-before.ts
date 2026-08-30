import { BG_SESSION_NAV_HINT, MAX_IMAGES_PER_BATCH, MAX_SUBTASKS } from "../config/constants"
import { log } from "../shared/log"
import type { BgTask } from "../core/background/types"
import type { BackgroundManager } from "../core/background/manager"
import type { PromptGate } from "../core/prompt-gate"
import { renderBgDashboard, sanitizeCell, sanitizeTruncate } from "../core/background/visualizer"
import { renderRunDetails, renderSplitRuns } from "../core/split/visualizer"
import type { SplitRunRegistry } from "../core/split/registry"
import type { SplitService } from "../core/split/service"
import type { PrismClient } from "../core/client-types"
import { errorInfoFromObject } from "../shared/api-result"
import { sanitizeSystemReminder } from "../shared/sanitize"
import { extractImageParts } from "../core/vision/detector"
import { navigationHint } from "../commands/templates"

type CommandInput = { command: string; sessionID: string; arguments: string }
type CommandOutput = { parts: Array<{ type: string; text?: string; [key: string]: unknown }> }

function pushText(output: CommandOutput, text: string): void {
  output.parts.push({ type: "text", text, synthetic: true })
}

// 看板已是 markdown 管道表格(方案 a):web 端 GFM 解析器渲染为 HTML 表格,
// TUI 端按等宽文本显示——**不能再包围栏**(围栏会把表格降级成代码块,
// web 端代码块字体 CJK≈1.67×ASCII,含中文表格错位,2026-08-29 像素级实测)。
// fence 仅保留给纯分层缩进文本(dry-run 计划/run 明细):web 端未围栏的
// 缩进会被 markdown 折叠,围栏保形;分层文本无列对齐,不受 CJK 比例影响。
// 围栏体是 LLM 输出(plan title/description):①过 sanitizeSystemReminder
// 封闭 </system-reminder> 逃逸(外层注入模板的既有防线,渲染器逐 cell 清洗
// 覆盖不到 fence 的调用点);②围栏标记按内容里最长的反引号串加长——
// CommonMark 规则,title 含 ``` 时 3 反引号围栏会被击穿。
function fence(text: string): string {
  const escaped = sanitizeSystemReminder(text)
  const longestRun = text.match(/`+/g)?.reduce((max, run) => Math.max(max, run.length), 0) ?? 0
  const marker = "`".repeat(Math.max(3, longestRun + 1))
  return marker + "text\n" + escaped + "\n" + marker
}

// 面向人类用户的中文子会话实时查看指引（/bg 命令原生回执使用）。
// 与面向模型的英文 navigationHint 解耦，保持中文回执的纯粹性与一致性。
const navHint = (tuiNavigation: boolean): string =>
  tuiNavigation
    ? "进度可通过快捷键 Ctrl+X + ↓ 查看子会话实时输出（←/→ 切换，↑ 返回），或输入 /bg status 查询。"
    : "进度可通过 /bg status 查询。"

function formatTaskOutput(manager: BackgroundManager, taskID: string, fullSession: boolean, serverUrl: string): string {
  const task = manager.getTask(taskID)
  if (!task) return `任务不存在: ${taskID}`
  const lines = [
    `任务 \`${taskID}\`: ${task.description}`,
    `状态: ${task.status}`,
  ]
  // error/resultText 来自 provider 与子会话 LLM（不可信文本），进 TUI 前走
  // 与看板相同的清洗管线（模板逃逸/ANSI/换行压平/控制字符剥离 + 截断）。
  if (task.error) lines.push(`错误: ${sanitizeCell(task.error)}`)
  if (task.model) lines.push(`模型: ${task.model.providerID}/${task.model.modelID}${task.retries > 0 ? ` (重试 ${task.retries} 次)` : ""}`)
  if (task.resultText) lines.push(`\n结果:\n${sanitizeTruncate(task.resultText, 2000)}`)
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
// 任务描述形式同样原生执行（0.5.0）:启动逻辑收进插件代码，模型回合只剩
// "转达注入结果"——不再由模型决定是否/如何调用 bg_spawn / split_task。
// 唯一例外是 /bg --parallel N：任务语义拆分需要 LLM，hook 注入【并行启动】
// 指令 part，交由模板回合中的模型并行调用 bg_spawn。这里绝不 await 任何
// LLM 轮询（秒级 I/O 与既有 cancel/send 先例同级）。
export function createCommandExecuteBeforeHook(args: {
  manager: BackgroundManager
  serverUrl: string
  client: PrismClient
  registry: SplitRunRegistry
  splitService: SplitService
  gate: PromptGate
  visionEnabled: boolean
  tuiNavigation: boolean
}) {
  return async (input: CommandInput, output: CommandOutput): Promise<void> => {
    const argumentsText = input.arguments.trim()

    // Prism 子会话（bg 任务/视觉任务）里拒绝 /bg、/split：任务以子会话为
    // parent 启动后，子会话完成时会被 abort，孙任务随之失去管理者（
    // cancelAllByParentSession 只在 session.deleted 触发）。工具面已在
    // childToolFilters 封死，这里是命令面的同款防线。
    if ((input.command === "bg" || input.command === "split") && args.manager.isChildSession(input.sessionID)) {
      pushText(
        output,
        `Prism 后台子会话内不能执行 /${input.command}：这里是后台子会话，可能随任务结束被回收。请回到主会话使用 /${input.command}。`,
      )
      return
    }

    if (input.command === "bg") {
      // /bg status bg_xxx:单个任务的表格视图(与 /split status sp_xxx 对称)。
      // 无论任务是否已结束都以表格展示当前状态(foldCompleted: false),
      // 不依赖状态更新事件。看板是 markdown 管道表格,不包围栏(见 fence 注释)。
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
          renderBgDashboard([owned.task], args.manager.getConcurrencySnapshot(), {
            foldCompleted: false,
            tuiNavigation: args.tuiNavigation,
          }),
        )
        return
      }
      if (argumentsText === "status" || argumentsText === "list" || argumentsText === "status --all" || argumentsText === "list --all") {
        // --all 展开已结束任务(默认折叠为摘要行)
        const showAll = argumentsText.includes("--all")
        pushText(
          output,
          renderBgDashboard(args.manager.getTasksByParentSession(input.sessionID), args.manager.getConcurrencySnapshot(), {
            foldCompleted: !showAll,
            tuiNavigation: args.tuiNavigation,
          }),
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
      // (?!--) 排除旗标形态: "cancel --all" 会被 --all 当作 task id 命中,
      // 必须落到下方的前缀拦截给用法提示,而不是报"任务不存在: --all"。
      const cancelMatch = argumentsText.match(/^(?:cancel)\s+(?!--)(\S+)$/)
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
      if (argumentsText === "") {
        pushText(output, `用法: /bg <任务描述> [--parallel <2-${MAX_SUBTASKS}>] | status [--all] | status <task_id> | output <task_id> | cancel [task_id] | resume|send <task_id> <指令>`)
        return
      }
      // --parallel N:任务语义拆分需要 LLM——不原生启动，注入【并行启动】
      // 指令，由模板回合中的模型并行调用 bg_spawn（模板不放 $ARGUMENTS，
      // 描述只经这个 part 进入模型上下文）。N 封顶 MAX_SUBTASKS：模型一次
      // 回合内无约束地连发 bg_spawn 没有兜底。
      const parallelMatch = argumentsText.match(/--parallel\s+(\d+)\b/)
      if (parallelMatch) {
        const count = Number(parallelMatch[1])
        const parallelTask = argumentsText.replace(/--parallel\s+\d+\b/, "").trim()
        if (!parallelTask || !Number.isInteger(count) || count < 2 || count > MAX_SUBTASKS) {
          pushText(output, `用法: /bg <任务描述> --parallel <2-${MAX_SUBTASKS}>（n 为相互独立的子任务个数）`)
          return
        }
        pushText(
          output,
          `已交给模型拆分为 ${count} 个并发子任务：${parallelTask}\n\n`
            + `【并行启动 N=${count}】请把上述任务拆成 ${count} 个相互独立的子任务，在同一个回合内并行调用 ${count} 次 bg_spawn 工具（绝不串行等待），启动后告知用户每个子任务的 id 与用途。`,
        )
        return
      }
      // 任务描述形式：原生直接启动。await 的是秒级入队 I/O（与下方
      // cancel/send 的 await 先例同级），不含任何 LLM 轮询。
      showToast(args.client, "正在启动后台任务…")
      try {
        // 图片跟随：命令消息自带的图片附件直接从 parts 提取（按
        // vision.enabled 门控——视觉关闭时子会话没有 vision_look，附加
        // 图片只会制造读不了的死附件）。上一条消息的图片是旧上下文，
        // 不跟随（与 collectLatestUserImages 的"无图即止"边界一致）。
        // ⚠️ parts 必须自带任务文本 part：startTask 的语义是"parts 存在
        // 则完全取代 input.prompt"——只传图片会把用户输入的任务指令整个
        // 丢掉，子会话只收到一张无指令的图（bg_spawn 工具路径同一组合）。
        const followImages = args.visionEnabled
          ? extractImageParts(output.parts).slice(0, MAX_IMAGES_PER_BATCH)
          : []
        let parts: Array<Record<string, unknown>> | undefined
        if (followImages.length > 0) {
          parts = [
            { type: "text", text: argumentsText, synthetic: true },
            ...followImages.map((image) => ({ type: "file", mime: image.mime, url: image.url })),
          ]
        }
        const task = await args.manager.launch({
          description: sanitizeTruncate(argumentsText, 80),
          prompt: argumentsText,
          parts,
          parentSessionId: input.sessionID,
        })
        const model = task.model ? ` 模型 ${task.model.providerID}/${task.model.modelID}` : ""
        pushText(
          output,
          `后台任务已入队: \`${task.id}\` (${task.description})${model}\n`
            + `用 /bg output ${task.id} 查询结果、/bg cancel ${task.id} 取消（也可让模型调用 bg_output / bg_cancel）。\n`
            + navHint(args.tuiNavigation),
        )
      } catch (error) {
        // launch 抛出的都是已重试后的最终失败（内部完成分类），这里只需
        // 提取信息并给出可行动引导，不重复判定可重试性。
        const info = error instanceof Error ? errorInfoFromObject(error) : {}
        const detail = info.message ?? String(error)
        const hint = /shutting down/i.test(detail) ? "（插件正在关闭，无法启动新任务）" : "，可稍后重试或检查模型配置"
        pushText(output, `后台任务启动失败: ${detail}${hint}`)
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
        pushText(output, fence(renderRunDetails(run)))
        return
      }
      if (argumentsText === "status" || argumentsText === "list" || argumentsText === "status --all" || argumentsText === "list --all") {
        // 拆分看板 + 独立任务合并视图(R2):run 的任务在 DAG 区块内展示,
        // 不属于任何 run 的后台任务以 INDEPENDENT TASKS 区块保留可见性。
        // 默认折叠全部终态的 run(--all 展开)。
        // 混合内容不整体围栏:INDEPENDENT TASKS 区块是 markdown 管道表格,
        // 围栏会使其在 web 端降级为代码块(错位);run 区块的缩进在 web 端
        // 折叠属可接受的视觉损失,行前缀([s1]/Wave N:)保留结构语义。
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
        // abort 是秒级网络 I/O 且各任务相互独立：并行发起（串行最坏
        // N×ABORT_TIMEOUT_MS 会把命令回合拖到几十秒）。skipNotification:
        // 逐任务 cancel 的 CANCELLED toast 会在整批取消时刷屏；汇总反馈由
        // 下方单条 toast + 命令回执 + split 聚合报告承担。
        const cancellable = Array.from(run.tasksByPlanID.values()).filter(
          (task) => task.status !== "completed" && task.status !== "error" && task.status !== "cancelled",
        )
        const results = await Promise.all(
          cancellable.map((task) => args.manager.cancelTask(task.id, { source: "/split cancel run", skipNotification: true })),
        )
        const cancelled = results.filter((ok) => ok).length
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
      // (?!--) 同 /bg 侧: 旗标形态落到前缀拦截,不报"任务不存在"。
      const cancelMatch = argumentsText.match(/^(?:cancel)\s+(?!--)(\S+)$/)
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
        // 与 /bg 裸 cancel 对称：取消当前会话的全部后台任务（含拆分与独立任务）。
        showToast(args.client, "正在取消当前会话的全部后台任务…")
        await args.manager.cancelAllByParentSession(input.sessionID, "/split cancel")
        pushText(output, "已取消当前会话的全部后台任务")
        return
      }
      // cancel 前缀命中但变体未识别（如 "cancel --all"、"cancel x y"）：拦下给
      // 用法提示，防止穿透到任务描述语义把 "cancel" 当成任务 spawn 出去。
      if (/^(?:cancel)(?:\s|$)/.test(argumentsText)) {
        pushText(output, "用法: /split cancel <sp_run_id|task_id>（不带参数取消当前会话全部任务）")
        return
      }
      if (argumentsText === "") {
        pushText(output, "用法: /split <任务描述> [--dry-run] [--sequential] [--max <n>] | status [--all] | status <run_id> | output <task_id> | cancel [<sp_run_id|task_id>]")
        return
      }
      // 任务描述形式：原生异步执行。意图判定与规划器都是一次性子会话，
      // 严禁在 hook 内 await LLM 轮询（阻塞 TUI 整轮）——立即回执"已启动"，
      // 产物（启动确认/dry-run 计划/意图判定结论/失败原因）经 PromptGate
      // 回注主会话（注入的唯一入口，串行/去重由 gate 保证）。
      const dryRun = /--dry-run\b/.test(argumentsText)
      const sequential = /--sequential\b/.test(argumentsText)
      const maxMatch = argumentsText.match(/--max\s+(\d+)\b/)
      const rawMax = maxMatch ? Number(maxMatch[1]) : undefined
      const maxSubtasks = rawMax !== undefined && Number.isInteger(rawMax) ? rawMax : undefined
      const task = argumentsText.replace(/\s*--(?:dry-run|sequential|max\s+\d+)\b/g, "").trim()
      if (!task) {
        pushText(output, "用法: /split <任务描述> [--dry-run] [--sequential] [--max <n>]")
        return
      }
      pushText(
        output,
        dryRun
          ? "正在分析任务并生成拆分预览（通常需十几秒）…\n拆分计划生成后将自动在此展示（不执行实际任务）。"
          : "正在分析任务并规划拆分方案（通常需十几秒）…\n方案确认后将自动在此通知并启动子任务，进度可通过 /split status 查看。",
      )
      void args.splitService
        .split({ sessionID: input.sessionID, task, dryRun, sequential, maxSubtasks })
        .then(async (outcome) => {
          // dry-run 计划是分层缩进文本，围栏保形；其余产物为叙述文本。
          const body = outcome.kind === "dry-run" ? fence(outcome.message) : outcome.message
          const result = await args.gate.dispatch({
            sessionID: input.sessionID,
            source: "split-native-outcome",
            text: [
              "<system-reminder>",
              "[PRISM SPLIT]",
              "",
              "请把以下拆分执行结果原样转达给用户（不要改写为列表、不要添加 emoji 或任何符号）：",
              "",
              body,
              "</system-reminder>",
            ].join("\n"),
          })
          if (result.status === "failed") {
            log("[prism] split: outcome injection failed", { sessionID: input.sessionID, error: result.error })
          }
        })
        .catch((error) => {
          // fire-and-forget 链在 hook 之外：异常必须就地吞掉（不变量 #2），
          // 否则以 unhandled rejection 泄漏进宿主进程 stderr。
          log("[prism] split: native execution failed", { error })
        })
      return
    }
  }
}
