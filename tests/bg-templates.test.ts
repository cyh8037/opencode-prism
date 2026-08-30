import { describe, expect, test } from "bun:test"
import { createBgCommand, createSplitCommand } from "../src/commands/templates"
import { collectLatestUserImages } from "../src/core/background/image-follow"

describe("createBgCommand", () => {
  test("tells the model to relay injected results completely (no omission, no rewrite, no tools)", () => {
    const template = createBgCommand(true).template
    expect(template).toContain("relay the injected content completely")
    expect(template).toContain("do not omit, compress, or reorder")
    expect(template).toContain("do not invoke any tools")
    expect(template).toContain("do not rewrite as a list")
    expect(template).toContain("do not add emoji")
    expect(template).toContain("do not re-execute the task")
  })

  test("does NOT contain $ARGUMENTS — the model must never see the task description", () => {
    // 防双发的关键：任务描述由插件原生消费，模型只看到回执。实测模板
    // 回合曾出现模型拿到描述后不调工具自己开干。
    expect(createBgCommand(true).template).not.toContain("$ARGUMENTS")
  })

  test("parallel branch hands the model an explicit spawn instruction", () => {
    const template = createBgCommand(true).template
    expect(template).toContain("[Parallel Launch")
    expect(template).toContain("concurrently in the same turn")
    expect(template).toContain("never await sequentially")
  })

  test("image guidance lives in the parallel branch and reflects automatic forwarding", () => {
    const template = createBgCommand(true).template
    expect(template).toContain("forwarded automatically to the corresponding child session")
    expect(template).toContain("include the file path in that subtask's prompt")
  })

  test("image guidance is dropped when vision is disabled", () => {
    const template = createBgCommand(false).template
    expect(template).not.toContain("vision_look")
  })

  test("includes the native child-session navigation guidance in TUI mode", () => {
    const template = createBgCommand(true, true).template
    expect(template).toContain("press Ctrl+X then ↓")
    expect(template).toContain("[bg_ task id]")
    expect(template).toContain("Do not poll by repeatedly calling bg_output")
  })

  test("swaps the navigation guidance for tool-based equivalents outside TUI", () => {
    const template = createBgCommand(true, false).template
    expect(template).not.toContain("Ctrl+X")
    expect(template).toContain("/bg status or bg_output")
  })
})

describe("createSplitCommand", () => {
  test("tells the model to relay the dashboard completely and keep pipe-table structure", () => {
    const template = createSplitCommand(true).template
    expect(template).toContain("relay the injected content completely")
    expect(template).toContain("do not omit, compress, or reorder")
    expect(template).toContain("preserve hierarchical structure and dependency notes")
    expect(template).toContain("do not add emoji")
    expect(template).toContain("do not merge lines")
    expect(template).toContain("do not invoke any tools")
    // 方案 a:markdown 管道表格,模型转达时必须保留 | 列分隔
    expect(template).toContain("preserve table '|' column delimiters")
  })

  test("relays the intent verdict instead of retrying and includes the navigation guidance", () => {
    const template = createSplitCommand(true, true).template
    expect(template).toContain("Intent check: no split needed")
    expect(template).toContain("split.intentCheck=false")
    expect(template).toContain("press Ctrl+X then ↓")
  })

  test("does NOT contain $ARGUMENTS either", () => {
    expect(createSplitCommand(true).template).not.toContain("$ARGUMENTS")
  })

  test("non-TUI mode swaps the navigation guidance", () => {
    const template = createSplitCommand(true, false).template
    expect(template).not.toContain("Ctrl+X")
    expect(template).toContain("/split status or bg_output")
  })
})

describe("collectLatestUserImages", () => {
  const userMessage = (parts: unknown[]) => ({ info: { role: "user" }, parts })
  const assistantMessage = (parts: unknown[]) => ({ info: { role: "assistant" }, parts })
  const imagePart = (url: string) => ({ type: "file", mime: "image/png", url })

  test("returns images from the newest user message even with trailing assistant turns", () => {
    const messages = [
      assistantMessage([{ type: "text", text: "ok" }]),
      userMessage([{ type: "text", text: "分析这张图" }, imagePart("data:image/png;base64,AAA")]),
      assistantMessage([{ type: "text", text: "done" }]),
    ]
    const images = collectLatestUserImages(messages, 4)
    expect(images).toHaveLength(1)
    expect(images[0]!.url).toBe("data:image/png;base64,AAA")
  })

  test("does NOT scan past the newest user message — old images stay out", () => {
    // 最新的用户消息无图:更早消息的图片是旧上下文,跟随它们会把无关
    // 附件注入不相干的子任务(autoTrigger 下模型可随时自主 bg_spawn)。
    const messages = [
      userMessage([imagePart("file:///old.png")]),
      assistantMessage([{ type: "text", text: "好" }]),
      userMessage([{ type: "text", text: "换个话题,跑个测试" }]),
    ]
    expect(collectLatestUserImages(messages, 4)).toEqual([])
  })

  test("returns [] when no user message carries images", () => {
    const messages = [
      userMessage([{ type: "text", text: "无图" }]),
      assistantMessage([imagePart("file:///b.png")]),
    ]
    expect(collectLatestUserImages(messages, 4)).toEqual([])
  })

  test("caps the batch at max", () => {
    const messages = [userMessage([imagePart("u1"), imagePart("u2"), imagePart("u3")])]
    expect(collectLatestUserImages(messages, 2)).toHaveLength(2)
  })

  test("non-array input returns []", () => {
    expect(collectLatestUserImages(undefined, 4)).toEqual([])
    expect(collectLatestUserImages({}, 4)).toEqual([])
  })
})
