import { describe, expect, test } from "bun:test"
import { createBgCommand, createSplitCommand } from "../src/commands/templates"
import { collectLatestUserImages } from "../src/core/background/image-follow"

describe("createBgCommand", () => {
  test("tells the model to relay injected results completely (no omission, no rewrite, no tools)", () => {
    const template = createBgCommand(true).template
    expect(template).toContain("完整转达")
    expect(template).toContain("不要省略、压缩或重排")
    expect(template).toContain("不要调用任何工具")
    expect(template).toContain("不要改写为列表")
    expect(template).toContain("不要添加 emoji")
    expect(template).toContain("不要重复执行任务")
  })

  test("does NOT contain $ARGUMENTS — the model must never see the task description", () => {
    // 防双发的关键：任务描述由插件原生消费，模型只看到回执。实测模板
    // 回合曾出现模型拿到描述后不调工具自己开干。
    expect(createBgCommand(true).template).not.toContain("$ARGUMENTS")
  })

  test("parallel branch hands the model an explicit spawn instruction", () => {
    const template = createBgCommand(true).template
    expect(template).toContain("【并行启动")
    expect(template).toContain("并行调用")
    expect(template).toContain("绝不串行等待")
  })

  test("image guidance lives in the parallel branch and reflects automatic forwarding", () => {
    const template = createBgCommand(true).template
    expect(template).toContain("自动传给对应子会话")
    expect(template).toContain("把文件路径写进该子任务的 prompt")
  })

  test("image guidance is dropped when vision is disabled", () => {
    const template = createBgCommand(false).template
    expect(template).not.toContain("vision_look")
  })

  test("includes the native child-session navigation guidance in TUI mode", () => {
    const template = createBgCommand(true, true).template
    expect(template).toContain("TUI 中按 leader 键（默认 Ctrl+X）")
    expect(template).toContain("[bg_ 任务 id] 开头")
    expect(template).toContain("不要通过反复调用 bg_output 轮询过程")
  })

  test("swaps the navigation guidance for tool-based equivalents outside TUI", () => {
    const template = createBgCommand(true, false).template
    expect(template).not.toContain("Ctrl+X")
    expect(template).toContain("/bg status 或 bg_output 工具查看")
  })
})

describe("createSplitCommand", () => {
  test("tells the model to relay the dashboard completely and keep pipe-table structure", () => {
    const template = createSplitCommand(true).template
    expect(template).toContain("完整转达")
    expect(template).toContain("不要省略、压缩或重排")
    expect(template).toContain("保留分层结构与依赖标注")
    expect(template).toContain("不要添加 emoji")
    expect(template).toContain("不要自行合并行")
    expect(template).toContain("不要调用任何工具")
    // 方案 a:markdown 管道表格,模型转达时必须保留 | 列分隔
    expect(template).toContain("保留表格的 | 列分隔结构")
  })

  test("relays the intent verdict instead of retrying and includes the navigation guidance", () => {
    const template = createSplitCommand(true, true).template
    expect(template).toContain("意图识别：无需拆分")
    expect(template).toContain("split.intentCheck=false")
    expect(template).toContain("TUI 中按 leader 键（默认 Ctrl+X）")
  })

  test("does NOT contain $ARGUMENTS either", () => {
    expect(createSplitCommand(true).template).not.toContain("$ARGUMENTS")
  })

  test("non-TUI mode swaps the navigation guidance", () => {
    const template = createSplitCommand(true, false).template
    expect(template).not.toContain("Ctrl+X")
    expect(template).toContain("/split status 或 bg_output 查看")
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
