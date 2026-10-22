// SPDX-License-Identifier: Apache-2.0
// 标签预览仿真（M2，设计契约）：TSPL 面为绝对坐标，布局层纯函数
// （jsdom 可测），光栅化按 203dpi（8 dot/mm）口径。口径偏差登记（设计契约）：设计态
// 不做 TSPL 指令级仿真，指令链属渲染服务权威；此处仅按 x/y/width/height 近似还原。
import { parseLengthMm } from '../types';
import type { CanvasElement } from '../types';
import { evaluateInterpolated } from './evaluate';

/** 203dpi → 8 dot/mm（TSPL 机口径；预览光栅化同用） */
export const LABEL_DOTS_PER_MM = 8;

export interface LabelBlock {
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** text/条码占位内容（已求值插值） */
  text: string;
}

export interface LabelLayout {
  widthMm: number;
  heightMm: number;
  blocks: LabelBlock[];
}

function blockText(el: CanvasElement, data: Record<string, unknown>): string {
  switch (el.type) {
    case 'barcode':
      return `[条码 ${el.symbology ?? 'CODE128'}] ${evaluateInterpolated(el.content ?? '', data)}`;
    case 'qrcode':
      return `[二维码] ${evaluateInterpolated(el.content ?? '', data)}`;
    case 'image':
      return '[图片]';
    case 'line':
    case 'box':
      return '';
    default:
      return evaluateInterpolated(el.content ?? '', data);
  }
}

/** 标签版式布局（纯函数）：presentation.size 定纸面（缺省 40×30mm），元素绝对坐标（mm） */
export function layoutLabel(dsl: unknown, data: Record<string, unknown>): LabelLayout {
  const pres = (
    dsl as {
      presentations?: {
        label?: { size?: { width?: string; height?: string }; body?: CanvasElement[] };
      };
    } | null
  )?.presentations?.label;
  const widthMm = parseLengthMm(pres?.size?.width) || 40;
  const heightMm = parseLengthMm(pres?.size?.height) || 30;
  const blocks: LabelBlock[] = [];
  for (const el of pres?.body ?? []) {
    blocks.push({
      type: el.type,
      x: parseLengthMm(el.x),
      y: parseLengthMm(el.y),
      width: parseLengthMm(el.width) || 20,
      height: parseLengthMm(el.height) || 6,
      text: blockText(el, data),
    });
  }
  return { widthMm, heightMm, blocks };
}

/** canvas 2D 绝对坐标直绘 → PNG（浏览器专属，不进 jsdom 单测；e2e 覆盖） */
export function renderLabelPreview(dsl: unknown, data: Record<string, unknown>): Promise<Blob> {
  const layout = layoutLabel(dsl, data);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(layout.widthMm * LABEL_DOTS_PER_MM));
  canvas.height = Math.max(1, Math.round(layout.heightMm * LABEL_DOTS_PER_MM));
  const ctx = canvas.getContext('2d');
  if (!ctx) return Promise.reject(new Error('canvas 2D 上下文不可用'));
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#000000';
  ctx.textBaseline = 'top';
  for (const b of layout.blocks) {
    const x = b.x * LABEL_DOTS_PER_MM;
    const y = b.y * LABEL_DOTS_PER_MM;
    const w = b.width * LABEL_DOTS_PER_MM;
    const h = b.height * LABEL_DOTS_PER_MM;
    if (b.type === 'barcode' || b.type === 'qrcode' || b.type === 'line' || b.type === 'box') {
      ctx.strokeStyle = '#000000';
      ctx.strokeRect(x, y, w, b.type === 'line' ? 1 : h);
      continue;
    }
    const fontSize = Math.max(8, Math.min(16, Math.floor(h * 0.5)));
    ctx.font = `${fontSize}px sans-serif`;
    ctx.fillText(b.text, x, y, w);
  }
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('canvas toBlob 失败'))),
      'image/png',
    );
  });
}
