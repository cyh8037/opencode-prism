import { describe, expect, test } from "bun:test"
import { createSplitTool } from "../src/tools/split"

// description 在工厂期构建（autoTrigger 配置读取一次），execute 不被调用，
// 因此 service 占位即可。
const service = {} as never

describe("createSplitTool autoTrigger guidance", () => {
  test("appends the proactive-trigger guidance when enabled", () => {
    const description = createSplitTool(service, { autoTrigger: true }).split_task!.description
    expect(description).toContain("[Autonomous Trigger Guidelines]")
    expect(description).toContain("(without explicit user request)")
    expect(description).toContain("execution has moved to task splitting")
    expect(description).toContain("conflicts with files currently being edited in the parent session")
    expect(description).toContain("(bg_spawn is preferred)")
    expect(description).toContain("Do not invoke if uncertain")
    // 基础描述保留
    expect(description).toContain("execute concurrently based on dependencies")
  })

  test("keeps the plain description when disabled", () => {
    const description = createSplitTool(service, { autoTrigger: false }).split_task!.description
    expect(description).not.toContain("[Autonomous Trigger Guidelines]")
    expect(description).toContain("execute concurrently based on dependencies")
  })

  test("defaults to enabled (config.split.autoTrigger default true)", () => {
    const description = createSplitTool(service).split_task!.description
    expect(description).toContain("[Autonomous Trigger Guidelines]")
  })
})
