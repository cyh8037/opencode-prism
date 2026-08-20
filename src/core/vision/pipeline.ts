import { MAX_IMAGES_PER_BATCH, VISION_SNAPSHOT_WAIT_MS, VISION_TRANSFORM_WAIT_MS } from "../../config/constants"
import type { PrismConfig } from "../../config/schema"
import type { ResolvedModel } from "../../models"
import { log } from "../../shared/log"
import type { BackgroundManager } from "../background/manager"
import type { PrismClient } from "../client-types"
import type { PromptGate } from "../prompt-gate"
import type { ImageAttachment } from "./detector"
import { runVisionInterpretation, VISION_INSTRUCTION, VISION_SYSTEM_PROMPT } from "./interpreter"

// The model a vision interpretation should use for a session: the explicit
// vision.model, or the session's current model when it is image-capable.
// Returns undefined when vision is unavailable (invalid config, or the
// session model cannot see images) — triggers skip in that case.
export type GetVisionModelFn = (sessionID: string) => ResolvedModel | undefined

export interface VisionPipelineDeps {
  client: PrismClient
  directory: string
  config: PrismConfig
  gate: PromptGate
  background: BackgroundManager
  getVisionModel: GetVisionModelFn
  /** Like getVisionModel, but waits up to timeoutMs for the session's first
   *  capability snapshot (chat.message fires before chat.params). */
  waitForVisionModel: (sessionID: string, timeoutMs: number) => Promise<ResolvedModel | undefined>
  logger?: typeof log
}

interface PendingInterpretation {
  sessionID: string
  /** Resolves with the interpretation text (null on failure/unavailable). */
  promise: Promise<string | null>
  /** Set when messages.transform starts waiting on this entry — the wake
   *  fallback must not also dispatch once the transform owns the result. */
  claimed: boolean
  /** Batch-over-cap note appended to the injected text. */
  note: string
}

export class VisionPipeline {
  private logger: typeof log
  /** Sync-mode interpretation child sessions still in flight. Their own
   *  injected prompt (instruction + image) fires chat.message for them; the
   *  guard in onChatImages must know they are interpretation children or the
   *  auto-trigger would recurse into an unbounded chain of children. */
  private interpretationSessions = new Set<string>()
  /** Background chat-image interpretations awaiting consumption by
   *  messages.transform, keyed by the user message id. */
  private pendingInterpretations = new Map<string, PendingInterpretation>()

  constructor(private deps: VisionPipelineDeps) {
    this.logger = deps.logger ?? log
  }

  // Single configured model with one same-model retry on failure. No provider
  // switching: the model reference is explicit and unavailability degrades
  // gracefully (images stay in the main context).
  private async interpretWithFallback(
    parentSessionID: string,
    images: ImageAttachment[],
    modelOverride?: ResolvedModel,
  ): Promise<string | null> {
    const model = modelOverride ?? this.deps.getVisionModel(parentSessionID)
    if (!model) {
      this.logger("[prism] vision: no vision model available (invalid config or session model not image-capable), skipping", {
        parentSessionID,
      })
      return null
    }

    for (let attempt = 0; attempt <= 1; attempt++) {
      // Track this call's children so the auto-trigger guard can see them
      // while the interpretation is in flight (the recursion window).
      const createdThisCall: string[] = []
      let text: string | null = null
      try {
        text = await runVisionInterpretation({
          client: this.deps.client,
          directory: this.deps.directory,
          parentSessionID,
          images,
          model,
          onSessionCreated: (sessionID) => {
            this.interpretationSessions.add(sessionID)
            createdThisCall.push(sessionID)
          },
        })
      } catch (error) {
        this.logger("[prism] vision: interpretation threw", { model, error })
      }
      for (const sessionID of createdThisCall) {
        this.interpretationSessions.delete(sessionID)
      }
      if (text !== null) return text

      this.logger("[prism] vision: interpretation failed, retrying with the same model", {
        model,
        attempt: attempt + 1,
      })
    }
    return null
  }

  // Cap the batch at MAX_IMAGES_PER_BATCH. Extras are dropped with a log AND
  // a visible note (the caller appends it to the tool output or the wake
  // text) so the model/user know some images were not interpreted.
  private capBatch(images: ImageAttachment[]): { batch: ImageAttachment[]; dropped: number } {
    const batch = images.slice(0, MAX_IMAGES_PER_BATCH)
    const dropped = images.length - batch.length
    if (dropped > 0) {
      this.logger("[prism] vision: image batch exceeds MAX_IMAGES_PER_BATCH, dropping extras", {
        images: images.length,
        sent: batch.length,
      })
    }
    return { batch, dropped }
  }

  // Queue an interpretation for a parent session. Each call runs its own
  // interpretation: merging into an in-flight batch is unsound — the batch is
  // already sent to the model by the time a second caller arrives, so merged
  // images would be silently dropped while the second caller still received
  // the first batch's text. The batch is capped with a note instead.
  private enqueue(parentSessionID: string, images: ImageAttachment[]): { text: Promise<string | null>; dropped: number } {
    const { batch, dropped } = this.capBatch(images)
    return { text: this.interpretWithFallback(parentSessionID, batch), dropped }
  }

  // Trigger A: tool output containing image attachments. Sync mode appends the
  // interpretation to the tool output; background mode spawns a vision task.
  async onToolOutput(
    input: { tool: string; sessionID: string },
    output: { title: string; output: string },
    images: ImageAttachment[],
  ): Promise<void> {
    if (images.length === 0) return
    const mode = this.deps.config.vision.mode

    if (mode === "background") {
      // Tool outputs always follow an LLM call, so the capability snapshot
      // already exists — the sync gate is enough.
      const model = this.deps.getVisionModel(input.sessionID)
      if (model) {
        const { batch, dropped } = this.capBatch(images)
        this.launchBackgroundTask(input.sessionID, batch, `tool output from ${input.tool}`, model, dropped)
      }
      return
    }

    const { text: textPromise, dropped } = this.enqueue(input.sessionID, images)
    const text = await textPromise
    if (text === null) {
      log("[prism] vision: interpretation unavailable, leaving image in main context")
      return
    }
    output.output += `\n\n[prism vision] 图片解读（${input.tool}）:\n${text}`
    if (dropped > 0) {
      output.output += `\n\n[prism vision] 注意: 本次共收到 ${images.length} 张图片，超出批量上限（${MAX_IMAGES_PER_BATCH}），有 ${dropped} 张未解读。`
    }
  }

  // Trigger B: user attached images in chat. chat.message fires BEFORE the
  // session's first chat.params, so a fresh session (e.g. an image recalled
  // from another session's history) may not have a capability snapshot yet —
  // wait briefly for it before deciding.
  async onChatImages(sessionID: string, images: ImageAttachment[], messageID?: string): Promise<void> {
    if (images.length === 0) return
    // A prism child session's injected prompt carries its own image (vision
    // instruction + file parts), which would otherwise re-trigger auto
    // interpretation inside the interpretation session — recursing into an
    // unbounded chain of child sessions. This covers BOTH manager-launched
    // tasks (bg/vision background) and in-flight sync-mode interpretation
    // sessions, which live outside the manager.
    if (this.deps.background.isChildSession(sessionID) || this.interpretationSessions.has(sessionID)) return
    const mode = this.deps.config.vision.mode

    const { batch, dropped } = this.capBatch(images)

    if (mode === "background") {
      const model = await this.deps.waitForVisionModel(sessionID, VISION_SNAPSHOT_WAIT_MS)
      if (model) this.launchBackgroundTask(sessionID, batch, "chat images", model, dropped)
      return
    }

    // Sync mode, two-phase. The chat.message hook blocks the message commit,
    // so it must return immediately: the interpretation (including the model
    // resolution — snapshot wait can take up to 3s in inherit mode) runs in
    // the background, and messages.transform injects the result into the
    // FIRST LLM call's context, where it belongs.
    const promise = (async (): Promise<string | null> => {
      const model = await this.deps.waitForVisionModel(sessionID, VISION_SNAPSHOT_WAIT_MS)
      if (!model) {
        log("[prism] vision: no usable vision model after waiting for the session snapshot")
        return null
      }
      return this.interpretWithFallback(sessionID, batch, model)
    })()

    if (messageID) {
      log("[prism] vision: interpretation queued for transform injection", { sessionID, messageID, images: batch.length })
      this.interpretInBackground(sessionID, messageID, promise, dropped)
      return
    }
    // No messageID (defensive): nothing to tie the transform injection to —
    // fall back to the legacy gate wake, delivered to the session history.
    void promise.then((text) => {
      if (text === null) {
        log("[prism] vision: interpretation unavailable for chat images")
        return
      }
      const dropNote = dropped > 0 ? `\n（另有 ${dropped} 张图片因超出批量上限未解读）` : ""
      void this.deps.gate
        .dispatch({
          sessionID,
          source: "vision-interpretation",
          text: `<system-reminder>\n[PRISM VISION] 对话图片解读:\n${text}${dropNote}\n</system-reminder>`,
        })
        .catch((error) => {
          log("[prism] vision wake dispatch failed", { sessionID, error })
        })
    })
  }

  // Register a background interpretation so messages.transform can claim it.
  // If the transform never fires for this message (aborted turn, unsupported
  // version), the completion handler dispatches the legacy gate wake instead,
  // so the interpretation still reaches the session.
  private interpretInBackground(
    sessionID: string,
    messageID: string,
    promise: Promise<string | null>,
    dropped: number,
  ): void {
    const entry: PendingInterpretation = {
      sessionID,
      promise,
      claimed: false,
      note: dropped > 0 ? `\n（另有 ${dropped} 张图片因超出批量上限未解读）` : "",
    }
    this.pendingInterpretations.set(messageID, entry)

    void promise.then((text) => {
      // A claimed entry is owned by onMessagesTransform (injected or timed
      // out there); an already-removed entry means the same. Only the
      // unclaimed path dispatches the wake.
      if (this.pendingInterpretations.get(messageID) !== entry || entry.claimed) return
      this.pendingInterpretations.delete(messageID)
      if (text === null) {
        log("[prism] vision: interpretation unavailable for chat images")
        return
      }
      void this.deps.gate
        .dispatch({
          sessionID,
          source: "vision-interpretation",
          text: `<system-reminder>\n[PRISM VISION] 对话图片解读:\n${text}${entry.note}\n</system-reminder>`,
        })
        .catch((error) => {
          log("[prism] vision wake dispatch failed", { sessionID, error })
        })
    })
  }

  // experimental.chat.messages.transform hook body. Fires right before every
  // LLM call with the outgoing message array. Waits out (bounded) the pending
  // interpretation of each image message in the context and injects the
  // result as a synthetic user message — the interpretation reaches the model
  // without ever living in the session history.
  async onMessagesTransform(
    messages: Array<{ info?: Record<string, unknown>; parts?: Array<Record<string, unknown>> }>,
  ): Promise<void> {
    if (messages.length === 0) return
    const sessionID = messages[0]?.info?.sessionID
    if (typeof sessionID === "string") {
      // Child sessions' own LLM calls carry injected image prompts — never
      // block or inject there (also covers in-flight sync interpretations).
      if (this.deps.background.isChildSession(sessionID) || this.interpretationSessions.has(sessionID)) return
    }

    // Match purely by message id: message ids are globally unique, and the
    // hook input's sessionID (messages[0].info.sessionID) is not guaranteed
    // to be present on every runtime — requiring it would silently disable
    // injection exactly when the entry is unclaimed.
    let matched = false
    for (const msg of messages) {
      const id = msg.info?.id
      if (typeof id !== "string") continue
      const entry = this.pendingInterpretations.get(id)
      if (!entry) continue
      matched = true
      entry.claimed = true
      const text = await Promise.race([
        entry.promise,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), VISION_TRANSFORM_WAIT_MS)),
      ])
      this.pendingInterpretations.delete(id)
      this.logger("[prism] vision: interpretation injected into LLM context", {
        sessionID,
        messageID: id,
        ok: text !== null,
      })
      const content =
        text !== null
          ? `<system-reminder>\n[PRISM VISION] 对话图片解读:\n${text}${entry.note}\n</system-reminder>`
          : "[PRISM VISION] 图片解读失败（无可用视觉模型或解读超时）。当前会话模型无法直接读取图片内容，请向用户说明，或建议改用支持图片的模型。"
      messages.push({
        info: { id: `prism-vision-${id}`, role: "user", sessionID },
        parts: [{ type: "text", text: content, synthetic: true }],
      })
    }
    // Diagnostic: entries are pending but this LLM context carried none of
    // them — the wake fallback is about to double-fire a second turn.
    if (!matched && this.pendingInterpretations.size > 0) {
      this.logger("[prism] vision: transform fired but no pending interpretation matched", {
        sessionID,
        messages: messages.length,
        pending: this.pendingInterpretations.size,
      })
    }
  }

  // Manual path used by the vision_look tool: interpret and return text.
  look(sessionID: string, images: ImageAttachment[]): Promise<string | null> {
    return this.interpretWithFallback(sessionID, images)
  }

  // Callers gate BEFORE this: without a usable model the task would run
  // text-only (opencode silently drops image parts on non-vision models).
  private launchBackgroundTask(
    sessionID: string,
    images: ImageAttachment[],
    source: string,
    model: ResolvedModel,
    dropped = 0,
  ): void {
    const parts: Array<Record<string, unknown>> = [
      { type: "text", text: VISION_INSTRUCTION, synthetic: true },
      ...images.map((image) => ({ type: "file", mime: image.mime, url: image.url })),
    ]
    const dropNote = dropped > 0 ? `（另有 ${dropped} 张图片因超出批量上限未解读）` : ""
    void this.deps.background
      .launch({
        description: `视觉解读 (${images.length} 张图片, ${source})${dropNote}`,
        prompt: VISION_INSTRUCTION,
        parts,
        system: VISION_SYSTEM_PROMPT,
        parentSessionId: sessionID,
        // Pin the gate-checked model: the child must use exactly the model
        // we verified can see images, not a freshly re-resolved one.
        model,
        // Interpretation tasks finish in seconds — a pane would flash and
        // burn TMUX_MAX_AGENT_PANES on work the user did not ask to watch.
        suppressTmux: true,
      })
      .catch((error) => {
        this.logger("[prism] vision: background task launch failed", { error })
      })
  }
}
