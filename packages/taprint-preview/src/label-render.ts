// SPDX-License-Identifier: Apache-2.0
// label 呈现渲染：绝对坐标布局（TSPL 口径）。几何折算全部走 ADR-0009 half-up
// （length.ts）；元素面 = text / barcode / qrcode / line / box / image（跳过+警告）。
import { roundHalfAwayFromZero } from 'taprint';
import { MonoCanvas } from './canvas.ts';
import { barcodeMask, resampleMask, symbologyToBcid } from './barcode.ts';
import type { FontProvider } from './font-provider.ts';
import { lengthToDots, ptToDots } from './length.ts';
import { RenderError, renderTemplateString, type Json } from './scope.ts';
import { drawText } from './text.ts';
export interface LabelRenderResult {
  canvas: MonoCanvas;
  warnings: string[];
  /** 纸面尺寸（dot）。 */
  widthDots: number;
  heightDots: number;
}

/** TSPL 基准字高：CJK 设备字库 24 dot @203dpi（taprint-java TsplRenderer.CJK_FONT_HEIGHT_DOTS 同源）。 */
const BASE_FONT_DOTS_AT_203 = 24;

/** 基准字高折算到当前 dpi（half-up）：24 dot × mul × dpi/203。 */
function fontDots(mul: number, dpi: number): number {
  return roundHalfAwayFromZero((BASE_FONT_DOTS_AT_203 * mul * dpi) / 203);
}

/** 元素 text 字号解析：顶层 size（1-10 倍率，v1.0 的 0 折算 1）优先；
 *  style.fontSize 数值 = pt；style.fontSize 字符串 = normal/double/quadruple 档位。 */
function resolveTextSizeDots(el: Json, dpi: number): number {
  const top = el.size;
  if (typeof top === 'number' && Number.isFinite(top)) {
    return fontDots(Math.max(1, Math.min(10, Math.floor(top))), dpi);
  }
  const style = (el.style ?? {}) as Json;
  const fs = style.fontSize;
  if (typeof fs === 'number' && Number.isFinite(fs)) return ptToDots(fs, dpi);
  if (fs === 'double') return fontDots(2, dpi);
  if (fs === 'quadruple') return fontDots(4, dpi);
  return fontDots(1, dpi);
}

export async function renderLabelPresentation(
  pres: Json,
  scope: Json,
  provider: FontProvider,
  dpi: number,
): Promise<LabelRenderResult> {
  const size = pres.size as Json | undefined;
  if (!size || typeof size !== 'object') {
    throw new RenderError('missing-label-size', 'presentations.label 缺 size（width/height mm）——预览无纸面尺寸可渲染');
  }
  const widthDots = lengthToDots(size.width, dpi);
  const heightDots = lengthToDots(size.height, dpi);
  const canvas = new MonoCanvas(widthDots, heightDots);
  const warnings: string[] = [];
  const resolve = (tpl: string) => renderTemplateString(tpl, scope);

  const body = pres.body;
  if (!Array.isArray(body)) {
    throw new RenderError('missing-label-body', 'presentations.label 缺 body 数组');
  }

  for (let i = 0; i < body.length; i++) {
    const el = body[i] as Json;
    const path = `presentations.label.body[${i}]`;
    const x = lengthToDots(el.x, dpi);
    const y = lengthToDots(el.y, dpi);
    switch (el.type) {
      case 'text': {
        const text = resolve(String(el.content ?? ''));
        if (!text) continue;
        const sizeDots = resolveTextSizeDots(el, dpi);
        const run = await provider.layout(text, sizeDots);
        for (const ch of run.missing) {
          warnings.push(`missing-glyph: U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}（${path}，占位方框）`);
        }
        // 超右边界截断（与热敏打印截断一致）
        let drawn = text;
        const maxW = widthDots - x;
        if (run.width > maxW && maxW > 0) {
          let acc = 0;
          let cut = 0;
          for (const b of run.boxes) {
            if (acc + b.advance > maxW) break;
            acc += b.advance;
            cut++;
          }
          drawn = [...text].slice(0, cut).join('');
        }
        const style = (el.style ?? {}) as Json;
        await drawText(canvas, provider, drawn, { x, y, sizeDots, bold: style.bold === true, underline: style.underline === true });
        break;
      }
      case 'barcode': {
        const symbology = String(el.symbology ?? 'CODE128');
        const bcid = symbologyToBcid(symbology);
        if (!bcid) {
          warnings.push(`unsupported-symbology: ${symbology}（${path}，预览一期仅 CODE128/EAN13，已跳过）`);
          continue;
        }
        const content = resolve(String(el.content ?? ''));
        if (!content) continue;
        const heightDotsEl = lengthToDots(el.height, dpi, 10); // Java TsplRenderer：height 缺省 10mm
        const mask = await barcodeMask(bcid, content);
        const w = Math.max(1, roundHalfAwayFromZero((mask.width * heightDotsEl) / mask.height));
        const scaled = resampleMask(mask, w, heightDotsEl);
        const human = el.humanReadable === true; // D3 裁决前不私设缺省：未写值按无渲染（conformance 登记）
        const blitH = human ? Math.max(1, heightDotsEl - fontDots(1, dpi)) : heightDotsEl;
        blitMask(canvas, scaled, x, y, Math.min(w, Math.max(1, widthDots - x)), blitH);
        if (human) {
          const textH = fontDots(1, dpi);
          await drawText(canvas, provider, content, { x, y: y + blitH, sizeDots: textH });
        }
        break;
      }
      case 'qrcode': {
        const content = resolve(String(el.content ?? ''));
        if (!content) continue;
        const cell = typeof el.size === 'number' ? Math.max(1, Math.min(10, Math.floor(el.size))) : 4;
        const cellDots = Math.max(1, roundHalfAwayFromZero((cell * dpi) / 203)); // cell 按 203dpi 基准折算
        const mask = await barcodeMask('qrcode', content, { scale: 1 });
        const scaled = resampleMask(mask, mask.width * cellDots, mask.height * cellDots);
        blitMask(canvas, scaled, x, y, scaled.width, scaled.height);
        break;
      }
      case 'line': {
        // D9 单形：横线 height="0mm"（长=width）、竖线 width="0mm"（长=height）
        const wMm = lengthToDots(el.width, dpi);
        const hMm = lengthToDots(el.height, dpi);
        const thickness = Math.max(1, Math.min(32, typeof el.thickness === 'number' ? el.thickness : 2));
        if (hMm <= 0) canvas.fillRect(x, y, wMm, thickness);
        else if (wMm <= 0) canvas.fillRect(x, y, thickness, hMm);
        else canvas.fillRect(x, y, wMm, hMm); // 双向非零 → 实心矩形（MCP label 映射同语义）
        break;
      }
      case 'box': {
        const w = lengthToDots(el.width, dpi);
        const h = lengthToDots(el.height, dpi);
        const thickness = Math.max(1, Math.min(32, typeof el.thickness === 'number' ? el.thickness : 2));
        if (el.radius !== undefined) {
          warnings.push(`box-radius-degraded: 圆角降级直角（${path}，TSPL 无原生命令）`);
        }
        canvas.strokeRect(x, y, w, h, thickness);
        break;
      }
      case 'image':
        warnings.push(`image-skipped: image 元素预览暂不支持（${path}，src=${String(el.src ?? '')}）`);
        break;
      default:
        warnings.push(`unknown-element: ${String(el.type)}（${path}，已跳过）`);
    }
  }
  return { canvas, warnings, widthDots, heightDots };
}

/** 掩码按目标盒 blit（dw/dh 已定，避免与源比例二次纠缠）。 */
function blitMask(canvas: MonoCanvas, mask: { width: number; height: number; data: Uint8Array }, x: number, y: number, dw: number, dh: number): void {
  for (let dy = 0; dy < dh; dy++) {
    const sy = Math.min(mask.height - 1, Math.floor(((dy + 0.5) / dh) * mask.height));
    for (let dx = 0; dx < dw; dx++) {
      const sx = Math.min(mask.width - 1, Math.floor(((dx + 0.5) / dw) * mask.width));
      if (mask.data[sy * mask.width + sx]) canvas.set(Math.round(x) + dx, Math.round(y) + dy, 0);
    }
  }
}
