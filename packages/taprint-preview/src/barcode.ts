// SPDX-License-Identifier: Apache-2.0
// 一维码/二维码位图：bwip-js（纯 JS，PostScript 内核翻译）出 PNG → pngjs 解码
// → 墨迹掩码 → 最近邻重采样到目标 dot 盒（ADR-0008 纯 JS 通路）。
// 一期码制：CODE128 / EAN13（DSL v1.1 标签枚举，D5）；其余码制显式警告跳过。
import { toBuffer } from 'bwip-js/node';
import { PNG } from 'pngjs';
import { RenderError } from './scope.ts';

export interface InkMask {
  width: number;
  height: number;
  /** 1=墨、0=纸。 */
  data: Uint8Array;
}

/** bwip-js 单码制渲染 → 墨迹掩码（白底黑条 PNG 解码后按亮度二值化）。 */
export async function barcodeMask(bcid: string, text: string, opts: Record<string, unknown> = {}): Promise<InkMask> {
  let pngBuf: Buffer;
  try {
    pngBuf = await toBuffer({ bcid, text, scale: 2, ...opts });
  } catch (e) {
    throw new RenderError('barcode-encode-failed', `bwip-js 编码失败（${bcid} "${text}"）：${(e as Error).message}`);
  }
  const png = PNG.sync.read(pngBuf);
  const { width, height, data } = png;
  const mask = new InkMaskImpl(width, height);
  for (let i = 0; i < width * height; i++) {
    const r = data[i * 4];
    const g = data[i * 4 + 1];
    const b = data[i * 4 + 2];
    const a = data[i * 4 + 3];
    const lum = a < 128 ? 255 : (r + g + b) / 3;
    if (lum < 128) mask.data[i] = 1;
  }
  return mask;
}

/** 掩码最近邻重采样（条码/QR 拉伸到目标 dot 盒；等比由调用方先算好 dw/dh）。 */
export function resampleMask(src: InkMask, dw: number, dh: number): InkMask {
  const out = new InkMaskImpl(Math.max(1, dw), Math.max(1, dh));
  for (let y = 0; y < out.height; y++) {
    const sy = Math.min(src.height - 1, Math.floor(((y + 0.5) / out.height) * src.height));
    for (let x = 0; x < out.width; x++) {
      const sx = Math.min(src.width - 1, Math.floor(((x + 0.5) / out.width) * src.width));
      out.data[y * out.width + x] = src.data[sy * src.width + sx];
    }
  }
  return out;
}

class InkMaskImpl implements InkMask {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.data = new Uint8Array(width * height);
  }
}

/** DSL symbology → bwip-js bcid（预览一期仅 CODE128/EAN13；其余返回 null）。 */
export function symbologyToBcid(symbology: string): string | null {
  const s = String(symbology).toUpperCase();
  if (s === 'CODE128' || s === 'GS1_128') return 'code128';
  if (s === 'EAN13') return 'ean13';
  return null;
}
