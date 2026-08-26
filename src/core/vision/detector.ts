import { SUPPORTED_IMAGE_MIMES } from "../../config/constants"

export interface ImageAttachment {
  mime: string
  url: string
  filename?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

// Extract image attachments from a tool result output object.
export function extractImageAttachments(output: Record<string, unknown>): ImageAttachment[] {
  const attachmentsValue = output.attachments
  if (!Array.isArray(attachmentsValue)) return []

  const attachments: ImageAttachment[] = []
  for (const attachmentValue of attachmentsValue) {
    if (!isRecord(attachmentValue)) continue

    const mime = attachmentValue.mime
    const url = attachmentValue.url
    if (typeof mime !== "string" || typeof url !== "string") continue

    const normalizedMime = mime.toLowerCase()
    if (!SUPPORTED_IMAGE_MIMES.has(normalizedMime)) continue

    attachments.push({
      mime: normalizedMime,
      url,
      ...(typeof attachmentValue.filename === "string" ? { filename: attachmentValue.filename } : {}),
    })
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
    if (!isRecord(part)) continue
    if (part.type !== "file") continue
    const mime = part.mime
    const url = part.url
    if (typeof mime !== "string" || typeof url !== "string") continue
    const normalizedMime = mime.toLowerCase()
    if (!SUPPORTED_IMAGE_MIMES.has(normalizedMime)) continue
    images.push({ mime: normalizedMime, url })
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
