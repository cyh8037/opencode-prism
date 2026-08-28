import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { lastAssistantText } from "../src/core/assistant-text"
import { extractImageAttachments, extractImageParts } from "../src/core/vision/detector"
import { normalizeImageUrl } from "../src/core/vision/image-utils"

// A minimal valid PNG (magic bytes only) so the sniffing data-URL path
// accepts it — fake base64 like "abc" is rejected by the magic-byte check.
const FAKE_PNG_URL = `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64")}`
import { createVisionLookTool } from "../src/tools/vision-look"
import { createChatMessageHook } from "../src/hooks/chat-message"
import { VisionPipeline } from "../src/core/vision/pipeline"
import { BackgroundManager } from "../src/core/background/manager"
import { CurrentModelTracker } from "../src/core/vision/model-tracker"
import { PromptGate } from "../src/core/prompt-gate"
import { parseConfig } from "../src/config/load"
import type { PrismClient } from "../src/core/client-types"

const VISION_MODEL = { providerID: "openai", modelID: "gpt-5.6-sol" }

describe("detector", () => {
  test("extracts image attachments from tool output", () => {
    const images = extractImageAttachments({
      output: "text",
      attachments: [
        { mime: "image/png", url: "https://x/s.png" },
        { mime: "application/pdf", url: "https://x/a.pdf" },
        { mime: "IMAGE/JPEG", url: "data:image/jpeg;base64,abc" },
        { url: "https://x/no-mime" },
      ],
    })
    expect(images).toHaveLength(2)
    expect(images[0]?.mime).toBe("image/png")
    expect(images[1]?.mime).toBe("image/jpeg")
  })

  test("extracts image file parts from chat messages", () => {
    const images = extractImageParts([
      { type: "file", mime: "image/png", url: "https://x/1.png" },
      { type: "file", mime: "text/plain", url: "https://x/1.txt" },
      { type: "text", text: "hello" },
    ])
    expect(images).toHaveLength(1)
  })
})

// Minimal payload carrying a real PNG magic-byte signature. The size check
// and the mime sniff only look at the header, so 11 bytes are enough.
function pngBytes(): Uint8Array {
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
}

describe("normalizeImageUrl", () => {
  test("passes data URLs through", async () => {
    const image = await normalizeImageUrl({ mime: "image/png", url: FAKE_PNG_URL })
    expect(image?.url).toBe(FAKE_PNG_URL)
  })

  test("converts remote URLs to data URLs", async () => {
    globalThis.fetch = (async () =>
      new Response(pngBytes(), { status: 200 })) as unknown as typeof fetch
    const image = await normalizeImageUrl({ mime: "image/png", url: "https://x/1.png" })
    expect(image?.url.startsWith("data:image/png;base64,")).toBe(true)
  })

  test("drops failed fetches", async () => {
    globalThis.fetch = (async () => new Response("nope", { status: 404 })) as unknown as typeof fetch
    const image = await normalizeImageUrl({ mime: "image/png", url: "https://x/404.png" })
    expect(image).toBeNull()
  })

  test("drops remote responses that are not supported images", async () => {
    globalThis.fetch = (async () =>
      new Response(new Uint8Array([0x3c, 0x68, 0x74, 0x6d, 0x6c, 0x3e]), { status: 200 })) as unknown as typeof fetch
    const image = await normalizeImageUrl({ mime: "image/png", url: "https://x/not-an-image" })
    expect(image).toBeNull()
  })

  test("reads local absolute paths into data URLs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "prism-vision-"))
    try {
      const file = join(dir, "shot.png")
      const bytes = pngBytes()
      writeFileSync(file, bytes)
      const image = await normalizeImageUrl({ mime: "image/png", url: file })
      expect(image?.url).toBe(`data:image/png;base64,${Buffer.from(bytes).toString("base64")}`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("resolves relative paths against the base directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "prism-vision-"))
    try {
      const bytes = pngBytes()
      writeFileSync(join(dir, "shot.png"), bytes)
      const image = await normalizeImageUrl({ mime: "image/png", url: "./shot.png" }, dir)
      expect(image?.url).toBe(`data:image/png;base64,${Buffer.from(bytes).toString("base64")}`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("treats bare dotfile paths as local files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "prism-vision-"))
    try {
      const bytes = pngBytes()
      writeFileSync(join(dir, ".shot.png"), bytes)
      const image = await normalizeImageUrl({ mime: "image/png", url: ".shot.png" }, dir)
      expect(image?.url).toBe(`data:image/png;base64,${Buffer.from(bytes).toString("base64")}`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("treats bare image filenames as local files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "prism-vision-"))
    try {
      const bytes = pngBytes()
      writeFileSync(join(dir, "shot.png"), bytes)
      const image = await normalizeImageUrl({ mime: "image/png", url: "shot.png" }, dir)
      expect(image?.url).toBe(`data:image/png;base64,${Buffer.from(bytes).toString("base64")}`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("treats unprefixed relative paths with image extensions as local files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "prism-vision-"))
    try {
      const bytes = pngBytes()
      mkdirSync(join(dir, "assets"))
      writeFileSync(join(dir, "assets", "shot.png"), bytes)
      const image = await normalizeImageUrl({ mime: "image/png", url: "assets/shot.png" }, dir)
      expect(image?.url).toBe(`data:image/png;base64,${Buffer.from(bytes).toString("base64")}`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("matches image extensions case-insensitively", async () => {
    const dir = mkdtempSync(join(tmpdir(), "prism-vision-"))
    try {
      const bytes = pngBytes()
      writeFileSync(join(dir, "SHOT.PNG"), bytes)
      const image = await normalizeImageUrl({ mime: "image/png", url: "SHOT.PNG" }, dir)
      expect(image?.url).toBe(`data:image/png;base64,${Buffer.from(bytes).toString("base64")}`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("drops missing bare image filenames", async () => {
    const image = await normalizeImageUrl({ mime: "image/png", url: "no-such-shot.png" })
    expect(image).toBeNull()
  })

  test("drops local files that are not supported images", async () => {
    const dir = mkdtempSync(join(tmpdir(), "prism-vision-"))
    try {
      writeFileSync(join(dir, "note.txt"), "not an image")
      const image = await normalizeImageUrl({ mime: "image/png", url: join(dir, "note.txt") })
      expect(image).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("drops missing local files", async () => {
    const image = await normalizeImageUrl({ mime: "image/png", url: "/nonexistent/prism-shot.png" })
    expect(image).toBeNull()
  })
})

describe("lastAssistantText", () => {
  test("accepts completed assistant text", () => {
    const text = lastAssistantText([
      { info: { role: "assistant" }, parts: [{ type: "text", text: " 完成 ", state: { status: "completed" } }] },
    ])
    expect(text).toBe(" 完成 ")
  })

  test("accepts assistant text without part state (non-streaming providers)", () => {
    const text = lastAssistantText([{ info: { role: "assistant" }, parts: [{ type: "text", text: "no state" }] }])
    expect(text).toBe("no state")
  })

  test("skips in-flight streaming parts", () => {
    const text = lastAssistantText([
      { info: { role: "assistant" }, parts: [{ type: "text", text: "partial", state: { status: "streaming" } }] },
    ])
    expect(text).toBeNull()
  })

  test("prefers the newest non-empty assistant text", () => {
    const text = lastAssistantText([
      { info: { role: "user" }, parts: [{ type: "text", text: "user text" }] },
      {
        info: { role: "assistant" },
        parts: [{ type: "tool", tool: "x" }, { type: "text", text: "latest", state: { status: "completed" } }],
      },
      { info: { role: "assistant" }, parts: [{ type: "text", text: "", state: { status: "completed" } }] },
    ])
    expect(text).toBe("latest")
  })
})

function createVisionHarness(mode: "sync" | "async" = "sync") {
  const childSessions = new Map<string, { prompts: unknown[]; createdModel: unknown }>()
  let childCounter = 0
  const client: PrismClient = {
    session: {
      get: async () => ({
        data: { id: "parent", directory: "/work", model: { id: "gpt-5.6-sol", providerID: "openai" } },
      }),
      create: async ({ body }) => {
        const id = `child_${++childCounter}`
        childSessions.set(id, {
          prompts: [],
          createdModel: (body as Record<string, unknown>).model,
        })
        return { data: { id } }
      },
      abort: async () => {},
      prompt: async () => {},
      promptAsync: async ({ path, body }) => {
        childSessions.get(path.id)?.prompts.push(body)
      },
      messages: async () => ({
        data: [
          {
            info: { role: "assistant" },
            parts: [{ type: "text", text: "这是一张登录页截图", state: { status: "completed" } }],
          },
        ],
      }),
      status: async () => ({ data: {} }),
    },
    tui: { showToast: async () => {} },
  }
  const config = parseConfig({ vision: { mode, model: "openai/gpt-5.6-sol" } })
  const gate = new PromptGate(client, { idlePollMs: 10 })
  const background = new BackgroundManager({
    client,
    directory: "/work",
    config,
    gate,
    resolveModel: async () => ({ providerID: "openai", modelID: "gpt-5.6-sol" }),
    pollingIntervalMs: 60_000,
  })
  const pipeline = new VisionPipeline({
    client,
    directory: "/work",
    config,
    background,
    getVisionModel: () => VISION_MODEL,
  })
  return { pipeline, client, config, gate, background, childSessions }
}

describe("VisionPipeline", () => {
  test("sync mode appends interpretation to tool output", async () => {
    const { pipeline } = createVisionHarness("sync")
    const output = { title: "screenshot", output: "screenshot taken" }
    await pipeline.onToolOutput(
      { tool: "screenshot", sessionID: "parent" },
      output,
      [{ mime: "image/png", url: FAKE_PNG_URL }],
    )
    expect(output.output).toContain("[prism vision]")
    expect(output.output).toContain("登录页截图")
  })

  test("tool output batches beyond the cap are noted in the output", async () => {
    const { pipeline } = createVisionHarness("sync")
    const output = { title: "screenshot", output: "screenshot taken" }
    const images = Array.from({ length: 5 }, () => ({ mime: "image/png", url: FAKE_PNG_URL }))
    await pipeline.onToolOutput({ tool: "screenshot", sessionID: "parent" }, output, images)
    expect(output.output).toContain("[prism vision] 图片解读")
    expect(output.output).toContain("1 张未解读")
  })

  test("vision child session uses the configured model and carries the system prompt", async () => {
    const { pipeline, childSessions } = createVisionHarness("sync")
    await pipeline.onToolOutput(
      { tool: "screenshot", sessionID: "parent" },
      { title: "s", output: "taken" },
      [{ mime: "image/png", url: FAKE_PNG_URL }],
    )
    const child = Array.from(childSessions.values())[0]
    expect(child?.createdModel).toEqual({ id: "gpt-5.6-sol", providerID: "openai" })
    const promptBody = child?.prompts[0] as Record<string, unknown>
    expect(promptBody?.system).toContain("视觉分析专家")
    expect(promptBody?.system).toContain("结构固定")
  })

  // A goal focuses the interpretation: the instruction sent to the child
  // carries the caller's concern instead of the generic one-liner.
  test("look with a goal sends a focused instruction", async () => {
    const { pipeline, childSessions } = createVisionHarness("sync")
    await pipeline.look("parent", [{ mime: "image/png", url: FAKE_PNG_URL }], "找出页面里的报错信息")
    const promptBody = Array.from(childSessions.values())[0]?.prompts[0] as Record<string, unknown>
    const parts = promptBody?.parts as Array<{ type: string; text?: string }>
    expect(parts?.[0]?.text).toContain("重点关注")
    expect(parts?.[0]?.text).toContain("找出页面里的报错信息")
  })

  test("look without a goal keeps the generic instruction", async () => {
    const { pipeline, childSessions } = createVisionHarness("sync")
    await pipeline.look("parent", [{ mime: "image/png", url: FAKE_PNG_URL }])
    const promptBody = Array.from(childSessions.values())[0]?.prompts[0] as Record<string, unknown>
    const parts = promptBody?.parts as Array<{ type: string; text?: string }>
    expect(parts?.[0]?.text).toBe("请解读以下图片。")
  })

  // P2-4: a timed-out interpretation must NOT be retried — the model or
  // network is slow and a second attempt would block the caller again.
  test("a timed-out interpretation is not retried", async () => {
    const { client } = createVisionHarness("sync")
    const childSessions = new Map<string, { prompts: unknown[] }>()
    let counter = 0
    client.session.create = async () => {
      counter += 1
      const id = `slow_child_${counter}`
      childSessions.set(id, { prompts: [] })
      return { data: { id } }
    }
    client.session.messages = async () => ({ data: [] }) // never any text
    client.session.status = async () => ({ data: { slow_child_1: { type: "busy" } } })
    const pipeline = new VisionPipeline({
      client,
      directory: "/work",
      config: parseConfig({ vision: { model: "openai/gpt-5.6-sol" } }),
      background: new BackgroundManager({
        client,
        directory: "/work",
        config: parseConfig({}),
        gate: new PromptGate(client, { idlePollMs: 10 }),
        resolveModel: async () => VISION_MODEL,
        pollingIntervalMs: 60_000,
      }),
      getVisionModel: () => VISION_MODEL,
      interpretTimeoutMs: 300,
    })
    const result = await pipeline.look("parent", [{ mime: "image/png", url: FAKE_PNG_URL }])
    expect(result.text).toBeNull()
    expect(result.reason).toBe("timeout")
    // exactly one child: the timeout suppressed the second attempt
    expect(childSessions.size).toBe(1)
  })

  // A prism child session's tool output must not re-trigger interpretation —
  // that would spawn a grandchild interpretation, and so on, unbounded.
  test("tool output on a prism child session does not re-trigger interpretation", async () => {
    const { pipeline, background, childSessions } = createVisionHarness("sync")
    const task = await background.launch({ description: "parent task", prompt: "work", parentSessionId: "parent" })
    await new Promise((resolve) => setTimeout(resolve, 100))
    if (!task.sessionId) throw new Error("task never claimed a session")

    const before = childSessions.size
    await pipeline.onToolOutput(
      { tool: "screenshot", sessionID: task.sessionId },
      { title: "s", output: "taken" },
      [{ mime: "image/png", url: FAKE_PNG_URL }],
    )
    expect(childSessions.size).toBe(before) // no grandchild interpretation
    await background.shutdown()
  })

  // Regression for the 2026-08-19 incident: sync-mode interpretation children
  // live outside the BackgroundManager, so the manager-based guard alone did
  // not stop the child's own output from re-triggering.
  test("tool output on an in-flight sync interpretation child does not re-trigger", async () => {
    const { pipeline, client, childSessions } = createVisionHarness("sync")
    // Keep the interpretation in flight by blocking its output poll.
    let releasePoll!: () => void
    let pollBlocked!: () => void
    const blocked = new Promise<void>((resolve) => (pollBlocked = resolve))
    const releasePromise = new Promise<void>((resolve) => (releasePoll = resolve))
    const originalMessages = client.session.messages.bind(client.session)
    client.session.messages = async (...args: Parameters<PrismClient["session"]["messages"]>) => {
      pollBlocked()
      await releasePromise
      return originalMessages(...args)
    }

    const pending = pipeline.onToolOutput(
      { tool: "screenshot", sessionID: "parent" },
      { title: "s", output: "taken" },
      [{ mime: "image/png", url: FAKE_PNG_URL }],
    )
    await blocked // interpretation child (child_1) created and now polling

    const before = childSessions.size
    await pipeline.onToolOutput(
      { tool: "screenshot", sessionID: "child_1" },
      { title: "s", output: "taken" },
      [{ mime: "image/png", url: FAKE_PNG_URL }],
    )
    expect(childSessions.size).toBe(before) // no grandchild interpretation

    releasePoll()
    await pending
  })

  test("unavailable vision model skips interpretation without creating a child session", async () => {
    const harness = createVisionHarness("sync")
    const noModelPipeline = new VisionPipeline({
      client: harness.client,
      directory: "/work",
      config: harness.config,
      background: harness.background,
      getVisionModel: () => undefined,
    })
    const output = { title: "screenshot", output: "taken" }
    await noModelPipeline.onToolOutput(
      { tool: "screenshot", sessionID: "parent" },
      output,
      [{ mime: "image/png", url: FAKE_PNG_URL }],
    )
    // fully skipped: output untouched AND no child session was ever created
    expect(output.output).toBe("taken")
    expect(harness.childSessions.size).toBe(0)
  })
})

describe("lookLatest (the \"last\" sentinel)", () => {
  test("interprets the most recent image message of the session", async () => {
    const { pipeline, client, childSessions } = createVisionHarness("sync")
    client.session.messages = async () => ({
      data: [
        {
          info: { role: "user" },
          parts: [
            { type: "text", text: "看看这个" },
            { type: "file", mime: "image/png", url: FAKE_PNG_URL },
          ],
        },
        { info: { role: "assistant" }, parts: [{ type: "text", text: "解读：这是一个登录页", state: { status: "completed" } }] },
      ],
    })
    const result = await pipeline.lookLatest("parent", "找出报错信息")
    expect(result.notFound).toBe(false)
    expect(result.text).toContain("这是一个登录页")
    // the interpretation child got the session's image + the focused goal
    const promptBody = Array.from(childSessions.values())[0]?.prompts[0] as Record<string, unknown>
    const parts = promptBody?.parts as Array<{ type: string; text?: string }>
    expect(parts?.[0]?.text).toContain("找出报错信息")
    expect(JSON.stringify(promptBody)).toContain("data:image/png;base64,")
  })

  test("reports notFound when the session has no image messages", async () => {
    const { pipeline, client } = createVisionHarness("sync")
    client.session.messages = async () => ({
      data: [{ info: { role: "user" }, parts: [{ type: "text", text: "纯文本" }] }],
    })
    const result = await pipeline.lookLatest("parent")
    expect(result.notFound).toBe(true)
    expect(result.text).toBeNull()
  })
})

describe("vision_look tool", () => {
  test("with no vision model returns failure text without throwing", async () => {
    const harness = createVisionHarness("sync")
    const noModelPipeline = new VisionPipeline({
      client: harness.client,
      directory: "/work",
      config: harness.config,
      background: harness.background,
      getVisionModel: () => undefined,
    })
    const tool = createVisionLookTool(noModelPipeline)
    const result = await tool.execute({ images: ["https://x/1.png"] }, { sessionID: "parent" } as never)
    expect(result).toContain("视觉解读失败")
  })

  test('images: ["last"] delegates to lookLatest', async () => {
    const harness = createVisionHarness("sync")
    harness.client.session.messages = async () => ({
      data: [
        { info: { role: "user" }, parts: [{ type: "file", mime: "image/png", url: FAKE_PNG_URL }] },
        { info: { role: "assistant" }, parts: [{ type: "text", text: "解读：页面顶部有报错横幅", state: { status: "completed" } }] },
      ],
    })
    const tool = createVisionLookTool(harness.pipeline)
    const result = await tool.execute(
      { images: ["last"], goal: "列出可见文字" },
      { sessionID: "parent" } as never,
    )
    expect(result).toContain("报错横幅")
  })

  test('images: ["last"] with no images returns guidance text', async () => {
    const harness = createVisionHarness("sync")
    harness.client.session.messages = async () => ({ data: [] })
    const tool = createVisionLookTool(harness.pipeline)
    const result = await tool.execute({ images: ["last"] }, { sessionID: "parent" } as never)
    expect(result).toContain("没有找到任何图片消息")
  })

  // The 2026-08-22 incident (originally via the removed /vision command):
  // an invalid image reference was reported as a missing vision model even
  // though vision.model was configured and resolved — the failure cause must
  // be reported truthfully on every entry point.
  test("invalid image refs report the real cause, not the missing-model hint", async () => {
    const harness = createVisionHarness("sync")
    const tool = createVisionLookTool(harness.pipeline)
    const result = await tool.execute({ images: ["not-a-ref"] }, { sessionID: "parent" } as never)
    expect(result).toContain("图片引用无效")
    expect(result).not.toContain("无可用视觉模型")
  })

  // A relay model may forward attachment placeholders as if they were
  // references; with only placeholders the tool must fall back to the
  // session's latest image instead of failing on unresolvable tokens.
  test('images: ["[Image 1]"] delegates to lookLatest', async () => {
    const harness = createVisionHarness("sync")
    harness.client.session.messages = async () => ({
      data: [
        { info: { role: "user" }, parts: [{ type: "file", mime: "image/png", url: FAKE_PNG_URL }] },
        { info: { role: "assistant" }, parts: [{ type: "text", text: "解读：页面顶部有报错横幅", state: { status: "completed" } }] },
      ],
    })
    const tool = createVisionLookTool(harness.pipeline)
    const result = await tool.execute({ images: ["[Image 1]"] }, { sessionID: "parent" } as never)
    expect(result).toContain("报错横幅")
  })

  test("mixed placeholders and a real data URL interpret the real one with a note", async () => {
    const harness = createVisionHarness("sync")
    harness.client.session.messages = async () => ({
      data: [{ info: { role: "assistant" }, parts: [{ type: "text", text: "解读：图表", state: { status: "completed" } }] }],
    })
    const tool = createVisionLookTool(harness.pipeline)
    const result = await tool.execute(
      { images: ["[Image 1]", FAKE_PNG_URL] },
      { sessionID: "parent" } as never,
    )
    expect(result).toContain("图表")
    expect(result).toContain("已忽略 1 个 [Image N] 占位符")
  })

  test('supports single string image argument (e.g. images: "last")', async () => {
    const harness = createVisionHarness("sync")
    harness.client.session.messages = async () => ({
      data: [
        { info: { role: "user" }, parts: [{ type: "file", mime: "image/png", url: FAKE_PNG_URL }] },
        { info: { role: "assistant" }, parts: [{ type: "text", text: "解读：字符串参数成功", state: { status: "completed" } }] },
      ],
    })
    const tool = createVisionLookTool(harness.pipeline)
    const result = await tool.execute(
      { images: "last" as never, goal: "test" },
      { sessionID: "parent" } as never,
    )
    expect(result).toContain("字符串参数成功")
  })

  test('supports case-insensitive and whitespace-padded " Last "', async () => {
    const harness = createVisionHarness("sync")
    harness.client.session.messages = async () => ({
      data: [
        { info: { role: "user" }, parts: [{ type: "file", mime: "image/png", url: FAKE_PNG_URL }] },
        { info: { role: "assistant" }, parts: [{ type: "text", text: "解读：大小写兼容成功", state: { status: "completed" } }] },
      ],
    })
    const tool = createVisionLookTool(harness.pipeline)
    const result = await tool.execute(
      { images: [" Last "] },
      { sessionID: "parent" } as never,
    )
    expect(result).toContain("大小写兼容成功")
  })

  test('mixed "last" and placeholders delegates to lookLatest without crashing', async () => {
    const harness = createVisionHarness("sync")
    harness.client.session.messages = async () => ({
      data: [
        { info: { role: "user" }, parts: [{ type: "file", mime: "image/png", url: FAKE_PNG_URL }] },
        { info: { role: "assistant" }, parts: [{ type: "text", text: "解读：混合哨兵成功", state: { status: "completed" } }] },
      ],
    })
    const tool = createVisionLookTool(harness.pipeline)
    const result = await tool.execute(
      { images: ["last", "[Image 1]"] },
      { sessionID: "parent" } as never,
    )
    expect(result).toContain("混合哨兵成功")
  })

  test('mixed "last" and explicit path: "last" wins, explicit path gets a note', async () => {
    const harness = createVisionHarness("sync")
    harness.client.session.messages = async () => ({
      data: [
        { info: { role: "user" }, parts: [{ type: "file", mime: "image/png", url: FAKE_PNG_URL }] },
        { info: { role: "assistant" }, parts: [{ type: "text", text: "解读：哨兵优先成功", state: { status: "completed" } }] },
      ],
    })
    const tool = createVisionLookTool(harness.pipeline)
    const result = await tool.execute(
      { images: ["last", "./screenshot.png"] },
      { sessionID: "parent" } as never,
    )
    expect(result).toContain("哨兵优先成功")
    expect(result).toContain("已忽略 1 个显式路径/URL")
  })

  test('single string real path (non-sentinel) is interpreted directly', async () => {
    const harness = createVisionHarness("sync")
    const tool = createVisionLookTool(harness.pipeline)
    const result = await tool.execute(
      { images: FAKE_PNG_URL },
      { sessionID: "parent" } as never,
    )
    expect(result).not.toContain("视觉解读失败")
  })

  // 2026-08-25 recursion incident: an interpretation child called vision_look
  // on its own injected image, spawning an unbounded chain of grandchildren.
  // The tool must refuse nested interpretation instead of creating a child.
  test("vision_look inside an interpretation child refuses and does not nest", async () => {
    const harness = createVisionHarness("sync")
    // Block the interpretation child's result poll so it stays in the
    // in-flight set while the nested vision_look call is made.
    let releasePoll!: () => void
    let pollBlocked!: () => void
    const blocked = new Promise<void>((resolve) => (pollBlocked = resolve))
    const releasePromise = new Promise<void>((resolve) => (releasePoll = resolve))
    harness.client.session.messages = async (...args: Parameters<PrismClient["session"]["messages"]>) => {
      const sessionID = args[0]?.path?.id
      if (sessionID !== "parent") {
        // interpretation child's result poll: hold it in-flight, then answer
        pollBlocked()
        await releasePromise
      }
      return {
        data: [
          { info: { role: "user" }, parts: [{ type: "file", mime: "image/png", url: FAKE_PNG_URL }] },
          { info: { role: "assistant" }, parts: [{ type: "text", text: "解读：这是第一层", state: { status: "completed" } }] },
        ],
      }
    }

    const tool = createVisionLookTool(harness.pipeline)
    const pending = tool.execute({ images: "last" }, { sessionID: "parent" } as never)
    await blocked // interpretation child created and now polling

    const childID = Array.from(harness.childSessions.keys())[0]!
    const before = harness.childSessions.size
    const nested = await tool.execute({ images: "last" }, { sessionID: childID } as never)
    expect(nested).toContain("嵌套解读")
    expect(harness.childSessions.size).toBe(before)

    releasePoll()
    await pending
  })

  // Async-mode background vision task children (taskType "vision") keep
  // vision_look enabled and carry their own injected image; a model that
  // cannot see the image could lookLatest its own session. The guard must
  // cover them too.
  test("vision_look inside a vision task child refuses and does not nest", async () => {
    const harness = createVisionHarness("async")
    const task = await harness.background.launch({
      description: "vision task",
      prompt: "解读图片",
      parentSessionId: "parent",
      taskType: "vision",
    })
    await new Promise((resolve) => setTimeout(resolve, 100))
    if (!task.sessionId) throw new Error("task never claimed a session")

    const before = harness.childSessions.size
    const tool = createVisionLookTool(harness.pipeline)
    const result = await tool.execute({ images: "last" }, { sessionID: task.sessionId } as never)
    expect(result).toContain("嵌套解读")
    expect(harness.childSessions.size).toBe(before) // no nested interpretation child
  })

  // Ordinary background subtasks (taskType "default") carry no injected image
  // and MAY call vision_look on images of their own — the recursion guard
  // refuses interpretation contexts (sync children + vision tasks), not every
  // prism child. Regression for the 0.4.0-era blanket isChildSession guard
  // that made every subtask's vision_look fail with the nesting error.
  test("vision_look inside an ordinary background subtask interprets instead of refusing", async () => {
    const harness = createVisionHarness("async")
    const task = await harness.background.launch({
      description: "subtask",
      prompt: "工作",
      parentSessionId: "parent",
    })
    await new Promise((resolve) => setTimeout(resolve, 100))
    if (!task.sessionId) throw new Error("task never claimed a session")

    // The subtask's session has a pasted image; lookLatest must find it and
    // run the interpretation (one nested child), not refuse.
    harness.client.session.messages = async () => ({
      data: [
        { info: { role: "user" }, parts: [{ type: "file", mime: "image/png", url: FAKE_PNG_URL }] },
        { info: { role: "assistant" }, parts: [{ type: "text", text: "解读：子任务读图成功", state: { status: "completed" } }] },
      ],
    })
    const before = harness.childSessions.size
    const tool = createVisionLookTool(harness.pipeline)
    const result = await tool.execute({ images: "last" }, { sessionID: task.sessionId } as never)
    expect(result).toContain("子任务读图成功")
    expect(harness.childSessions.size).toBe(before + 1) // exactly one nested interpretation child
  })

  // A relay model may serialize the array form as a JSON string
  // ("[\"last\"]" instead of ["last"]) — the sentinel must still resolve.
  test('images: "[\"last\"]" (serialized array) delegates to lookLatest', async () => {
    const harness = createVisionHarness("sync")
    harness.client.session.messages = async () => ({
      data: [
        { info: { role: "user" }, parts: [{ type: "file", mime: "image/png", url: FAKE_PNG_URL }] },
        { info: { role: "assistant" }, parts: [{ type: "text", text: "解读：序列化数组成功", state: { status: "completed" } }] },
      ],
    })
    const tool = createVisionLookTool(harness.pipeline)
    const result = await tool.execute(
      { images: '["last"]' },
      { sessionID: "parent" } as never,
    )
    expect(result).toContain("序列化数组成功")
  })

  test('images: "[\"<data-url>\"]" (serialized array of a real ref) interprets directly', async () => {
    const harness = createVisionHarness("sync")
    const tool = createVisionLookTool(harness.pipeline)
    const result = await tool.execute(
      { images: `["${FAKE_PNG_URL}"]` },
      { sessionID: "parent" } as never,
    )
    expect(result).not.toContain("视觉解读失败")
  })

  test('images: "[last]" (bare unquoted array literal) delegates to lookLatest', async () => {
    const harness = createVisionHarness("sync")
    harness.client.session.messages = async () => ({
      data: [
        { info: { role: "user" }, parts: [{ type: "file", mime: "image/png", url: FAKE_PNG_URL }] },
        { info: { role: "assistant" }, parts: [{ type: "text", text: "解读：裸数组哨兵成功", state: { status: "completed" } }] },
      ],
    })
    const tool = createVisionLookTool(harness.pipeline)
    const result = await tool.execute(
      { images: "[last]" },
      { sessionID: "parent" } as never,
    )
    expect(result).toContain("裸数组哨兵成功")
  })

  // The union schema is the small-model compatibility surface; every execute
  // test bypasses it, so the schema itself needs a parse-level check. The
  // tool schema comes from the plugin-bundled zod (not this package's zod),
  // so parse at the field level instead of importing a second zod instance.
  test("vision_look images schema accepts string and array forms, rejects others", () => {
    const harness = createVisionHarness("sync")
    const tool = createVisionLookTool(harness.pipeline)
    const imagesSchema = (tool.args as unknown as { images: { safeParse(v: unknown): { success: boolean } } }).images
    expect(imagesSchema.safeParse("last").success).toBe(true)
    expect(imagesSchema.safeParse(["last"]).success).toBe(true)
    expect(imagesSchema.safeParse("./a.png").success).toBe(true)
    expect(imagesSchema.safeParse(["last", "./a.png"]).success).toBe(true)
    expect(imagesSchema.safeParse([]).success).toBe(false) // array branch enforces min(1)
    expect(imagesSchema.safeParse(42).success).toBe(false)
    expect(imagesSchema.safeParse(undefined).success).toBe(false) // required
  })
})

describe("chat.message hook (pasted-image hint)", () => {
  function hintHookFor(harness: ReturnType<typeof createVisionHarness>, chatImages: "auto" | "hint" | false = "hint") {
    const tracker = new CurrentModelTracker()
    return {
      tracker,
      hook: createChatMessageHook({
        config: parseConfig({ vision: { mode: "sync", chatImages } }),
        pipeline: harness.pipeline,
        background: harness.background,
        tracker,
      }),
    }
  }

  test("injects a vision_look reminder part for text-only sessions, without interpreting", async () => {
    const harness = createVisionHarness("sync")
    const { hook } = hintHookFor(harness)
    const parts: Array<Record<string, unknown>> = [
      { type: "text", text: "这里有什么" },
      { type: "file", mime: "image/png", url: FAKE_PNG_URL },
    ]
    const before = harness.childSessions.size
    await hook({ sessionID: "parent" }, { parts, message: { id: "msg_1" } } as never)
    const appended = parts[parts.length - 1] as {
      type?: string
      text?: string
      id?: string
      sessionID?: string
      messageID?: string
    }
    expect(parts).toHaveLength(3)
    expect(appended.type).toBe("text")
    expect(appended.text).toContain("请调用 vision_look")
    expect(appended.text).toContain('images: "last"')
    // 1.18.23 part contract: id (prt_ prefix) / sessionID / messageID —
    // missing fields freeze the message save (2026-08-25 incident).
    expect(appended.id).toMatch(/^prt_/)
    expect(appended.sessionID).toBe("parent")
    expect(appended.messageID).toBe("msg_1")
    // hint is zero-blocking: no interpretation child is created.
    expect(harness.childSessions.size).toBe(before)
  })

  test('"auto" (reserved) currently behaves as "hint"', async () => {
    const harness = createVisionHarness("sync")
    const { hook } = hintHookFor(harness, "auto")
    const parts: Array<Record<string, unknown>> = [{ type: "file", mime: "image/png", url: FAKE_PNG_URL }]
    await hook({ sessionID: "parent" }, { parts, message: { id: "msg_1" } } as never)
    expect(parts).toHaveLength(2) // reminder injected
    expect(harness.childSessions.size).toBe(0) // still zero-blocking
  })

  test("vision-capable sessions get no reminder", async () => {
    const harness = createVisionHarness("sync")
    const { tracker, hook } = hintHookFor(harness)
    tracker.onChatParams({
      sessionID: "parent",
      model: { providerID: "openai", id: "gpt-5.6-sol", capabilities: { input: { image: true } } },
    })
    const parts: Array<Record<string, unknown>> = [{ type: "file", mime: "image/png", url: FAKE_PNG_URL }]
    await hook({ sessionID: "parent" }, { parts, message: { id: "msg_1" } } as never)
    expect(parts).toHaveLength(1)
  })

  test("chatImages=false disables the reminder", async () => {
    const harness = createVisionHarness("sync")
    const { hook } = hintHookFor(harness, false)
    const parts: Array<Record<string, unknown>> = [{ type: "file", mime: "image/png", url: FAKE_PNG_URL }]
    await hook({ sessionID: "parent" }, { parts, message: { id: "msg_1" } } as never)
    expect(parts).toHaveLength(1)
  })

  test("background child sessions get no reminder (recursion guard)", async () => {
    const harness = createVisionHarness("sync")
    const { hook } = hintHookFor(harness)
    const task = await harness.background.launch({
      description: "parent task",
      prompt: "work",
      parentSessionId: "parent",
    })
    await new Promise((resolve) => setTimeout(resolve, 100))
    if (!task.sessionId) throw new Error("task never claimed a session")
    const parts: Array<Record<string, unknown>> = [{ type: "file", mime: "image/png", url: FAKE_PNG_URL }]
    await hook({ sessionID: task.sessionId }, { parts, message: { id: "msg_1" } } as never)
    expect(parts).toHaveLength(1)
  })

  // Sync interpretation children are created directly by runVisionInterpretation
  // (outside the background manager) — their injected image message must not
  // get the reminder, or the child would be instructed to vision_look its own
  // image (the accident-1 recursion chain, re-armed by the hint text).
  test("sync interpretation children get no reminder (recursion guard)", async () => {
    const harness = createVisionHarness("sync")
    const { hook } = hintHookFor(harness)
    // Hold an interpretation in flight so its child stays in the guard set.
    let releasePoll!: () => void
    let pollBlocked!: () => void
    const blocked = new Promise<void>((resolve) => (pollBlocked = resolve))
    const releasePromise = new Promise<void>((resolve) => (releasePoll = resolve))
    harness.client.session.messages = async (...args: Parameters<PrismClient["session"]["messages"]>) => {
      const sessionID = args[0]?.path?.id
      if (sessionID !== "parent") {
        pollBlocked()
        await releasePromise
      }
      return {
        data: [
          { info: { role: "user" }, parts: [{ type: "file", mime: "image/png", url: FAKE_PNG_URL }] },
          { info: { role: "assistant" }, parts: [{ type: "text", text: "解读：第一层", state: { status: "completed" } }] },
        ],
      }
    }
    const pending = harness.pipeline.lookLatest("parent")
    await blocked // interpretation child created and now polling

    const childID = Array.from(harness.childSessions.keys())[0]!
    const parts: Array<Record<string, unknown>> = [{ type: "file", mime: "image/png", url: FAKE_PNG_URL }]
    await hook({ sessionID: childID }, { parts, message: { id: "msg_1" } } as never)
    expect(parts).toHaveLength(1) // no reminder injected

    releasePoll()
    await pending
  })

  test("messages without images get no reminder", async () => {
    const harness = createVisionHarness("sync")
    const { hook } = hintHookFor(harness)
    const parts: Array<Record<string, unknown>> = [{ type: "text", text: "纯文字" }]
    await hook({ sessionID: "parent" }, { parts, message: { id: "msg_1" } } as never)
    expect(parts).toHaveLength(1)
  })
})

describe("runVisionInterpretation", () => {
  test("interpretation child disables prism tools to prevent recursion", async () => {
    const { pipeline, childSessions } = createVisionHarness("sync")
    await pipeline.look("parent", [{ mime: "image/png", url: FAKE_PNG_URL }])
    const promptBody = Array.from(childSessions.values())[0]?.prompts[0] as Record<string, unknown>
    const tools = promptBody?.tools as Record<string, boolean> | undefined
    expect(tools?.vision_look).toBe(false)
    expect(tools?.bg_spawn).toBe(false)
    expect(tools?.question).toBe(false)
  })

  test("does not treat a not-yet-busy session as idle (status-map race)", async () => {
    const { runVisionInterpretation } = await import("../src/core/vision/interpreter")
    let statusCalls = 0
    const client: PrismClient = {
      session: {
        get: async () => ({ data: {} }),
        create: async () => ({ data: { id: "vision_child" } }),
        abort: async () => {},
        prompt: async () => {},
        promptAsync: async () => ({ data: {}, error: undefined }),
        // never produces assistant text: the poll must settle via status
        messages: async () => ({ data: [] }),
        status: async () => {
          statusCalls++
          // realistic sequence: startup (promptAsync 204 resolves before the
          // session enters the map) → busy → settled (absent from the map)
          const seq = [undefined, "busy", undefined] as const
          const current = seq[Math.min(statusCalls - 1, seq.length - 1)]
          return { data: current === undefined ? {} : { vision_child: { type: current } } }
        },
      },
      tui: { showToast: async () => {} },
    }

    const result = await runVisionInterpretation({
      client,
      directory: "/work",
      parentSessionID: "parent",
      images: [{ mime: "image/png", url: FAKE_PNG_URL }],
      model: { providerID: "openai", modelID: "gpt-5.6-sol" },
      timeoutMs: 5000,
    })
    expect(result).toEqual({ text: null, reason: "no-output" })
    // must not have aborted on the first (empty-map) poll before the session
    // was ever observed busy
    expect(statusCalls).toBeGreaterThanOrEqual(3)
  })
})
