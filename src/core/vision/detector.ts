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

// Extract image parts from a chat.message input. OpenCode represents images
// as file parts: { type: "file", mime: "image/png", url: ... }.
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
