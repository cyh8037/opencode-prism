import { describe, expect, test } from "bun:test"
import { createSplitTool } from "../src/tools/split"

// description 在工厂期构建（autoTrigger 配置读取一次），execute 不被调用，
// 因此 service 占位即可。
const service = {} as never

describe("createSplitTool autoTrigger guidance", () => {
  test("appends the proactive-trigger guidance when enabled", () => {
    const description = createSplitTool(service, { autoTrigger: true }).split_task!.description
    expect(description).toContain("【自主触发准则】")
    expect(description).toContain("无需用户显式要求 /split")
    expect(description).toContain("立即告知用户已转入拆分执行")
    expect(description).toContain("与主会话正在编辑的同一批文件冲突")
    expect(description).toContain("用 bg_spawn 更合适")
    expect(description).toContain("无法确定是否适用时，不调用")
    // 基础描述保留
    expect(description).toContain("按依赖关系并发执行")
  })

  test("keeps the plain description when disabled", () => {
    const description = createSplitTool(service, { autoTrigger: false }).split_task!.description
    expect(description).not.toContain("【自主触发准则】")
    expect(description).toContain("按依赖关系并发执行")
  })

  test("defaults to enabled (config.split.autoTrigger default true)", () => {
    const description = createSplitTool(service).split_task!.description
    expect(description).toContain("【自主触发准则】")
  })
})
