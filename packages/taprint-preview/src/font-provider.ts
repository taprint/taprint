// SPDX-License-Identifier: Apache-2.0
// FontProvider：包内 Noto Sans SC（wght=400 静态实例，OFL-1.1，ADR-0002）惰性
// 加载 + 字形解析/测量/排版。opentype.js 纯 JS 解析（ADR-0008 零原生依赖）。
//
// Fallback 链（首版口径，conformance 诚实登记）：
// - CJK 与拉丁字形均取自 Noto Sans SC（该字体自带拉丁覆盖），advance 为精确值；
// - 字体中缺失的字形（notdef，glyph.index===0）：非空白字符按显示宽度近似
//   （CJK/全角 1em、其余 0.5em）占位排版，并画 0.6em 空心方框标注；同一次
//   渲染的缺失字符去重后汇总进 warnings（`missing-glyph: …`）。
// 纯拉丁后备（系统近似宽度）与精确双字体链属后续任务，不在首版口径内。
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import opentype from 'opentype.js';

export interface GlyphBox {
  glyph: opentype.Glyph;
  /** 笔画起点 x（dot）。 */
  x: number;
  /** 该字形 advance（dot）。 */
  advance: number;
  /** true = 字体缺字形（notdef），已按近似宽度占位。 */
  fallback: boolean;
}

export interface GlyphRun {
  /** 所属字体（调用方取 unitsPerEm/ascender 等排版度量）。 */
  font: opentype.Font;
  boxes: GlyphBox[];
  /** 总 advance 宽（dot）。 */
  width: number;
  /** 本次排版新发现的缺失字符（去重）。 */
  missing: string[];
}

export interface FontProviderOptions {
  /** 自定义字体路径（默认包内 fonts/NotoSansSC-Regular.ttf）。 */
  fontPath?: string;
}

/**
 * 基线比例：文字盒顶 → 基线 = sizeDots × 0.88（CJK 排版通行口径——Noto Sans SC
 * 字体 ascender ≈1.16em 会把基线推到行盒之外，预览按 em 方内 0.88em 钉基线，
 * 与 TSPL 设备字库「24dot 字形在 24dot 行内」的语义一致）。
 */
export const FONT_BASELINE_RATIO = 0.88;

const DEFAULT_FONT_URL = new URL('../fonts/NotoSansSC-Regular.ttf', import.meta.url);

export class FontProvider {
  private font: opentype.Font | null = null;
  private loading: Promise<void> | null = null;
  private readonly fontPath: string;

  constructor(options: FontProviderOptions = {}) {
    this.fontPath = options.fontPath ?? fileURLToPath(DEFAULT_FONT_URL);
  }

  /** 字体是否已加载。 */
  get loaded(): boolean {
    return this.font !== null;
  }

  /** 惰性加载（幂等；并发调用共享同一 Promise）。 */
  async ensureFont(): Promise<opentype.Font> {
    if (this.font) return this.font;
    this.loading ??= (async () => {
      const buf = await readFile(this.fontPath);
      this.font = opentype.parse(
        buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer,
      );
    })();
    await this.loading;
    return this.font!;
  }

  /**
   * 文本 → 字形排布（单行；不折行，超宽截断由调用方按 maxWidth 裁剪）。
   * sizeDots = 字号 em 方折算像素（pt→dot 走 ADR-0009 half-up，见 length.ts）。
   */
  async layout(text: string, sizeDots: number): Promise<GlyphRun> {
    const font = await this.ensureFont();
    const upem = font.unitsPerEm || 1000;
    const scale = sizeDots / upem;
    const boxes: GlyphBox[] = [];
    const missing: string[] = [];
    let x = 0;
    for (const ch of text) {
      const glyph = font.charToGlyph(ch);
      let advance = (glyph.advanceWidth ?? upem * 0.5) * scale;
      let fallback = false;
      if (glyph.index === 0 && ch.trim() !== '') {
        // notdef：按显示宽度近似占位（CJK/全角 1em、其余 0.5em）
        advance = sizeDots * (ch.charCodeAt(0) > 0xff ? 1 : 0.5);
        fallback = true;
        if (!missing.includes(ch)) missing.push(ch);
      }
      boxes.push({ glyph, x, advance, fallback });
      x += advance;
    }
    return { font, boxes, width: x, missing };
  }

  /** 单行宽度测量（无副作用快捷路径）。 */
  async measure(text: string, sizeDots: number): Promise<number> {
    return (await this.layout(text, sizeDots)).width;
  }

  /** ascent（dot）——文字盒顶到基线（FONT_BASELINE_RATIO × sizeDots）。 */
  async ascent(sizeDots: number): Promise<number> {
    return sizeDots * FONT_BASELINE_RATIO;
  }
}
