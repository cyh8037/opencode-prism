import { z } from "zod"
import { SUPPORTED_IMAGE_MIMES } from "../../config/constants"

export interface ImageAttachment {
  mime: string
  url: string
  filename?: string
}

// Tolerant per-entry parsing: unrecognized entries are skipped (never fail
// the whole list), mime is normalized to lowercase before the whitelist
// check, and a non-string filename is dropped rather than rejecting the
// attachment.
const imageRefFields = {
  mime: z.string().transform((mime) => mime.toLowerCase()),
  url: z.string(),
}

const imageAttachmentSchema = z
  .object({ ...imageRefFields, filename: z.string().optional().catch(undefined) })
  .refine((value) => SUPPORTED_IMAGE_MIMES.has(value.mime))

const imageFilePartSchema = z
  .object({ type: z.literal("file"), ...imageRefFields })
  .refine((value) => SUPPORTED_IMAGE_MIMES.has(value.mime))

// Extract image attachments from a tool result output object.
export function extractImageAttachments(output: Record<string, unknown>): ImageAttachment[] {
  if (!Array.isArray(output.attachments)) return []

  const attachments: ImageAttachment[] = []
  for (const attachmentValue of output.attachments) {
    const parsed = imageAttachmentSchema.safeParse(attachmentValue)
    if (parsed.success) attachments.push(parsed.data)
  }
  return attachments
}

// Extract image file parts from a session message (lookLatest scans session
// history for these). OpenCode represents images as file parts:
// { type: "file", mime: "image/png", url: ... }.
export function extractImageParts(parts: unknown): ImageAttachment[] {
  if (!Array.isArray(parts)) return []
  const images: ImageAttachment[] = []
  for (const part of parts) {
    const parsed = imageFilePartSchema.safeParse(part)
    if (parsed.success) images.push({ mime: parsed.data.mime, url: parsed.data.url })
  }
  return images
}

// Best-effort mime guess for caller-supplied bare paths/URLs. The sniff in
// image-utils is authoritative; this only shapes the request before it.
export function guessImageMime(url: string): string {
  const match = url.match(/^data:(image\/[a-z+]+);base64,/)
  if (match) return match[1]!
  const extension = url.split("?")[0]?.split(".").pop()?.toLowerCase()
  switch (extension) {
    case "jpeg":
    case "jpg":
      return "image/jpeg"
    case "gif":
      return "image/gif"
    case "webp":
      return "image/webp"
    default:
      return "image/png"
  }
}

// The TUI renders slash-command attachments as "[Image N]" placeholder tokens
// in the command arguments (and relay models pass the same tokens to
// vision_look). They carry no path or URL, so they are not usable image
// references — callers detect them and fall back to the session's latest
// image message instead.
const IMAGE_PLACEHOLDER_RE = /^\[Image \d+\]$/

// Case-insensitive check for the "last" sentinel with trimmed whitespace.
export function isLastSentinel(ref: string): boolean {
  return ref.trim().toLowerCase() === "last"
}

// Split reference lists into attachment placeholders and real (path/URL/data
// URL) references. "last" is a real reference here: the sentinel is handled
// by the callers before placeholder splitting.
export function splitPlaceholderRefs(refs: string[]): { placeholders: string[]; real: string[] } {
  const placeholders: string[] = []
  const real: string[] = []
  for (const ref of refs) {
    if (IMAGE_PLACEHOLDER_RE.test(ref)) placeholders.push(ref)
    else real.push(ref)
  }
  return { placeholders, real }
}
