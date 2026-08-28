import { describe, expect, test } from "bun:test"
import { createBgCommand, createSplitCommand } from "../src/commands/templates"
import { collectLatestUserImages } from "../src/tools/bg"

describe("createBgCommand", () => {
  test("tells the model to relay injected dashboards verbatim (no rewrite, no emoji)", () => {
    const template = createBgCommand(true).template
    expect(template).toContain("原样转达")
    expect(template).toContain("保留表格与分层格式")
    expect(template).toContain("不要改写为列表")
    expect(template).toContain("不要添加 emoji")
  })

  test("image guidance reflects automatic attachment forwarding", () => {
    const template = createBgCommand(true).template
    expect(template).toContain("插件会自动把当前消息中的图片附件传给后台子会话")
  })

  test("old-image tasks are told to reference the image path explicitly", () => {
    const template = createBgCommand(true).template
    expect(template).toContain("自动传图只跟随当前消息")
    expect(template).toContain("写进 prompt")
  })

  test("image guidance is dropped when vision is disabled", () => {
    const template = createBgCommand(false).template
    expect(template).not.toContain("vision_look")
  })
})

describe("createSplitCommand", () => {
  test("tells the model to relay the DAG dashboard verbatim", () => {
    const template = createSplitCommand(true).template
    expect(template).toContain("原样转达")
    expect(template).toContain("保留分层结构与依赖标注")
    expect(template).toContain("不要添加 emoji")
    expect(template).toContain("不要自行合并行")
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
