import { describe, expect, test } from "bun:test"
import { extractImageAttachments, extractImageParts } from "../src/core/vision/detector"
import { normalizeImageUrl } from "../src/core/vision/image-utils"
import { VisionPipeline } from "../src/core/vision/pipeline"
import { BackgroundManager } from "../src/core/background/manager"
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

describe("normalizeImageUrl", () => {
  test("passes data URLs through", async () => {
    const image = await normalizeImageUrl({ mime: "image/png", url: "data:image/png;base64,abc" })
    expect(image?.url).toBe("data:image/png;base64,abc")
  })

  test("converts remote URLs to data URLs", async () => {
    globalThis.fetch = (async () =>
      new Response(new Uint8Array([1, 2, 3]), { status: 200 })) as unknown as typeof fetch
    const image = await normalizeImageUrl({ mime: "image/png", url: "https://x/1.png" })
    expect(image?.url.startsWith("data:image/png;base64,")).toBe(true)
  })

  test("drops failed fetches", async () => {
    globalThis.fetch = (async () => new Response("nope", { status: 404 })) as unknown as typeof fetch
    const image = await normalizeImageUrl({ mime: "image/png", url: "https://x/404.png" })
    expect(image).toBeNull()
  })
})

function createVisionHarness(mode: "sync" | "background" = "sync") {
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
    gate,
    background,
    resolveVisionModel: () => VISION_MODEL,
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
      [{ mime: "image/png", url: "data:image/png;base64,abc" }],
    )
    expect(output.output).toContain("[prism vision]")
    expect(output.output).toContain("登录页截图")
  })

  test("vision child session uses the configured model and carries the system prompt", async () => {
    const { pipeline, childSessions } = createVisionHarness("sync")
    await pipeline.onToolOutput(
      { tool: "screenshot", sessionID: "parent" },
      { title: "s", output: "taken" },
      [{ mime: "image/png", url: "data:image/png;base64,abc" }],
    )
    const child = Array.from(childSessions.values())[0]
    expect(child?.createdModel).toEqual({ id: "gpt-5.6-sol", providerID: "openai" })
    const promptBody = child?.prompts[0] as Record<string, unknown>
    expect(promptBody?.system).toContain("视觉分析专家")
    expect(promptBody?.system).toContain("结构固定")
  })

  test("sync mode injects chat-image interpretation via the gate", async () => {
    const { pipeline, gate } = createVisionHarness("sync")
    await pipeline.onChatImages("parent", [{ mime: "image/png", url: "data:image/png;base64,abc" }])
    expect(gate.hasRecentDispatch("parent")).toBe(true)
  })

  test("background mode launches a vision background task with the system prompt", async () => {
    const { pipeline, background, childSessions } = createVisionHarness("background")
    await pipeline.onChatImages("parent", [{ mime: "image/png", url: "data:image/png;base64,abc" }])
    await new Promise((resolve) => setTimeout(resolve, 100))
    const tasks = background.getTasksByParentSession("parent")
    expect(tasks).toHaveLength(1)
    const promptBody = Array.from(childSessions.values())[0]?.prompts[0] as Record<string, unknown> | undefined
    expect(promptBody?.system).toContain("视觉分析专家")
  })

  test("no vision model configured degrades gracefully", async () => {
    const harness = createVisionHarness("sync")
    const noModelPipeline = new VisionPipeline({
      client: harness.client,
      directory: "/work",
      config: harness.config,
      gate: harness.gate,
      background: harness.background,
      resolveVisionModel: () => undefined,
    })
    const output = { title: "screenshot", output: "taken" }
    await noModelPipeline.onToolOutput(
      { tool: "screenshot", sessionID: "parent" },
      output,
      [{ mime: "image/png", url: "data:image/png;base64,abc" }],
    )
    // graceful: output untouched, no crash
    expect(output.output).toBe("taken")
  })
})
