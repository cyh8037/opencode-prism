import { describe, expect, test } from "bun:test"
import { createBgTools } from "../src/tools/bg"
import type { BackgroundManager } from "../src/core/background/manager"
import type { BgTask } from "../src/core/background/types"

// bg_wait argument semantics only — queue/notify behavior of the manager is
// covered in background-manager.test.ts.

function toolsWith(tasks: BgTask[]) {
  const manager = {
    getTask: (id: string) => tasks.find((task) => task.id === id),
    getTasksByParentSession: () => tasks,
    waitForTasks: async () => ({ tasks, timedOut: false }),
    launch: async () => {
      throw new Error("launch not expected")
    },
  } as unknown as BackgroundManager
  return createBgTools(manager)
}

describe("bg_wait", () => {
  test("an explicit empty list returns immediately instead of widening scope", async () => {
    const running = { id: "bg_1", parentSessionId: "session", status: "running" } as BgTask
    const definition = toolsWith([running]).bg_wait!
    const result = await definition.execute({ taskIds: [] }, { sessionID: "session" } as never)
    expect(result).toContain("没有需要等待的后台任务")
  })

  test("unknown and foreign ids are reported without waiting", async () => {
    const definition = toolsWith([]).bg_wait!
    const result = await definition.execute(
      { taskIds: ["bg_ghost", "bg_1"] },
      { sessionID: "session" } as never,
    )
    expect(result).toContain("不存在或已过期: bg_ghost")
  })
})

describe("bg_spawn", () => {
  test("the return text carries the task id and the native-TUI navigation hint", async () => {
    const manager = {
      getTask: () => undefined,
      getTasksByParentSession: () => [],
      launch: async () => ({
        id: "bg_hint1234",
        description: "demo",
        model: { providerID: "openai", modelID: "gpt-5.6-sol" },
      }),
    } as unknown as BackgroundManager
    const definition = createBgTools(manager, { visionEnabled: true, autoTrigger: true }).bg_spawn!
    const result = await definition.execute({ description: "demo", prompt: "work" }, { sessionID: "session" } as never)
    expect(result).toContain("bg_hint1234")
    // 措辞是"启动后"（返回时任务实为 queued）,键位写"默认"不写死
    expect(result).toContain("启动后可")
    expect(result).toContain("TUI 中按 leader 键（默认 Ctrl+X）")
    expect(result).toContain("↑ 返回主会话")
  })
})
