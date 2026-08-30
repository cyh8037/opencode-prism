import { describe, expect, test } from "bun:test"
import { createCommandExecuteBeforeHook } from "../src/hooks/command-execute-before"
import type { BackgroundManager } from "../src/core/background/manager"
import type { BgTask } from "../src/core/background/types"
import { SplitRunRegistry } from "../src/core/split/registry"

// Command-layer routing for /bg subcommands. The manager interactions are
// stubbed — manager semantics (queueing, resume, ownership) are covered in
// background-manager.test.ts; what matters here is which subcommand maps to
// which manager call and what text the user sees.

type SendResult = { queued: boolean; queueLength: number }

type LaunchInput = { description: string; prompt: string; parentSessionId: string; parts?: Array<Record<string, unknown>> }
type SplitCall = { sessionID: string; task: string; dryRun?: boolean; sequential?: boolean; maxSubtasks?: number }
type DispatchCall = { sessionID: string; source: string; text: string }

function createHook(options: {
  tasks: BgTask[]
  sendResult?: SendResult | Error
  cancelled?: boolean
  registry?: SplitRunRegistry
  onCancelTask?: (taskID: string, options?: { skipNotification?: boolean }) => Promise<boolean>
  launchResult?: { id: string; description: string } | Error
  onLaunch?: (input: LaunchInput) => void
  splitOutcome?: { kind: string; message: string }
  visionEnabled?: boolean
  tuiNavigation?: boolean
  isChildSession?: boolean
}): {
  hook: ReturnType<typeof createCommandExecuteBeforeHook>
  toasts: string[]
  launches: LaunchInput[]
  splitCalls: SplitCall[]
  dispatches: DispatchCall[]
  cancelAllCalls: Array<{ parentSessionID: string; source: string }>
} {
  const launches: LaunchInput[] = []
  const cancelAllCalls: Array<{ parentSessionID: string; source: string }> = []
  const manager = {
    getTasksByParentSession: () => options.tasks,
    getTask: (id: string) => options.tasks.find((task) => task.id === id),
    isChildSession: () => options.isChildSession ?? false,
    cancelTask: async (taskID: string, cancelOptions?: { skipNotification?: boolean }) => {
      if (options.onCancelTask) return options.onCancelTask(taskID, cancelOptions)
      return options.cancelled ?? true
    },
    cancelAllByParentSession: async (parentSessionID: string, source: string) => {
      cancelAllCalls.push({ parentSessionID, source })
    },
    getConcurrencySnapshot: () => [],
    send: async () => {
      if (options.sendResult instanceof Error) throw options.sendResult
      if (!options.sendResult) throw new Error("send not expected")
      return { task: options.tasks[0]!, ...options.sendResult }
    },
    launch: async (input: LaunchInput) => {
      launches.push(input)
      options.onLaunch?.(input)
      if (options.launchResult instanceof Error) throw options.launchResult
      return {
        id: options.launchResult?.id ?? "bg_new",
        description: options.launchResult?.description ?? input.description,
        model: undefined,
      }
    },
  } as unknown as BackgroundManager
  const toasts: string[] = []
  const client = {
    tui: {
      showToast: async (params: { body: { message: string } }) => {
        toasts.push(params.body.message)
      },
    },
  } as never
  const splitCalls: SplitCall[] = []
  const dispatches: DispatchCall[] = []
  const hook = createCommandExecuteBeforeHook({
    manager,
    serverUrl: "http://localhost:4096",
    client,
    registry: options.registry ?? new SplitRunRegistry(),
    splitService: {
      split: async (request: SplitCall) => {
        splitCalls.push(request)
        return options.splitOutcome ?? { kind: "skipped-intent", message: "意图识别：无需拆分（测试）" }
      },
    } as never,
    gate: {
      dispatch: async (dispatchCall: DispatchCall) => {
        dispatches.push(dispatchCall)
        return { status: "dispatched" as const }
      },
    } as never,
    visionEnabled: options.visionEnabled ?? true,
    tuiNavigation: options.tuiNavigation ?? true,
  })
  return { hook, toasts, launches, splitCalls, dispatches, cancelAllCalls }
}

function makeTask(overrides: Partial<BgTask>): BgTask {
  return {
    id: "bg_1",
    parentSessionId: "session",
    description: "demo",
    prompt: "work",
    retries: 0,
    status: "running",
    queuedAt: new Date(),
    ...overrides,
  } as BgTask
}

async function run(hook: ReturnType<typeof createCommandExecuteBeforeHook>, command: string, args: string): Promise<string> {
  const output = { parts: [] as Array<{ type: string; text?: string; [key: string]: unknown }> }
  await hook({ command, sessionID: "session", arguments: args }, output)
  return output.parts.map((part) => part.text ?? "").join("\n")
}

describe("/bg command routing", () => {
  test("status with no tasks says so", async () => {
    const text = await run(createHook({ tasks: [] }).hook, "bg", "status")
    expect(text).toContain("当前会话没有后台任务")
  })

  test("status boards are markdown pipe tables without a fence (web GFM renders them as HTML tables)", async () => {
    const text = await run(
      createHook({ tasks: [makeTask({ id: "bg_9", description: "编译文档", status: "running" })] }).hook,
      "bg",
      "status",
    )
    // 方案 a:管道表格不包围栏(围栏会让 web 端表格降级为代码块、含中文列错位)
    expect(text).not.toContain("```text")
    expect(text).toContain("| ID")
    expect(text).toContain("| ---")
    expect(text).toContain("| bg_9")
    expect(text).toContain("编译文档")
    expect(text).toContain("RUNNING")
  })

  test("unrecognized status variants get a usage hint instead of falling through to task semantics", async () => {
    const { hook } = createHook({ tasks: [] })
    // 穿透会把敲错的状态查询当成任务描述 spawn 出去
    expect(await run(hook, "bg", "status --al")).toContain("用法: /bg status")
    expect(await run(hook, "bg", "status  --all")).toContain("用法: /bg status")
    expect(await run(hook, "split", "status --al")).toContain("用法: /split status")
  })

  test("send to a running task reports the queued message without a toast (instant)", async () => {
    const { hook, toasts } = createHook({
      tasks: [makeTask({ status: "running" })],
      sendResult: { queued: true, queueLength: 1 },
    })
    const text = await run(hook, "bg", "send bg_1 注意边界情况")
    expect(text).toContain("已排队")
    expect(text).toContain("bg_1")
    expect(toasts).toHaveLength(0)
  })

  test("send to a finished task reports the resumed session and toasts first (may wait on a slot)", async () => {
    const { hook, toasts } = createHook({
      tasks: [makeTask({ status: "completed" })],
      sendResult: { queued: false, queueLength: 0 },
    })
    const text = await run(hook, "bg", "send bg_1 展开第二步")
    expect(text).toContain("已恢复运行")
    expect(toasts.some((t) => t.includes("正在恢复"))).toBe(true)
  })

  test("send failure surfaces the error text", async () => {
    const text = await run(
      createHook({
        tasks: [makeTask({ status: "running" })],
        sendResult: new Error("child session gone"),
      }).hook,
      "bg",
      "send bg_1 追问",
    )
    expect(text).toContain("发送失败")
    expect(text).toContain("child session gone")
  })

  test("output for a task owned by another session is denied", async () => {
    const text = await run(createHook({ tasks: [makeTask({ parentSessionId: "other" })] }).hook, "bg", "output bg_1")
    expect(text).toContain("无权操作其他会话的任务")
  })

  test("cancel with an id cancels the owned task and toasts before the abort wait", async () => {
    const { hook, toasts } = createHook({ tasks: [makeTask({})], cancelled: true })
    const text = await run(hook, "bg", "cancel bg_1")
    expect(text).toContain("已取消任务")
    expect(text).toContain("bg_1")
    expect(toasts.some((t) => t.includes("正在取消"))).toBe(true)
  })

  test("cancel without an id retires the whole session with a toast", async () => {
    const { hook, toasts } = createHook({ tasks: [makeTask({})] })
    const text = await run(hook, "bg", "cancel")
    expect(text).toContain("已取消当前会话的全部后台任务")
    expect(toasts.some((t) => t.includes("正在取消"))).toBe(true)
  })

  test("/bg status bg_xxx shows the single task as a table even when finished", async () => {
    const done = makeTask({ id: "bg_done1", description: "已完成任务", status: "completed", startedAt: new Date(), completedAt: new Date() })
    const { hook } = createHook({ tasks: [done] })
    const text = await run(hook, "bg", "status bg_done1")
    expect(text).toContain("bg_done1")
    expect(text).toContain("已完成任务")
    expect(text).toContain("COMPLETED")
    // 已结束任务仍以表格行展示,不折叠为摘要;管道表格不包围栏
    expect(text).toContain("| bg_done1")
    expect(text).not.toContain("```text")
  })
})

describe("/bg native task launch", () => {
  test("a task description launches natively and returns a deterministic receipt", async () => {
    const { hook, launches, toasts } = createHook({
      tasks: [],
      launchResult: { id: "bg_n1", description: "demo" },
    })
    const text = await run(hook, "bg", "调研 opencode 插件生态")
    expect(launches).toHaveLength(1)
    expect(launches[0]!.prompt).toBe("调研 opencode 插件生态")
    expect(launches[0]!.parentSessionId).toBe("session")
    expect(launches[0]!.description.length).toBeLessThanOrEqual(80)
    expect(text).toContain("后台任务已入队: `bg_n1`")
    // 原生命令指引在前（用户可直接输入），工具名作为补充
    expect(text).toContain("/bg output bg_n1")
    expect(text).toContain("/bg cancel bg_n1")
    expect(text).toContain("bg_output")
    expect(text).toContain("Ctrl+X")
    expect(toasts.some((t) => t.includes("正在启动后台任务"))).toBe(true)
  })

  test("no navigation keys outside TUI — tool-based equivalents instead", async () => {
    const { hook } = createHook({ tasks: [], launchResult: { id: "bg_n2", description: "demo" }, tuiNavigation: false })
    const text = await run(hook, "bg", "跑测试")
    expect(text).not.toContain("Ctrl+X")
    expect(text).toContain("/bg status 或 bg_output")
  })

  test("launch failure surfaces the error text instead of crashing the hook", async () => {
    const text = await run(createHook({ tasks: [], launchResult: new Error("no slots") }).hook, "bg", "跑测试")
    expect(text).toContain("后台任务启动失败")
    expect(text).toContain("no slots")
  })

  test("launch failure hint distinguishes shutdown from retryable failures", async () => {
    const retryable = await run(createHook({ tasks: [], launchResult: new Error("no slots") }).hook, "bg", "跑测试")
    expect(retryable).toContain("可稍后重试或检查模型配置")
    const shutdown = await run(
      createHook({ tasks: [], launchResult: new Error("background manager is shutting down, cannot launch tasks") }).hook,
      "bg",
      "跑测试",
    )
    expect(shutdown).toContain("插件正在关闭")
    expect(shutdown).not.toContain("可稍后重试")
  })

  test("--parallel N does not launch natively; it hands the model a spawn instruction", async () => {
    const { hook, launches } = createHook({ tasks: [] })
    const text = await run(hook, "bg", "重构三个模块 --parallel 3")
    expect(launches).toHaveLength(0)
    // 用户可见的反馈在前（与原生路径的秒级回执形成一致的起点），模型指令在后
    expect(text).toContain("已交给模型拆分（N=3）")
    expect(text).toContain("重构三个模块")
    expect(text).toContain("【并行启动 N=3】")
    expect(text).toContain("3 次 bg_spawn")
  })

  test("--parallel with n<2 or no task text gets a usage hint", async () => {
    const { hook, launches } = createHook({ tasks: [] })
    expect(await run(hook, "bg", "--parallel 1 做事")).toContain("用法:")
    expect(await run(hook, "bg", "--parallel 5")).toContain("用法:")
    expect(launches).toHaveLength(0)
  })

  test("--parallel over the MAX_SUBTASKS cap gets a usage hint, not an unbounded spawn instruction", async () => {
    const { hook, launches } = createHook({ tasks: [] })
    const text = await run(hook, "bg", "--parallel 50 做事")
    expect(text).toContain("用法:")
    expect(text).toContain("2-12")
    expect(text).not.toContain("【并行启动 N=50】")
    expect(launches).toHaveLength(0)
  })

  test("empty arguments get a usage hint instead of a model round with nothing to relay", async () => {
    const { hook, launches } = createHook({ tasks: [] })
    expect(await run(hook, "bg", "")).toContain("用法:")
    expect(launches).toHaveLength(0)
  })

  test("image attachments on the command message follow the task (vision enabled)", async () => {
    const output = { parts: [{ type: "file", mime: "image/png", url: "data:image/png;base64,AAA" }] as Array<{ type: string; text?: string; [key: string]: unknown }> }
    const { hook, launches } = createHook({ tasks: [], launchResult: { id: "bg_img", description: "看图" } })
    await hook({ command: "bg", sessionID: "session", arguments: "分析这张图" }, output)
    expect(launches).toHaveLength(1)
    // 回归（P0）：parts 必须自带任务文本 part——startTask 的语义是 parts
    // 完全取代 input.prompt，只传图片会把任务指令整个丢掉。
    expect(launches[0]!.parts).toEqual([
      { type: "text", text: "分析这张图", synthetic: true },
      { type: "file", mime: "image/png", url: "data:image/png;base64,AAA" },
    ])
  })

  test("/bg and /split are refused inside prism child sessions", async () => {
    for (const command of ["bg", "split"] as const) {
      const { hook, launches, splitCalls } = createHook({ tasks: [], isChildSession: true })
      const text = await run(hook, command, "做点事")
      expect(text).toContain("后台子会话内不能执行")
      expect(text).toContain("回到主会话")
      expect(launches).toHaveLength(0)
      expect(splitCalls).toHaveLength(0)
    }
  })

  test("no image follow when vision is disabled (child has no vision_look)", async () => {
    const output = { parts: [{ type: "file", mime: "image/png", url: "data:image/png;base64,AAA" }] as Array<{ type: string; text?: string; [key: string]: unknown }> }
    const { hook, launches } = createHook({ tasks: [], launchResult: { id: "bg_img", description: "看图" }, visionEnabled: false })
    await hook({ command: "bg", sessionID: "session", arguments: "分析这张图" }, output)
    expect(launches[0]!.parts).toBeUndefined()
  })
})

describe("/split native execution", () => {
  test("a task description starts the split asynchronously and injects the outcome via the gate", async () => {
    const { hook, splitCalls, dispatches } = createHook({
      tasks: [],
      splitOutcome: { kind: "launched", message: "拆分计划已启动：2 个子任务" },
    })
    const text = await run(hook, "split", "重构整个模块 --dry-run")
    expect(text).toContain("拆分任务已启动")
    expect(splitCalls).toEqual([
      { sessionID: "session", task: "重构整个模块", dryRun: true, sequential: false, maxSubtasks: undefined },
    ])
    // fire-and-forget 链：等微任务与 gate dispatch 落地
    await Bun.sleep(5)
    expect(dispatches).toHaveLength(1)
    expect(dispatches[0]!.source).toBe("split-native-outcome")
    expect(dispatches[0]!.text).toContain("拆分计划已启动：2 个子任务")
  })

  test("dry-run plans are fenced inside the injected reminder", async () => {
    const { hook, dispatches } = createHook({
      tasks: [],
      splitOutcome: { kind: "dry-run", message: "拆分计划（2 个子任务，未执行）" },
    })
    await run(hook, "split", "写文档 --dry-run")
    await Bun.sleep(5)
    expect(dispatches[0]!.text).toContain("```text")
    expect(dispatches[0]!.text).toContain("拆分计划（2 个子任务，未执行）")
  })

  test("flags are parsed and stripped from the task text", async () => {
    const { hook, splitCalls } = createHook({ tasks: [] })
    await run(hook, "split", "迁移数据库 --sequential --max 4")
    expect(splitCalls[0]!.task).toBe("迁移数据库")
    expect(splitCalls[0]!.sequential).toBe(true)
    expect(splitCalls[0]!.maxSubtasks).toBe(4)
  })

  test("empty task text after flag stripping gets a usage hint and never calls the service", async () => {
    const { hook, splitCalls } = createHook({ tasks: [] })
    expect(await run(hook, "split", "--dry-run")).toContain("用法:")
    expect(splitCalls).toHaveLength(0)
  })

  test("empty arguments get a usage hint", async () => {
    const { hook } = createHook({ tasks: [] })
    expect(await run(hook, "split", "")).toContain("用法:")
  })
})

describe("/split command routing (boards)", () => {
  test("/split cancel sp_xxx cancels the run's unfinished subtasks only", async () => {
    const registry = new SplitRunRegistry()
    const running = makeTask({ id: "bg_r1", status: "running" })
    const done = makeTask({ id: "bg_r2", status: "completed" })
    const { id: runID } = registry.register({
      sessionID: "session",
      plans: [],
      tasksByPlanID: new Map([
        ["s1", running],
        ["s2", done],
      ]),
      skippedPlanIDs: new Map(),
      sequential: false,
      settled: false,
      createdAt: new Date(),
    })
    const cancelledCalls: Array<{ id: string; skipNotification?: boolean }> = []
    const { hook, toasts } = createHook({
      tasks: [running, done],
      registry,
      onCancelTask: async (taskID, cancelOptions) => {
        cancelledCalls.push({ id: taskID, skipNotification: cancelOptions?.skipNotification })
        return true
      },
    })
    const text = await run(hook, "split", `cancel ${runID}`)
    expect(cancelledCalls).toEqual([{ id: "bg_r1", skipNotification: true }]) // completed 跳过
    expect(text).toContain(`已取消拆分任务 \`${runID}\` 的 1 个子任务`)
    // 整批取消只弹一条汇总 toast（防逐任务 CANCELLED 刷屏）
    expect(toasts.some((t) => t.includes(`已取消拆分任务 \`${runID}\` 的 1 个子任务`))).toBe(true)
  })

  test("/split cancel without an id retires the whole session (symmetrical to /bg cancel)", async () => {
    const { hook, splitCalls, cancelAllCalls, toasts } = createHook({ tasks: [makeTask({})] })
    const text = await run(hook, "split", "cancel")
    expect(cancelAllCalls).toEqual([{ parentSessionID: "session", source: "/split cancel" }])
    expect(splitCalls).toHaveLength(0) // 绝不穿透成任务 spawn
    expect(text).toContain("已取消当前会话的全部后台任务")
    expect(toasts.some((t) => t.includes("正在取消当前会话的全部后台任务"))).toBe(true)
  })

  test("unrecognized cancel variants get a usage hint instead of spawning a task", async () => {
    const { hook, splitCalls, launches } = createHook({ tasks: [] })
    for (const args of ["cancel --all", "cancel bg_1 bg_2"]) {
      const text = await run(hook, "split", args)
      expect(text).toContain("用法: /split cancel")
      expect(text).toContain("不带参数取消当前会话全部任务")
    }
    expect(splitCalls).toHaveLength(0)
    expect(launches).toHaveLength(0)
  })
})
