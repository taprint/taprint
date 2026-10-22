// SPDX-License-Identifier: Apache-2.0
// receipt 呈现渲染：流式布局（ESC/POS 口径）。行高栅格与 C# IrWpfPreviewRenderer
// 同源（BaseLineDots=24 × FontScale，收据用 normal/double/quadruple；数值 fontSize
// pt 按档位 = pt/12 折算），对齐三态、超宽截断、rule 实/虚语义均对齐 C# 预览器；
// 几何折算到显式 dpi（ADR-0009 half-up）。kvtable/table 以文本行近似（列宽权重
// + 末列右贴，与 C# ColumnsRow 同口径）。
import { roundHalfAwayFromZero } from 'taprint';
import { MonoCanvas } from './canvas.ts';
import { barcodeMask, resampleMask, symbologyToBcid, type InkMask } from './barcode.ts';
import type { FontProvider } from './font-provider.ts';
import { parseMm, ptToDots } from './length.ts';
import { RenderError, renderTemplateString, type Json } from './scope.ts';
import { drawText } from './text.ts';

export interface ReceiptRenderResult {
  canvas: MonoCanvas;
  warnings: string[];
  widthDots: number;
  heightDots: number;
}

/** 基准行高 24 dot @203dpi（C# IrPreviewRenderer.BaseLineDots 同源）。 */
const BASE_LINE_DOTS_AT_203 = 24;

/** 行高折算到当前 dpi：24 × scale × dpi/203（half-up）。 */
function lineDots(scale: number, dpi: number): number {
  return roundHalfAwayFromZero((BASE_LINE_DOTS_AT_203 * scale * dpi) / 203);
}

interface PlannedRow {
  heightDots: number;
  paint: (canvas: MonoCanvas, provider: FontProvider, y: number) => Promise<void>;
}

export async function renderReceiptPresentation(
  pres: Json,
  scope: Json,
  provider: FontProvider,
  dpi: number,
): Promise<ReceiptRenderResult> {
  const widthDots = roundHalfAwayFromZero(parseMm(pres.width, 80) * (dpi / 25.4));
  const warnings: string[] = [];
  const resolve = (tpl: string) => renderTemplateString(tpl, scope);

  const body = pres.body;
  if (!Array.isArray(body)) {
    throw new RenderError('missing-receipt-body', 'presentations.receipt 缺 body 数组');
  }

  // 两遍：先物化每行（行高 + 绘制闭包，字体在物化期即热加载），总高出来后一次成布。
  const rows: PlannedRow[] = [];
  for (let i = 0; i < body.length; i++) {
    const el = body[i] as Json;
    const path = `presentations.receipt.body[${i}]`;
    const type = el.type;
    switch (type) {
      case 'text': {
        const style = (el.style ?? {}) as Json;
        const { sizeDots, rowDots } = resolveReceiptFont(style, dpi);
        const rowH = rowDots;
        const align = (typeof el.align === 'string' ? el.align : (typeof style.align === 'string' ? style.align : 'left')) as Align;
        const raw = resolve(String(el.content ?? ''));
        if (!raw) {
          rows.push({ heightDots: rowH, paint: async () => {} });
          break;
        }
        const drawn = await truncateToWidth(provider, raw, widthDots, sizeDots);
        for (const ch of drawn.missing) {
          warnings.push(`missing-glyph: U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}（${path}，占位方框）`);
        }
        rows.push({
          heightDots: rowH,
          paint: async (canvas, prov, y) => {
            const run = await prov.layout(drawn.text, sizeDots);
            const x = alignX(align, run.width, canvas.width);
            await drawText(canvas, prov, drawn.text, {
              x,
              y,
              sizeDots,
              bold: style.bold === true,
              underline: style.underline === true,
            });
          },
        });
        break;
      }
      case 'line': {
        // 流式线：整行横线；lineStyle solid/dashed（C# RuleRow：实线步 2、虚线步 4，thickness 2）
        const dashed = el.lineStyle === 'dashed';
        rows.push({
          heightDots: lineDots(1, dpi),
          paint: async (canvas, _prov, y) => {
            const mid = y + Math.floor(lineDots(1, dpi) / 2);
            if (dashed) canvas.dashedLine(0, mid, canvas.width, 2, 4, 2);
            else canvas.hline(0, mid, canvas.width, 2);
          },
        });
        break;
      }
      case 'cut': {
        // C# IrPreviewRenderer：cut → 实线 rule 行
        rows.push({
          heightDots: lineDots(1, dpi),
          paint: async (canvas, _prov, y) => {
            canvas.hline(0, y + Math.floor(lineDots(1, dpi) / 2), canvas.width, 2);
          },
        });
        break;
      }
      case 'spacer': {
        rows.push({
          heightDots: Math.max(1, roundHalfAwayFromZero(parseMm(el.height, 2) * (dpi / 25.4))),
          paint: async () => {},
        });
        break;
      }
      case 'pageBreak':
        rows.push({ heightDots: 1, paint: async () => {} });
        break;
      case 'cashDrawer':
        warnings.push(`cashDrawer-skipped: 钱箱动作无票面像素（${path}）`);
        break;
      case 'image':
        warnings.push(`image-skipped: image 元素预览暂不支持（${path}，src=${String(el.src ?? '')}）`);
        break;
      case 'barcode': {
        const symbology = String(el.symbology ?? 'CODE128');
        const bcid = symbologyToBcid(symbology);
        if (!bcid) {
          warnings.push(`unsupported-symbology: ${symbology}（${path}，预览一期仅 CODE128/EAN13，已跳过）`);
          rows.push({ heightDots: lineDots(1, dpi), paint: async () => {} });
          break;
        }
        const content = resolve(String(el.content ?? ''));
        if (!content) {
          rows.push({ heightDots: lineDots(1, dpi), paint: async () => {} });
          break;
        }
        const hDots = roundHalfAwayFromZero(parseMm(el.height, 10) * (dpi / 25.4));
        const m = await barcodeMask(bcid, content);
        const scaled = resampleMask(m, Math.max(1, roundHalfAwayFromZero((m.width * hDots) / m.height)), hDots);
        const align = (typeof el.align === 'string' ? el.align : 'center') as Align;
        rows.push(blockRow(scaled, align, hDots));
        break;
      }
      case 'qrcode': {
        const content = resolve(String(el.content ?? ''));
        if (!content) {
          rows.push({ heightDots: lineDots(1, dpi), paint: async () => {} });
          break;
        }
        const cell = typeof el.size === 'number' ? Math.max(1, Math.min(10, Math.floor(el.size))) : 4;
        const cellDots = Math.max(1, roundHalfAwayFromZero((cell * dpi) / 203)); // cell 按 203dpi 基准折算
        const m = await barcodeMask('qrcode', content, { scale: 1 });
        const scaled = resampleMask(m, m.width * cellDots, m.height * cellDots);
        const align = (typeof el.align === 'string' ? el.align : 'center') as Align;
        rows.push(blockRow(scaled, align, scaled.height));
        break;
      }
      case 'kvtable': {
        // kvtable rows = [[ [k,v], … ]] → 每格一行 "k: v"（columns>1 并排属 v2.0 面，预览逐行）
        const rowGroups = Array.isArray(el.rows) ? el.rows : [];
        for (const group of rowGroups as unknown[]) {
          if (!Array.isArray(group)) continue;
          for (const cellRow of group) {
            if (!Array.isArray(cellRow)) continue;
            for (const cell of cellRow) {
              if (!Array.isArray(cell)) continue;
              const k = String(cell[0] ?? '');
              const v = resolve(String(cell[1] ?? ''));
              const text = k ? `${k}: ${v}` : v;
              rows.push(await planTextRow(provider, text, 1, 'left', widthDots, dpi, false, false));
            }
          }
        }
        break;
      }
      case 'table': {
        const source = String(el.source ?? '');
        const columns = (Array.isArray(el.columns) ? el.columns : []) as Json[];
        const data = Array.isArray(scope[source]) ? (scope[source] as unknown[]) : [];
        const weights = columns.map((c) => {
          const w = String(c?.width ?? '');
          return Math.max(1, w.endsWith('%') ? Math.round(Number(w.slice(0, -1)) || 0) : 0);
        });
        const total = weights.reduce((a, b) => a + b, 0) || 1;
        const cellsOf = (row: Json | null) =>
          columns.map((c) => (row ? String(row[String(c?.field ?? '')] ?? '') : String(c?.header ?? '')));
        rows.push(columnsRow(cellsOf(null), weights, total, dpi));
        for (const row of data) {
          // 末列右贴（金额惯例，C# ColumnsRow 同口径）
          rows.push(columnsRow(cellsOf(row as Json), weights, total, dpi, true));
        }
        break;
      }
      default:
        warnings.push(`unknown-element: ${String(type)}（${path}，已跳过）`);
    }
  }

  const heightDots = Math.max(
    lineDots(1, dpi),
    rows.reduce((a, r) => a + r.heightDots, 0),
  );
  const canvas = new MonoCanvas(widthDots, heightDots);
  let y = 0;
  for (const row of rows) {
    await row.paint(canvas, provider, y);
    y += row.heightDots;
  }
  return { canvas, warnings, widthDots, heightDots };
}

type Align = 'left' | 'center' | 'right';

/** 对齐三态（C# AlignX 同语义：center→(w-c)/2、right→w-c、负值钳 0）。 */
function alignX(align: Align, contentDots: number, widthDots: number): number {
  if (align === 'center') return Math.max(0, Math.floor((widthDots - contentDots) / 2));
  if (align === 'right') return Math.max(0, widthDots - contentDots);
  return 0;
}

/** 收据字号：style.fontSize 字符串档（normal/double/quadruple → 1/2/4，24dot 栅格）；
 *  数值 pt → 字号 pt→dot 精确折算（ADR-0009 half-up，1pt=1/72in），行高取
 *  max(基准行, 字号)。 */
function resolveReceiptFont(style: Json, dpi: number): { sizeDots: number; rowDots: number } {
  const fs = style.fontSize;
  if (typeof fs === 'number' && Number.isFinite(fs) && fs > 0) {
    const sizeDots = ptToDots(fs, dpi);
    return { sizeDots, rowDots: Math.max(sizeDots, lineDots(1, dpi)) };
  }
  let scale = 1;
  if (fs === 'double') scale = 2;
  else if (fs === 'quadruple') scale = 4;
  return { sizeDots: lineDots(scale, dpi), rowDots: lineDots(scale, dpi) };
}

/** 超宽截断（与热敏打印截断一致）：返回可画文本 + 截断标记。 */
async function truncateToWidth(
  provider: FontProvider,
  text: string,
  maxWidth: number,
  sizeDots: number,
): Promise<{ text: string; missing: string[] }> {
  const run = await provider.layout(text, sizeDots);
  if (run.width <= maxWidth || maxWidth <= 0) return { text, missing: run.missing };
  let acc = 0;
  let cut = 0;
  for (const b of run.boxes) {
    if (acc + b.advance > maxWidth) break;
    acc += b.advance;
    cut++;
  }
  const clipped = [...text].slice(0, cut).join('');
  const rerun = await provider.layout(clipped, sizeDots);
  return { text: clipped, missing: rerun.missing };
}

/** 文本行物化（截断 + missing 汇总）。 */
async function planTextRow(
  provider: FontProvider,
  text: string,
  scale: number,
  align: Align,
  widthDots: number,
  dpi: number,
  bold: boolean,
  underline: boolean,
): Promise<PlannedRow> {
  const sizeDots = lineDots(scale, dpi);
  const rowH = lineDots(scale, dpi);
  const drawn = await truncateToWidth(provider, text, widthDots, sizeDots);
  return {
    heightDots: rowH,
    paint: async (canvas, prov, y) => {
      if (!drawn.text) return;
      const run = await prov.layout(drawn.text, sizeDots);
      await drawText(canvas, prov, drawn.text, {
        x: alignX(align, run.width, canvas.width),
        y,
        sizeDots,
        bold,
        underline,
      });
    },
  };
}

/** 多列文本行（C# ColumnsRow 同口径：列宽按权重分配、逐格截断、末列右贴可选）。 */
function columnsRow(
  cells: string[],
  weights: number[],
  total: number,
  dpi: number,
  lastRight = false,
): PlannedRow {
  const rowH = lineDots(1, dpi);
  const sizeDots = lineDots(1, dpi);
  const layout = cells.map((cell, i) => ({
    cell,
    weight: Math.max(1, weights[i] ?? 1),
    right: lastRight && i === cells.length - 1,
  }));
  return {
    heightDots: rowH,
    paint: async (canvas, prov, y) => {
      const widthDots = canvas.width;
      let cx = 0;
      for (let i = 0; i < layout.length; i++) {
        const item = layout[i];
        const cellDots = Math.floor((widthDots * item.weight) / total);
        const text = i < layout.length - 1 ? (await truncateToWidth(prov, item.cell, cellDots, sizeDots)).text : item.cell;
        if (text) {
          const run = await prov.layout(text, sizeDots);
          const tx = item.right ? Math.max(cx, cx + cellDots - run.width) : cx;
          await drawText(canvas, prov, text, { x: tx, y, sizeDots });
        }
        cx += cellDots;
      }
    },
  };
}

/** 居中块行（barcode/qrcode）。 */
function blockRow(mask: InkMask, align: Align, heightDots: number): PlannedRow {
  return {
    heightDots,
    paint: async (canvas, _prov, y) => {
      const drawW = Math.min(mask.width, canvas.width);
      const x = alignX(align, drawW, canvas.width);
      for (let dy = 0; dy < mask.height && y + dy < canvas.height; dy++) {
        for (let dx = 0; dx < drawW; dx++) {
          if (mask.data[dy * mask.width + dx]) canvas.set(x + dx, y + dy, 0);
        }
      }
    },
  };
}
