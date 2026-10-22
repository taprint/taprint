// SPDX-License-Identifier: Apache-2.0
// 小票预览仿真（M2，设计契约）：DSL 直渲近似——布局层为纯函数
// （jsdom 可测），光栅化层走浏览器 canvas 2D。口径偏差登记（设计契约）：设计态
// 不做 ESC/POS 指令级仿真，指令链属渲染服务权威；此处仅按列宽/折行近似还原版式。
import { parseLengthMm } from '../types';
import type { CanvasElement } from '../types';
import { evaluateInterpolated, evaluateWhen } from './evaluate';

export type ReceiptRowKind = 'text' | 'sep' | 'barcode' | 'qrcode' | 'kv' | 'note';

export interface ReceiptRow {
  text: string;
  align: 'left' | 'center' | 'right';
  kind: ReceiptRowKind;
}

export interface ReceiptLayout {
  widthMm: number;
  /** 等宽字符列数（80mm→48、58mm→32，其余按宽折算；渲染器文档口径） */
  columns: number;
  rows: ReceiptRow[];
}

/** CJK 全角字符按双列宽计（GB18030 热敏机近似口径） */
export function displayWidth(text: string): number {
  let w = 0;
  for (const ch of text) {
    w += (ch.codePointAt(0) ?? 0) >= 0x2e80 ? 2 : 1;
  }
  return w;
}

/** 按列宽折行（CJK 双列宽；空文本产出单空行保持行距语义） */
export function wrapText(text: string, columns: number): string[] {
  if (!text) return [''];
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    let width = 0;
    for (const ch of paragraph) {
      const w = displayWidth(ch);
      if (width + w > columns && line) {
        lines.push(line);
        line = '';
        width = 0;
      }
      line += ch;
      width += w;
    }
    lines.push(line);
  }
  return lines;
}

function columnsForWidth(widthMm: number): number {
  if (Math.abs(widthMm - 80) < 0.5) return 48;
  if (Math.abs(widthMm - 58) < 0.5) return 32;
  return Math.max(16, Math.round(widthMm * 0.6));
}

function alignOf(el: CanvasElement): 'left' | 'center' | 'right' {
  return el.align ?? (el.style?.align as 'left' | 'center' | 'right' | undefined) ?? 'left';
}

/** loop 行作用域近似：each 源首行字段平铺进求值数据（只渲一轮，与画布 LoopElement 口径一致） */
function loopScope(each: unknown, data: Record<string, unknown>): Record<string, unknown> {
  const rows = typeof each === 'string' ? data[each] : undefined;
  const first = Array.isArray(rows) ? rows[0] : undefined;
  if (!first || typeof first !== 'object') return data;
  return { ...data, ...(first as Record<string, unknown>) };
}

function pushText(
  out: ReceiptRow[],
  el: CanvasElement,
  data: Record<string, unknown>,
  columns: number,
): void {
  const text = evaluateInterpolated(el.content ?? '', data);
  for (const line of wrapText(text, columns)) {
    out.push({ text: line, align: alignOf(el), kind: 'text' });
  }
}

function layoutElement(
  el: CanvasElement,
  data: Record<string, unknown>,
  columns: number,
  out: ReceiptRow[],
): void {
  switch (el.type) {
    case 'text':
      pushText(out, el, data, columns);
      return;
    case 'line':
      out.push({ text: '-'.repeat(columns), align: 'left', kind: 'sep' });
      return;
    case 'barcode':
      out.push({
        text: `[条码 ${el.symbology ?? 'CODE128'}] ${evaluateInterpolated(el.content ?? '', data)}`,
        align: 'center',
        kind: 'barcode',
      });
      return;
    case 'qrcode':
      out.push({
        text: `[二维码] ${evaluateInterpolated(el.content ?? '', data)}`,
        align: 'center',
        kind: 'qrcode',
      });
      return;
    case 'image':
      out.push({ text: '[图片]', align: alignOf(el), kind: 'note' });
      return;
    case 'kvtable': {
      const rows = Array.isArray(el.rows) ? el.rows : [];
      const pairCount = typeof el.columns === 'number' ? el.columns : 1;
      for (const row of rows) {
        if (!Array.isArray(row)) continue;
        const cells = row
          .map((cell) => {
            if (!Array.isArray(cell)) return '';
            const [key, value] = cell as [string, string];
            return `${key ?? ''}：${evaluateInterpolated(value ?? '', data)}`;
          })
          .slice(0, pairCount);
        out.push({ text: cells.join('　'), align: 'left', kind: 'kv' });
      }
      return;
    }
    case 'table': {
      const cols = Array.isArray(el.columns) ? el.columns : [];
      if (cols.length) {
        out.push({ text: cols.map((c) => c.header).join(' | '), align: 'left', kind: 'text' });
        out.push({ text: '-'.repeat(columns), align: 'left', kind: 'sep' });
      }
      out.push({ text: '（表格为近似预览，精确版式以渲染服务为准）', align: 'left', kind: 'note' });
      return;
    }
    case 'loop': {
      const scope = loopScope(el.each, data);
      for (const child of el.body ?? []) layoutElement(child, scope, columns, out);
      return;
    }
    case 'conditional': {
      const branch = evaluateWhen(el.when ?? '', data) ? el.body : el.elseBody;
      for (const child of branch ?? []) layoutElement(child, data, columns, out);
      return;
    }
    case 'cut':
      out.push({
        text: el.partial ? '✄ - - - 部分切 - - -' : '✄ - - - 全切 - - -',
        align: 'center',
        kind: 'sep',
      });
      return;
    default:
      out.push({ text: `[${el.type}]`, align: 'left', kind: 'note' });
  }
}

/** 小票版式布局（纯函数）：presentation.width 定纸宽（缺省 80mm），body 顺序产出行列表 */
export function layoutReceipt(dsl: unknown, data: Record<string, unknown>): ReceiptLayout {
  const rows: ReceiptRow[] = [];
  const pres = (
    dsl as { presentations?: { receipt?: { width?: string; body?: CanvasElement[] } } } | null
  )?.presentations?.receipt;
  const widthMm = parseLengthMm(pres?.width) || 80;
  const columns = columnsForWidth(widthMm);
  for (const el of pres?.body ?? []) layoutElement(el, data, columns, rows);
  return { widthMm, columns, rows };
}

/** canvas 2D 等宽网格光栅化 → PNG（浏览器专属，不进 jsdom 单测；e2e 覆盖） */
export function renderReceiptPreview(dsl: unknown, data: Record<string, unknown>): Promise<Blob> {
  const layout = layoutReceipt(dsl, data);
  const colW = 6;
  const lineH = 18;
  const pad = 8;
  const canvas = document.createElement('canvas');
  canvas.width = layout.columns * colW + pad * 2;
  canvas.height = Math.max(1, layout.rows.length) * lineH + pad * 2;
  const ctx = canvas.getContext('2d');
  if (!ctx) return Promise.reject(new Error('canvas 2D 上下文不可用'));
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#000000';
  ctx.font = '12px monospace';
  ctx.textBaseline = 'top';
  layout.rows.forEach((row, i) => {
    const textW = displayWidth(row.text) * colW;
    const trackW = layout.columns * colW;
    const x =
      row.align === 'center'
        ? pad + Math.max(0, (trackW - textW) / 2)
        : row.align === 'right'
          ? pad + Math.max(0, trackW - textW)
          : pad;
    if (row.kind === 'sep') {
      ctx.save();
      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = '#999999';
      ctx.beginPath();
      ctx.moveTo(pad, i * lineH + pad + lineH / 2);
      ctx.lineTo(pad + trackW, i * lineH + pad + lineH / 2);
      ctx.stroke();
      ctx.restore();
      return;
    }
    ctx.fillText(row.text, x, i * lineH + pad);
  });
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('canvas toBlob 失败'))),
      'image/png',
    );
  });
}
