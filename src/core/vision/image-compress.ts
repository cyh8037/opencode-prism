import { log } from "../../shared/log"

export interface VisionCompressConfig {
  enabled: boolean
  maxBytes: number
}

export interface CompressResult {
  buffer: Buffer
  mime: string
}

/**
 * Image compression for vision models:
 * Preserves resolution first, adaptive two-stage convergence (WebP/JPEG),
 * and fail-safe fallback to original buffer on error.
 */
export async function compressImageBuffer(
  buffer: Buffer,
  mime: string,
  options: VisionCompressConfig,
): Promise<CompressResult> {
  if (!options.enabled || buffer.length <= options.maxBytes) {
    return { buffer, mime }
  }

  if (typeof Bun === "undefined" || typeof Bun.Image === "undefined") {
    return { buffer, mime }
  }

  try {
    const img = new Bun.Image(buffer)
    const meta = await img.metadata()
    const origWidth = meta.width ?? 0
    const origHeight = meta.height ?? 0

    // Phase 1: Keep 100% original resolution, try WebP Q80
    try {
      const webpBytes = await img.webp({ quality: 80 }).bytes()
      if (webpBytes.byteLength <= options.maxBytes) {
        return { buffer: Buffer.from(webpBytes), mime: "image/webp" }
      }
    } catch {}

    // Try JPEG Q75 at original resolution
    try {
      const jpegBytes = await img.jpeg({ quality: 75 }).bytes()
      if (jpegBytes.byteLength <= options.maxBytes) {
        return { buffer: Buffer.from(jpegBytes), mime: "image/jpeg" }
      }
    } catch {}

    // Phase 2: Downsample proportionally using fit: "inside"
    if (origWidth > 16 && origHeight > 16) {
      const currentBytes = buffer.length
      const scale = Math.min(0.85, Math.max(0.15, Math.sqrt(options.maxBytes / currentBytes) * 0.95))
      const targetW = Math.max(16, Math.round(origWidth * scale))
      const targetH = Math.max(16, Math.round(origHeight * scale))

      const resized = img.resize(targetW, targetH, { fit: "inside" })
      try {
        const outWebp = await resized.webp({ quality: 75 }).bytes()
        if (outWebp.byteLength <= options.maxBytes) {
          return { buffer: Buffer.from(outWebp), mime: "image/webp" }
        }
      } catch {}

      try {
        const outJpeg = await resized.jpeg({ quality: 70 }).bytes()
        if (outJpeg.byteLength <= options.maxBytes) {
          return { buffer: Buffer.from(outJpeg), mime: "image/jpeg" }
        }
      } catch {}

      // Second downsample if still over
      const scale2 = Math.min(0.6, scale * 0.7)
      const targetW2 = Math.max(16, Math.round(origWidth * scale2))
      const targetH2 = Math.max(16, Math.round(origHeight * scale2))
      const resized2 = img.resize(targetW2, targetH2, { fit: "inside" })

      try {
        const outWebp2 = await resized2.webp({ quality: 65 }).bytes()
        if (outWebp2.byteLength <= options.maxBytes) {
          return { buffer: Buffer.from(outWebp2), mime: "image/webp" }
        }
      } catch {}

      const outJpeg2 = await resized2.jpeg({ quality: 60 }).bytes()
      return { buffer: Buffer.from(outJpeg2), mime: "image/jpeg" }
    }

    return { buffer, mime }
  } catch (error) {
    log("[prism] vision: image compression failed, falling back to original", { error })
    return { buffer, mime }
  }
}
