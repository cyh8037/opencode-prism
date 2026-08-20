import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { lastAssistantText } from "../src/core/assistant-text"
import { extractImageAttachments, extractImageParts } from "../src/core/vision/detector"
import { normalizeImageUrl } from "../src/core/vision/image-utils"
import { createVisionLookTool } from "../src/tools/vision-look"
import { VisionPipeline } from "../src/core/vision/pipeline"
import { CurrentModelTracker, waitForVisionModel } from "../src/core/vision/model-tracker"
import { BackgroundManager } from "../src/core/background/manager"
import { PromptGate } from "../src/core/prompt-gate"
import { parseConfig } from "../src/config/load"
import type { PrismClient } from "../src/core/client-types"

const VISION_MODEL = { providerID: "openai", modelID: "gpt-5.6-sol" }

// The sync vision path fires the gate dispatch without awaiting it (the
// chat.message hook must not be held up), so tests poll for the dispatched
// marker instead of asserting synchronously.
async function waitForRecentDispatch(gate: PromptGate, sessionID: string): Promise<void> {
  const deadline = Date.now() + 1000
  while (Date.now() < deadline) {
    if (gate.hasRecentDispatch(sessionID)) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error("gate never recorded a recent dispatch")
}

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
    const image = await normalizeImageUrl({ mime: "image/png", url: "data:image/png;base64,abc" })
    expect(image?.url).toBe("data:image/png;base64,abc")
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
    getVisionModel: () => VISION_MODEL,
    waitForVisionModel: async () => VISION_MODEL,
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

  test("tool output batches beyond the cap are noted in the output", async () => {
    const { pipeline } = createVisionHarness("sync")
    const output = { title: "screenshot", output: "screenshot taken" }
    const images = Array.from({ length: 5 }, () => ({ mime: "image/png", url: "data:image/png;base64,abc" }))
    await pipeline.onToolOutput({ tool: "screenshot", sessionID: "parent" }, output, images)
    expect(output.output).toContain("[prism vision] 图片解读")
    expect(output.output).toContain("1 张未解读")
  })

  test("background vision tasks suppress tmux panes", async () => {
    const { pipeline, background } = createVisionHarness("background")
    await pipeline.onChatImages("parent", [{ mime: "image/png", url: "data:image/png;base64,abc" }])
    const tasks = background.getTasksByParentSession("parent")
    expect(tasks).toHaveLength(1)
    // Interpretation tasks finish in seconds: no pane (panes are reserved for
    // user-spawned /bg and /split work).
    expect(tasks[0]?.suppressTmux).toBe(true)
    await background.shutdown()
  })

  // A prism child session's injected prompt (vision instruction + image)
  // fires chat.message for the child; auto-interpreting it would spawn a
  // grandchild interpretation, and so on, unbounded.
  test("chat images on a prism child session do not re-trigger interpretation", async () => {
    const { pipeline, background, childSessions } = createVisionHarness("sync")
    const task = await background.launch({ description: "parent task", prompt: "work", parentSessionId: "parent" })
    await new Promise((resolve) => setTimeout(resolve, 100))
    if (!task.sessionId) throw new Error("task never claimed a session")

    const before = childSessions.size
    await pipeline.onChatImages(task.sessionId, [{ mime: "image/png", url: "data:image/png;base64,abc" }])
    expect(childSessions.size).toBe(before) // no grandchild interpretation
    await background.shutdown()
  })

  // Regression for the 2026-08-19 incident: sync-mode interpretation children
  // live outside the BackgroundManager, so the manager-based guard alone did
  // not stop the child's own injected prompt from re-triggering — 1585 nested
  // interpretation sessions were created in seconds and froze the TUI.
  test("chat images on an in-flight sync interpretation child do not re-trigger", async () => {
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

    const pending = pipeline.onChatImages("parent", [{ mime: "image/png", url: "data:image/png;base64,abc" }])
    await blocked // interpretation child (child_1) created and now polling

    const before = childSessions.size
    // The child's own injected prompt fires chat.message for the child:
    await pipeline.onChatImages("child_1", [{ mime: "image/png", url: "data:image/png;base64,abc" }])
    expect(childSessions.size).toBe(before) // no grandchild interpretation

    releasePoll()
    await pending
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
    await waitForRecentDispatch(gate, "parent")
  })

  // Two-phase sync: the chat.message hook returns immediately (message list
  // renders instantly) and messages.transform injects the interpretation into
  // the FIRST LLM call's context — where it belongs — not into the history.
  test("messages.transform injects the interpretation into the outgoing LLM context", async () => {
    const { pipeline } = createVisionHarness("sync")
    await pipeline.onChatImages("parent", [{ mime: "image/png", url: "data:image/png;base64,abc" }], "msg_1")
    const messages = [
      { info: { id: "msg_1", role: "user", sessionID: "parent" }, parts: [{ type: "file", mime: "image/png" }] },
    ]
    await pipeline.onMessagesTransform(messages)
    expect(messages).toHaveLength(2)
    const injected = messages[1] as { info?: { role?: string }; parts?: Array<{ text?: string }> }
    expect(injected?.info?.role).toBe("user")
    expect(injected?.parts?.[0]?.text).toContain("[PRISM VISION] 对话图片解读")
    // Second call: the entry is consumed — nothing new is injected.
    await pipeline.onMessagesTransform(messages)
    expect(messages).toHaveLength(2)
  })

  test("a transform-claimed interpretation does not dispatch a duplicate wake", async () => {
    const { pipeline, gate } = createVisionHarness("sync")
    await pipeline.onChatImages("parent", [{ mime: "image/png", url: "data:image/png;base64,abc" }], "msg_2")
    const messages = [{ info: { id: "msg_2", role: "user", sessionID: "parent" }, parts: [] }]
    await pipeline.onMessagesTransform(messages)
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(gate.hasRecentDispatch("parent")).toBe(false)
  })

  // Regression: the chat.message hook input carries messageID only when the
  // client generates one. When it does not, the committed message id lives on
  // output.message — the hook must key the pending interpretation off that, or
  // the transform can never claim it and the wake fallback double-fires.
  test("chat.message hook keys off output.message.id when input.messageID is absent", async () => {
    const { createChatMessageHook } = await import("../src/hooks/chat-message")
    const harness = createVisionHarness("sync")
    const hook = createChatMessageHook({
      config: harness.config,
      pipeline: harness.pipeline,
      tracker: new CurrentModelTracker(),
    })

    // Realistic runtime shape: no messageID in input, the final id only on
    // output.message (the info object opencode commits).
    const input = { sessionID: "parent" }
    const output = {
      message: { id: "msg_hook1", role: "user" },
      parts: [{ type: "file", mime: "image/png", url: "data:image/png;base64,abc" }],
    }
    await hook(input as never, output as never)

    const messages = [{ info: { id: "msg_hook1", role: "user" }, parts: [] }]
    await harness.pipeline.onMessagesTransform(messages)
    expect(messages).toHaveLength(2)
    const injected = messages[1] as { parts?: Array<{ text?: string }> }
    expect(injected?.parts?.[0]?.text).toContain("[PRISM VISION] 对话图片解读")
  })

  // Regression: sessionID on the transform messages is not guaranteed on
  // every runtime — matching must not depend on it, only on the message id.
  test("messages.transform claims entries even when message info lacks sessionID", async () => {
    const { pipeline } = createVisionHarness("sync")
    await pipeline.onChatImages("parent", [{ mime: "image/png", url: "data:image/png;base64,abc" }], "msg_ns")
    const messages = [{ info: { id: "msg_ns", role: "user" }, parts: [] }]
    await pipeline.onMessagesTransform(messages)
    expect(messages).toHaveLength(2)
    const injected = messages[1] as { parts?: Array<{ text?: string }> }
    expect(injected?.parts?.[0]?.text).toContain("[PRISM VISION] 对话图片解读")
  })

  test("messages.transform injects a failure note when the interpretation fails", async () => {
    const { pipeline, client } = createVisionHarness("sync")
    client.session.create = async () => ({ error: { message: "boom" } }) as never
    await pipeline.onChatImages("parent", [{ mime: "image/png", url: "data:image/png;base64,abc" }], "msg_f")
    const messages = [{ info: { id: "msg_f", role: "user", sessionID: "parent" }, parts: [] }]
    await pipeline.onMessagesTransform(messages)
    expect(messages).toHaveLength(2)
    const injected = messages[1] as { parts?: Array<{ text?: string }> }
    expect(injected?.parts?.[0]?.text).toContain("图片解读失败")
  })

  test("messages.transform skips prism child session contexts", async () => {
    const { pipeline, background } = createVisionHarness("sync")
    const task = await background.launch({ description: "parent task", prompt: "work", parentSessionId: "parent" })
    await new Promise((resolve) => setTimeout(resolve, 100))
    if (!task.sessionId) throw new Error("task never claimed a session")
    const messages = [{ info: { id: "msg_c", role: "user", sessionID: task.sessionId }, parts: [] }]
    await pipeline.onMessagesTransform(messages)
    expect(messages).toHaveLength(1) // nothing injected for a child session
    await background.shutdown()
  })

  test("unavailable vision model skips sync interpretation without creating a child session", async () => {
    const harness = createVisionHarness("sync")
    const noModelPipeline = new VisionPipeline({
      client: harness.client,
      directory: "/work",
      config: harness.config,
      gate: harness.gate,
      background: harness.background,
      getVisionModel: () => undefined,
      waitForVisionModel: async () => undefined,
    })
    const output = { title: "screenshot", output: "taken" }
    await noModelPipeline.onToolOutput(
      { tool: "screenshot", sessionID: "parent" },
      output,
      [{ mime: "image/png", url: "data:image/png;base64,abc" }],
    )
    // fully skipped: output untouched AND no child session was ever created
    expect(output.output).toBe("taken")
    expect(harness.childSessions.size).toBe(0)
  })

  test("unavailable vision model skips background task launch", async () => {
    const harness = createVisionHarness("background")
    const noModelPipeline = new VisionPipeline({
      client: harness.client,
      directory: "/work",
      config: harness.config,
      gate: harness.gate,
      background: harness.background,
      getVisionModel: () => undefined,
      waitForVisionModel: async () => undefined,
    })
    await noModelPipeline.onChatImages("parent", [{ mime: "image/png", url: "data:image/png;base64,abc" }])
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(harness.background.getTasksByParentSession("parent")).toHaveLength(0)
  })

  test("chat images wait for the session's first capability snapshot (recalled image in a new session)", async () => {
    const harness = createVisionHarness("sync")
    let snapshotWaited = false
    const pipeline = new VisionPipeline({
      client: harness.client,
      directory: "/work",
      config: harness.config,
      gate: harness.gate,
      background: harness.background,
      getVisionModel: () => undefined, // no snapshot yet at chat.message time
      waitForVisionModel: async () => {
        // the session's first chat.params arrives shortly after the message
        await new Promise((resolve) => setTimeout(resolve, 100))
        snapshotWaited = true
        return VISION_MODEL
      },
    })
    // Two-phase: onChatImages returns immediately; the snapshot wait and the
    // interpretation run in the background (messages.transform will claim the
    // result). Poll for the eventual child session.
    await pipeline.onChatImages("parent", [{ mime: "image/png", url: "data:image/png;base64,abc" }], "msg_snap")
    const deadline = Date.now() + 1000
    while (Date.now() < deadline && !(snapshotWaited && harness.childSessions.size === 1)) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(snapshotWaited).toBe(true)
    expect(harness.childSessions.size).toBe(1)
  })

  test("chat images skip when no snapshot ever arrives", async () => {
    const harness = createVisionHarness("sync")
    const pipeline = new VisionPipeline({
      client: harness.client,
      directory: "/work",
      config: harness.config,
      gate: harness.gate,
      background: harness.background,
      getVisionModel: () => undefined,
      waitForVisionModel: async () => {
        await new Promise((resolve) => setTimeout(resolve, 50))
        return undefined
      },
    })
    await pipeline.onChatImages("parent", [{ mime: "image/png", url: "data:image/png;base64,abc" }], "msg_none")
    // The background model resolution settles (no model) — nothing created.
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(harness.childSessions.size).toBe(0)
  })

  test("background vision pins the gate-checked model into the launch", async () => {
    const harness = createVisionHarness("background")
    const pinnedModel = { providerID: "openai", modelID: "gpt-5.6-sol" }
    const pipeline = new VisionPipeline({
      client: harness.client,
      directory: "/work",
      config: harness.config,
      gate: harness.gate,
      background: harness.background,
      getVisionModel: () => pinnedModel,
      waitForVisionModel: async () => pinnedModel,
    })
    await pipeline.onChatImages("parent", [{ mime: "image/png", url: "data:image/png;base64,abc" }])
    await new Promise((resolve) => setTimeout(resolve, 100))
    const tasks = harness.background.getTasksByParentSession("parent")
    expect(tasks).toHaveLength(1)
    const child = Array.from(harness.childSessions.values())[0]
    // the child session was created with the pinned model (create uses the
    // { id, providerID } shape; the prompt body uses { providerID, modelID })
    expect(child?.createdModel).toEqual({ id: "gpt-5.6-sol", providerID: "openai" })
    const promptBody = child?.prompts[0] as Record<string, unknown> | undefined
    expect(promptBody?.model).toEqual({ providerID: "openai", modelID: "gpt-5.6-sol" })
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
      getVisionModel: () => undefined,
      waitForVisionModel: async () => undefined,
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

  test("vision_look with no vision model returns failure text without throwing", async () => {
    const harness = createVisionHarness("sync")
    const noModelPipeline = new VisionPipeline({
      client: harness.client,
      directory: "/work",
      config: harness.config,
      gate: harness.gate,
      background: harness.background,
      getVisionModel: () => undefined,
      waitForVisionModel: async () => undefined,
    })
    const tool = createVisionLookTool(noModelPipeline)
    const result = await tool.execute({ images: ["https://x/1.png"] }, { sessionID: "parent" } as never)
    expect(result).toContain("视觉解读失败")
  })
})

describe("createChatMessageHook", () => {
  test("extracts images from the output argument (parts live in output, not input)", async () => {
    const { createChatMessageHook } = await import("../src/hooks/chat-message")
    const { CurrentModelTracker } = await import("../src/core/vision/model-tracker")

    const harness = createVisionHarness("sync")
    const tracker = new CurrentModelTracker()
    const hook = createChatMessageHook({
      config: harness.config,
      pipeline: harness.pipeline,
      tracker,
    })

    // The runtime calls hooks with (input, output); input carries only
    // sessionID/agent/model/messageID/variant — parts arrive in output.
    const input = {
      sessionID: "parent",
      model: { providerID: "openai", modelID: "gpt-5.6-sol" },
      // no parts key — matches the real input contract
    }
    const output = {
      message: { role: "user" },
      parts: [
        { type: "text", text: "look at this" },
        { type: "file", mime: "image/png", url: "data:image/png;base64,abc" },
      ],
    }
    await hook(input as never, output as never)

    // the tracker learned the session model from input
    expect(tracker.get("parent")?.model).toEqual({ providerID: "openai", modelID: "gpt-5.6-sol" })
    // the image in output.parts triggered an interpretation (gate has a recent dispatch)
    await waitForRecentDispatch(harness.gate, "parent")
  })

  test("input-side parts (the old contract) trigger nothing", async () => {
    const { createChatMessageHook } = await import("../src/hooks/chat-message")
    const { CurrentModelTracker } = await import("../src/core/vision/model-tracker")

    const harness = createVisionHarness("sync")
    const hook = createChatMessageHook({
      config: harness.config,
      pipeline: harness.pipeline,
      tracker: new CurrentModelTracker(),
    })

    const input = {
      sessionID: "parent",
      parts: [{ type: "file", mime: "image/png", url: "data:image/png;base64,abc" }],
    }
    await hook(input as never, { message: {}, parts: [] })

    expect(harness.gate.hasRecentDispatch("parent")).toBe(false)
  })
})

describe("runVisionInterpretation", () => {
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
      images: [{ mime: "image/png", url: "data:image/png;base64,abc" }],
      model: { providerID: "openai", modelID: "gpt-5.6-sol" },
      timeoutMs: 5000,
    })
    expect(result).toBeNull()
    // must not have aborted on the first (empty-map) poll before the session
    // was ever observed busy
    expect(statusCalls).toBeGreaterThanOrEqual(3)
  })
})

describe("waitForVisionModel", () => {
  const VISION_MODEL_REF = { providerID: "vision-pro", modelID: "vision-model" }
  const SESSION_MODEL_REF = { providerID: "openai", modelID: "gpt-5.6-sol" }

  // Regression: chat images on a non-vision main session used to be skipped
  // even when vision.model was configured — the wait path only consulted the
  // session model's capability snapshot and ignored the explicit model.
  test("a configured vision model wins immediately, even when the session model cannot see images", async () => {
    const tracker = new CurrentModelTracker()
    tracker.onChatParams({
      sessionID: "s",
      model: { providerID: "deepseek", id: "deepseek-v4-flash", capabilities: { input: { image: false } } },
    })
    const model = await waitForVisionModel({
      visionModel: VISION_MODEL_REF,
      visionRefInvalid: false,
      tracker,
      sessionID: "s",
      timeoutMs: 5000,
    })
    expect(model).toEqual(VISION_MODEL_REF)
  })

  test("an invalid vision reference stays off", async () => {
    const tracker = new CurrentModelTracker()
    const model = await waitForVisionModel({
      visionModel: undefined,
      visionRefInvalid: true,
      tracker,
      sessionID: "s",
      timeoutMs: 100,
    })
    expect(model).toBeUndefined()
  })

  test("without a configured model, a vision-capable snapshot inherits the session model", async () => {
    const tracker = new CurrentModelTracker()
    tracker.onChatParams({
      sessionID: "s",
      model: { providerID: "openai", id: "gpt-5.6-sol", capabilities: { input: { image: true } } },
    })
    const model = await waitForVisionModel({
      visionModel: undefined,
      visionRefInvalid: false,
      tracker,
      sessionID: "s",
      timeoutMs: 1000,
    })
    expect(model).toEqual(SESSION_MODEL_REF)
  })

  test("without a configured model, a non-vision snapshot yields undefined", async () => {
    const tracker = new CurrentModelTracker()
    tracker.onChatParams({
      sessionID: "s",
      model: { providerID: "deepseek", id: "deepseek-v4-flash", capabilities: { input: { image: false } } },
    })
    const model = await waitForVisionModel({
      visionModel: undefined,
      visionRefInvalid: false,
      tracker,
      sessionID: "s",
      timeoutMs: 1000,
    })
    expect(model).toBeUndefined()
  })

  test("without a snapshot arriving in time, yields undefined after the timeout", async () => {
    const tracker = new CurrentModelTracker()
    const started = Date.now()
    const model = await waitForVisionModel({
      visionModel: undefined,
      visionRefInvalid: false,
      tracker,
      sessionID: "s",
      timeoutMs: 120,
    })
    expect(model).toBeUndefined()
    expect(Date.now() - started).toBeGreaterThanOrEqual(100)
  })
})
