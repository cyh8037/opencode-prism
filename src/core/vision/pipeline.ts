import { MAX_IMAGES_PER_BATCH, VISION_SYNC_TIMEOUT_MS } from "../../config/constants"
import type { PrismConfig } from "../../config/schema"
import type { ResolvedModel } from "../../models"
import { log } from "../../shared/log"
import type { BackgroundManager } from "../background/manager"
import type { PrismClient } from "../client-types"
import type { ImageAttachment } from "./detector"
import { extractImageParts } from "./detector"
import { makeVisionInstruction, runVisionInterpretation, VISION_SYSTEM_PROMPT } from "./interpreter"

// The model a vision interpretation should use for a session: the explicit
// vision.model, or the session's current model when it is image-capable.
// Returns undefined when vision is unavailable (invalid config, or the
// session model cannot see images) — triggers skip in that case.
export type GetVisionModelFn = (sessionID: string) => ResolvedModel | undefined

export interface VisionPipelineDeps {
  client: PrismClient
  directory: string
  config: PrismConfig
  background: BackgroundManager
  getVisionModel: GetVisionModelFn
  /** Per-attempt interpretation timeout (tests inject short values). */
  interpretTimeoutMs?: number
  logger?: typeof log
}

export class VisionPipeline {
  private logger: typeof log
  /** Sync-mode interpretation child sessions still in flight. A prism child
   *  session's own tool output could carry images; the trigger must know they
   *  belong to an interpretation child or it would recurse into an unbounded
   *  chain of children. */
  private interpretationSessions = new Set<string>()

  constructor(private deps: VisionPipelineDeps) {
    this.logger = deps.logger ?? log
  }

  // Single configured model with one same-model retry on FAST failure
  // (session create/prompt rejected, no output). A timeout is NOT retried:
  // the model or network is slow, and a second attempt would only block the
  // caller (agent loop or command hook) for another full window.
  private async interpretWithFallback(
    parentSessionID: string,
    images: ImageAttachment[],
    goal?: string,
  ): Promise<string | null> {
    const model = this.deps.getVisionModel(parentSessionID)
    if (!model) {
      this.logger("[prism] vision: no vision model available (invalid config or session model not image-capable), skipping", {
        parentSessionID,
      })
      return null
    }
    const instruction = makeVisionInstruction(goal)

    for (let attempt = 0; attempt <= 1; attempt++) {
      // Track this call's children so the trigger guard can see them while
      // the interpretation is in flight (the recursion window).
      const createdThisCall: string[] = []
      let outcome: { text: string | null; timedOut: boolean } = { text: null, timedOut: false }
      try {
        outcome = await runVisionInterpretation({
          client: this.deps.client,
          directory: this.deps.directory,
          parentSessionID,
          images,
          model,
          instruction,
          timeoutMs: this.deps.interpretTimeoutMs ?? VISION_SYNC_TIMEOUT_MS,
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
      if (outcome.text !== null) return outcome.text
      if (outcome.timedOut) {
        this.logger("[prism] vision: interpretation timed out, not retrying", { model })
        return null
      }

      this.logger("[prism] vision: interpretation failed fast, retrying with the same model", {
        model,
        attempt: attempt + 1,
      })
    }
    return null
  }

  // Cap the batch at MAX_IMAGES_PER_BATCH. Extras are dropped with a log AND
  // a visible note (the caller appends it to the tool output) so the
  // model/user know some images were not interpreted.
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

  // Trigger: tool output containing image attachments (screenshot tools,
  // image reads). Sync mode appends the interpretation to the tool output;
  // background mode spawns a vision task. Tool outputs are part of the
  // session history, so the interpretation persists either way.
  async onToolOutput(
    input: { tool: string; sessionID: string },
    output: { title: string; output: string },
    images: ImageAttachment[],
  ): Promise<void> {
    if (images.length === 0) return
    // A prism child session's own tool output must not re-trigger an
    // interpretation — that would recurse into an unbounded chain of children.
    if (this.deps.background.isChildSession(input.sessionID) || this.interpretationSessions.has(input.sessionID)) {
      return
    }
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

    const { batch, dropped } = this.capBatch(images)
    const text = await this.interpretWithFallback(input.sessionID, batch)
    if (text === null) {
      log("[prism] vision: interpretation unavailable, leaving image in main context")
      return
    }
    output.output += `\n\n[prism vision] 图片解读（${input.tool}）:\n${text}`
    if (dropped > 0) {
      output.output += `\n\n[prism vision] 注意: 本次共收到 ${images.length} 张图片，超出批量上限（${MAX_IMAGES_PER_BATCH}），有 ${dropped} 张未解读。`
    }
  }

  // Manual path used by the vision_look tool and the /vision command:
  // interpret explicit images (optionally with a goal) and return the text.
  look(sessionID: string, images: ImageAttachment[], goal?: string): Promise<string | null> {
    return this.interpretWithFallback(sessionID, images, goal)
  }

  // Manual path for the "last" sentinel: interpret the most recent image
  // message of the session. This is the bridge for pasted chat images when
  // the main model cannot see them and has no way to reference their URL.
  async lookLatest(sessionID: string, goal?: string): Promise<{ text: string | null; notFound: boolean }> {
    let messages: unknown
    try {
      const response = await this.deps.client.session.messages({
        path: { id: sessionID },
        query: { directory: this.deps.directory },
      })
      messages = response.data
    } catch (error) {
      this.logger("[prism] vision: failed to fetch session messages for 'last'", { sessionID, error })
      return { text: null, notFound: true }
    }
    if (Array.isArray(messages)) {
      for (let i = messages.length - 1; i >= 0; i--) {
        const parts = (messages[i] as { parts?: unknown }).parts
        const images = extractImageParts(parts)
        if (images.length > 0) {
          const { batch } = this.capBatch(images)
          const text = await this.interpretWithFallback(sessionID, batch, goal)
          return { text, notFound: false }
        }
      }
    }
    return { text: null, notFound: true }
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
      { type: "text", text: makeVisionInstruction(), synthetic: true },
      ...images.map((image) => ({ type: "file", mime: image.mime, url: image.url })),
    ]
    const dropNote = dropped > 0 ? `（另有 ${dropped} 张图片因超出批量上限未解读）` : ""
    void this.deps.background
      .launch({
        description: `视觉解读 (${images.length} 张图片, ${source})${dropNote}`,
        prompt: makeVisionInstruction(),
        parts,
        system: VISION_SYSTEM_PROMPT,
        parentSessionId: sessionID,
        // Pin the gate-checked model: the child must use exactly the model
        // we verified can see images, not a freshly re-resolved one.
        model,
      })
      .catch((error) => {
        this.logger("[prism] vision: background task launch failed", { error })
      })
  }
}
