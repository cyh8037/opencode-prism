import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import { BG_SESSION_NAV_HINT, BG_WAIT_DEFAULT_MS, BG_WAIT_MAX_MS, MAX_IMAGES_PER_BATCH } from "../config/constants"
import type { BackgroundManager } from "../core/background/manager"
import type { PrismClient } from "../core/client-types"
import { extractImageParts, type ImageAttachment } from "../core/vision/detector"
import { errorInfoFromResult } from "../shared/api-result"
import { log } from "../shared/log"

// 从会话消息历史提取"最后一条用户消息"的图片附件(纯函数,可单测)。
// 场景:/bg 分析这张图片——用户消息带 file 图片 part(斜杠命令的附件
// 就是普通消息 part),bg_spawn 的子会话 prompt 需要带上这些图片才能让
// 子任务 vision_look 读图。
//
// 严格只看最后一条用户消息、无图即止:更早消息的图片是旧上下文,跟随
// 它们会把无关附件注入不相干的子任务(autoTrigger 下模型可随时自主
// bg_spawn,误注入面更大)。基于早前消息的图片开新后台任务,由 bg 命令
// 模板引导模型把图片路径显式写进 prompt。
export function collectLatestUserImages(messages: unknown, max: number): ImageAttachment[] {
  if (!Array.isArray(messages)) return []
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as { info?: { role?: string }; parts?: unknown } | undefined
    if (message?.info?.role !== "user") continue
    return extractImageParts(message.parts).slice(0, max)
  }
  return []
}

// LLM-facing tools for the background engine. Commands (/bg, /split) are the
// primary UX; these tools let the model drive the same engine mid-task.
export function createBgTools(
  manager: BackgroundManager,
  opts: { visionEnabled?: boolean; autoTrigger?: boolean; client?: PrismClient; directory?: string } = {},
): Record<string, ToolDefinition> {
  // With the vision feature disabled the child sessions also lose vision_look
  // from their tool lists — the read-image guidance must not point at a tool
  // that would fail with "not found".
  const visionEnabled = opts.visionEnabled ?? true
  const visionGuidance = visionEnabled
    ? "涉及图片时：当前消息中的图片附件会被自动传给子会话（子任务用 vision_look 读图）；图片是本地文件、或任务基于早前消息的图片时，请在 prompt 中包含该图片的本地路径/URL，并让子任务使用 vision_look 工具读图。"
    : ""
  // 策略 A(background.autoTrigger,插件加载时读取):模型可在描述列出的
  // 场景下主动调用 bg_spawn,不必等用户显式要求。边界明确写进描述——
  // 交互性任务/与主会话冲突的工作/破坏性操作不在列。
  const autoTriggerGuidance =
    opts.autoTrigger ?? true
      ? "\n【自主触发准则】以下场景可主动调用（无需用户显式要求），启动后立即告知用户已转入后台：\n1. 耗时的大范围只读调研、代码检索、日志分析、文档查阅；\n2. 独立于当前编辑范围的编译、全量测试、性能压测；\n3. 多个相互独立的子模块任务（同一回合内并行发起多个 bg_spawn）。\n【不适用场景】需要用户实时确认的多轮交互；与当前主会话编辑同一批文件；涉及删除数据、生产环境变更等破坏性操作。无法确定是否适用时，不调用。"
      : ""
  return {
    bg_spawn: tool({
      description:
        "启动一个后台子任务（独立会话并行执行）。适合探索、研究、并行实现等可以异步进行的工作。任务结束后父会话会收到汇总通知。" +
        autoTriggerGuidance +
        visionGuidance,
      args: {
        description: tool.schema.string().describe("任务简述，用于通知和状态展示"),
        prompt: tool.schema.string().describe("子任务的完整指令"),
        agent: tool.schema.string().optional().describe("可选的 OpenCode agent 名"),
      },
      async execute(args: { description: string; prompt: string; agent?: string }, ctx) {
        try {
          // 图片跟随(/bg 分析这张图片):把父会话最后一条用户消息的图片
          // 附件注入子会话 prompt——子会话保留 vision_look,可对自有
          // 图片读图。按 vision.enabled 门控:视觉完全关闭(不变量 #6)时
          // 子会话没有 vision_look,附加图片只会制造读不了的死附件。
          // 查询失败/无图时静默跳过(普通任务不受影响)。
          let parts: Array<Record<string, unknown>> | undefined
          if (args.prompt) {
            parts = [{ type: "text", text: args.prompt, synthetic: true }]
          }
          if (opts.client && visionEnabled) {
            try {
              // 不变量 #7:4xx/5xx 解析为 { error } 而不是 reject,必须用
              // errorInfoFromResult 判错;降级(跳过传图)必须留日志。
              const response = await opts.client.session.messages({
                path: { id: ctx.sessionID },
                query: opts.directory ? { directory: opts.directory } : undefined,
              })
              const failure = errorInfoFromResult(response)
              if (failure) {
                log("[prism] bg_spawn: image follow skipped (messages query failed)", {
                  sessionID: ctx.sessionID,
                  error: failure.message,
                })
              } else {
                const images = collectLatestUserImages(response.data, MAX_IMAGES_PER_BATCH)
                if (images.length > 0) {
                  parts = [
                    ...(parts ?? []),
                    ...images.map((image) => ({ type: "file", mime: image.mime, url: image.url })),
                  ]
                }
              }
            } catch (error) {
              log("[prism] bg_spawn: image follow failed (skipped)", { sessionID: ctx.sessionID, error })
            }
          }
          const task = await manager.launch({
            description: args.description,
            prompt: args.prompt,
            parts,
            parentSessionId: ctx.sessionID,
            agent: args.agent,
          })
          const model = task.model ? `模型 ${task.model.providerID}/${task.model.modelID}` : ""
          return (
            `后台任务已入队: \`${task.id}\` (${task.description}) ${model}\n`
            + `用 bg_output("${task.id}") 查询结果，bg_cancel("${task.id}") 取消。\n`
            // 键位为 TUI 默认值（用户可覆盖），措辞用"启动后"——返回时任务
            // 实为 queued，尚未开始产生输出。
            + `启动后可${BG_SESSION_NAV_HINT}。`
          )
        } catch (error) {
          return `后台任务启动失败: ${error instanceof Error ? error.message : String(error)}`
        }
      },
    }),

    bg_output: tool({
      description: "查询后台任务的状态或结果。",
      args: {
        taskId: tool.schema.string().describe("任务 id（bg_ 前缀）"),
      },
      async execute(args: { taskId: string }, ctx: { sessionID: string }) {
        const task = manager.getTask(args.taskId)
        if (!task) return `任务不存在或已过期: ${args.taskId}`
        // Tasks are owned by the session that spawned them; another session
        // (e.g. a child subagent) must not read a sibling's or the parent's
        // task results.
        if (task.parentSessionId !== ctx.sessionID) {
          return `无权访问其他会话的任务: ${args.taskId}`
        }
        const lines = [`任务 \`${task.id}\`: ${task.description}`, `状态: ${task.status}`]
        if (task.error) lines.push(`错误: ${task.error}`)
        if (task.status === "running" || task.status === "pending") {
          const toolCalls = task.progress?.toolCalls ?? 0
          lines.push(`进度: ${toolCalls} 次工具调用${task.progress?.lastTool ? `，最近: ${task.progress.lastTool}` : ""}`)
          const queued = task.steeringQueue?.length ?? 0
          if (queued > 0) lines.push(`排队中的补充指令: ${queued} 条（将在当前回合结束后投递）`)
        }
        if (task.resultText) lines.push(`\n结果:\n${task.resultText.slice(0, 2000)}`)
        return lines.join("\n")
      },
    }),

    bg_cancel: tool({
      description: "取消一个后台任务（abort 其子会话并释放并发槽）。",
      args: {
        taskId: tool.schema.string().describe("任务 id（bg_ 前缀）"),
      },
      async execute(args: { taskId: string }, ctx: { sessionID: string }) {
        const task = manager.getTask(args.taskId)
        if (task && task.parentSessionId !== ctx.sessionID) {
          return `无权取消其他会话的任务: ${args.taskId}`
        }
        const cancelled = await manager.cancelTask(args.taskId, { source: "bg_cancel" })
        return cancelled ? `已取消任务 \`${args.taskId}\`` : `取消失败: 任务不存在或已结束 (${args.taskId})`
      },
    }),

    bg_send: tool({
      description:
        "向后台任务发送补充指令（steering）。任务运行中：消息排队，在其当前回合结束的边界投递（不打断执行，子会话上下文完整保留）；任务已结束：在其子会话里继续追问（等同续跑）。适合任务执行期间补充新信息、纠正方向、追加约束。",
      args: {
        taskId: tool.schema.string().describe("任务 id（bg_ 前缀）"),
        message: tool.schema.string().describe("补充指令内容（新决定、纠正、追加要求等）"),
      },
      async execute(args: { taskId: string; message: string }, ctx: { sessionID: string }) {
        const task = manager.getTask(args.taskId)
        if (!task) return `任务不存在或已过期: ${args.taskId}`
        if (task.parentSessionId !== ctx.sessionID) {
          return `无权操作其他会话的任务: ${args.taskId}`
        }
        try {
          const result = await manager.send(args.taskId, args.message)
          if (result.queued) {
            return (
              `补充指令已排队，将在任务当前回合结束后投递: \`${args.taskId}\`（队列长度 ${result.queueLength}）。` +
              "任务继续运行，完成后会收到通知。"
            )
          }
          return `任务 \`${args.taskId}\` 已恢复运行（追问已发送到其子会话），结束后会收到通知`
        } catch (error) {
          return `发送失败: ${error instanceof Error ? error.message : String(error)}`
        }
      },
    }),

    bg_wait: tool({
      description:
        "等待后台任务结束（阻塞直到指定任务或当前会话全部未结束任务到达终态，或超时返回当前状态）。在需要后台结果才能继续时使用（如总结前等待并行任务完成），不要用它轮询单个任务的结果（bg_output 更合适）。",
      args: {
        taskIds: tool.schema
          .array(tool.schema.string())
          .optional()
          .describe("要等待的任务 id 列表；缺省 = 当前会话全部未结束任务；显式空数组 = 无事可等，立即返回"),
        timeoutMs: tool.schema
          .number()
          .optional()
          .describe(`最长等待毫秒数，默认 ${BG_WAIT_DEFAULT_MS}，上限 ${BG_WAIT_MAX_MS}`),
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
            unknown.length > 0 ? `不存在或已过期: ${unknown.join(", ")}` : "",
            foreign.length > 0 ? `无权等待其他会话的任务: ${foreign.join(", ")}` : "",
          ].filter(Boolean)
          return `没有需要等待的后台任务。${notes.length > 0 ? `（${notes.join("；")}）` : ""}`
        }

        const timeout = Math.min(Math.max(args.timeoutMs ?? BG_WAIT_DEFAULT_MS, 1_000), BG_WAIT_MAX_MS)
        const { tasks, timedOut } = await manager.waitForTasks(ids, timeout)

        const lines: string[] = []
        if (timedOut) lines.push(`等待超时（${timeout}ms），当前状态:`)
        else lines.push(`等待结束（${tasks.length} 个任务）:`)
        for (const task of tasks) {
          lines.push(`- \`${task.id}\` ${task.description}: ${task.status.toUpperCase()}`)
          if (task.error) lines.push(`  错误: ${task.error.slice(0, 120)}`)
          if (task.resultText) lines.push(`  结果: ${task.resultText.slice(0, 200)}`)
        }
        if (timedOut) lines.push("", "可再次调用 bg_wait 继续等待，或用 bg_output(task_id) 查看详情。")
        return lines.join("\n")
      },
    }),
  }
}
