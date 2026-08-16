import { VISION_IMAGE_MAX_BYTES } from "../../config/constants"
import { log } from "../../shared/log"
import type { ImageAttachment } from "./detector"

const FETCH_TIMEOUT_MS = 10_000

// Convert remote image URLs to data URLs so every vision provider can consume
// them. Local data: URLs pass through. Oversized images are dropped with a
// note so the batch still proceeds.
export async function normalizeImageUrl(image: ImageAttachment): Promise<ImageAttachment | null> {
  if (image.url.startsWith("data:")) return image

  try {
    const response = await fetch(image.url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    if (!response.ok) {
      log(`[prism] vision: failed to fetch image (${response.status})`, { url: image.url })
      return null
    }
    const bytes = await response.arrayBuffer()
    if (bytes.byteLength > VISION_IMAGE_MAX_BYTES) {
      log(`[prism] vision: image exceeds 8MB, skipping`, { url: image.url, bytes: bytes.byteLength })
      return null
    }
    const base64 = Buffer.from(bytes).toString("base64")
    return { ...image, url: `data:${image.mime};base64,${base64}` }
  } catch (error) {
    log(`[prism] vision: image fetch failed`, { url: image.url, error })
    return null
  }
}

export async function normalizeImageBatch(images: ImageAttachment[]): Promise<ImageAttachment[]> {
  const normalized = await Promise.all(images.map(normalizeImageUrl))
  return normalized.filter((image): image is ImageAttachment => image !== null)
}
