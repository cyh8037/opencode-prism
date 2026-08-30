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
    expect(result).toContain("No background tasks to wait for")
  })

  test("unknown and foreign ids are reported without waiting", async () => {
    const definition = toolsWith([]).bg_wait!
    const result = await definition.execute(
      { taskIds: ["bg_ghost", "bg_1"] },
      { sessionID: "session" } as never,
    )
    expect(result).toContain("not found or expired: bg_ghost")
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
    // 措辞是"After launch"（返回时任务实为 queued）,键位直接写默认按键
    // Ctrl+X,不写"leader key"这类极客术语。
    expect(result).toContain("After launch, In TUI, press Ctrl+X then ↓")
    expect(result).toContain("↑ to return to parent session")
  })
})
