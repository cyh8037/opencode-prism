// 终端等宽字体下的字符宽度引擎 — 看板对齐的唯一事实来源。
//
// 规则:box-drawing 与现代等宽终端的假设(1 列宽)见 visualizer 注释;
// 本模块只回答"一段文本在等宽终端占几列、如何截断/补齐不破坏渲染"。
// 宽度按文本字面计算:sanitizeSystemReminder 是逐字改写(</ -> <\/),
// 渲染器不解析任何实体,因此无需区分"显示宽度"与"字面宽度"。
//
// 字素切分优先用 Intl.Segmenter(Bun 内置 API,非运行时依赖):ZWJ 序列
// (家庭 emoji 等)与 emoji 修饰符整体为一簇,截断按簇进行,天然不会残留
// 半个代理对或半截 ZWJ 序列。极老运行时无 Intl.Segmenter 时退回按 code
// point 逐字切分(退化路径,宽度近似,注释注明条件)。

// 单码点宽度:0 = 零宽,1 = 窄,2 = 宽。近似规则对现代终端已足够精确。
function codePointWidth(codePoint: number): number {
  // 零宽:ZWJ、变体选择符、组合附加符、零宽连接/不换行/断行等
  if (
    codePoint === 0x200d || // ZWJ
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f) || // 变体选择符(含 VS16)
    (codePoint >= 0x0300 && codePoint <= 0x036f) || // 组合附加符(e + U+0301 渲染为 é,占 1 列)
    (codePoint >= 0x200b && codePoint <= 0x200f) || // 零宽空格/左右连字符/LRM-RLM
    (codePoint >= 0x2060 && codePoint <= 0x2064) // 词连接符等
  ) {
    return 0
  }
  // box-drawing 与制表符区域:现代等宽终端按 1 列渲染
  if (codePoint >= 0x2500 && codePoint <= 0x257f) return 1
  // ASCII 可打印
  if (codePoint >= 0x20 && codePoint <= 0x7e) return 1
  // 全角标点(半角/全角形式区)、CJK 符号和标点(含全角空格)
  if ((codePoint >= 0xff00 && codePoint <= 0xff60) || (codePoint >= 0x3000 && codePoint <= 0x303f)) return 2
  // CJK 统一表意文字(基本区、扩展 A)、兼容表意文字
  if (
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) ||
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff)
  ) {
    return 2
  }
  // 平假名/片假名/全角谚文
  if (
    (codePoint >= 0x3040 && codePoint <= 0x30ff) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7af)
  ) {
    return 2
  }
  // BMP emoji 密集区:杂项符号/装饰符号/dingbats(✅⚠️❤️✨ 等)、
  // 杂项符号和箭头(⭐ 等)——现代终端默认 emoji 呈现,按 2 宽。区段
  // 近似:少量文本符号(如 ☀ 的文本变体)会按 2 宽计,可接受。
  if (
    (codePoint >= 0x2600 && codePoint <= 0x27bf) ||
    (codePoint >= 0x2b00 && codePoint <= 0x2bff)
  ) {
    return 2
  }
  // 非 BMP:绝大多数是宽 emoji(代理对构成的补充平面字符)
  if (codePoint > 0xffff) return 2
  // 其余(希腊字母、西里尔、半角假名等)按 1 宽
  return 1
}

// 一个"字素簇"在终端占的列宽。ZWJ 序列(如 👨‍👩‍👧 家庭 emoji)整体按 2 宽:
// 常见终端将组合 emoji 渲染为单格双列;普通单簇按内部码点宽度之和
// (clamp 到至少 1,防御孤立零宽字符)。
function clusterWidth(cluster: string): number {
  // ZWJ 序列(家庭 emoji 等)整体按 2 宽:常见终端渲染为单格双列
  if (cluster.includes("\u200d")) return 2
  // 含非 BMP 码点(宽 emoji)或肤色修饰符(U+1F3FB-U+1F3FF)的簇:
  // 终端渲染为一个双列 emoji,而不是各码点宽度之和(🏃‍♂️ 是 2 宽不是 4 宽)
  for (const char of cluster) {
    const codePoint = char.codePointAt(0) ?? 0
    if (codePoint > 0xffff || (codePoint >= 0x1f3fb && codePoint <= 0x1f3ff)) return 2
  }
  let width = 0
  for (const char of cluster) {
    width += codePointWidth(char.codePointAt(0) ?? 0)
  }
  return Math.max(width, 1)
}

// Segmenter 实例模块级缓存：一次看板渲染会对每列×每行调用 getStringWidth/
// truncateWidth/padEndWidth 数十至数百次，每次 new Intl.Segmenter 的分配
// 成本不可忽略；实例无状态可复用（granularity 固定 grapheme）。
let cachedSegmenter: { segment: (input: string) => Iterable<{ segment: string }> } | undefined
let segmenterChecked = false

function getSegmenter():
  | { segment: (input: string) => Iterable<{ segment: string }> }
  | undefined {
  if (segmenterChecked) return cachedSegmenter
  segmenterChecked = true
  const segmenter = (Intl as { Segmenter?: unknown }).Segmenter
  if (typeof segmenter === "function") {
    cachedSegmenter = new (segmenter as new (locale: undefined, options: { granularity: "grapheme" }) => {
      segment: (input: string) => Iterable<{ segment: string }>
    })(undefined, { granularity: "grapheme" })
  }
  return cachedSegmenter
}

function graphemeClusters(text: string): string[] {
  const segmenter = getSegmenter()
  if (segmenter) {
    return Array.from(segmenter.segment(text), (seg) => seg.segment)
  }
  // 退化路径:按 code point 切分(不识别 ZWJ 序列,宽度近似)
  return Array.from(text)
}

/** 一段文本在等宽终端中占的列宽。 */
export function getStringWidth(text: string): number {
  let width = 0
  for (const cluster of graphemeClusters(text)) {
    width += clusterWidth(cluster)
  }
  return width
}

/** 按列宽补齐到目标宽度(超宽时原样返回,不截断)。 */
export function padEndWidth(text: string, width: number): string {
  const current = getStringWidth(text)
  if (current >= width) return text
  return text + " ".repeat(width - current)
}

/**
 * 按列宽截断,maxWidth 为上限。按字素簇截断:不会切出半个代理对或残留
 * 半截 ZWJ 序列。截断后可能略小于 maxWidth(一个簇装不下时)。
 */
export function truncateWidth(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return ""
  let result = ""
  let width = 0
  for (const cluster of graphemeClusters(text)) {
    const clusterWidthValue = clusterWidth(cluster)
    if (width + clusterWidthValue > maxWidth) break
    result += cluster
    width += clusterWidthValue
  }
  return result
}
