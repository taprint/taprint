// SPDX-License-Identifier: Apache-2.0
// receipt 呈现（presentations.receipt）→ ESC/POS 行序：内核 EscPosBuilder
// 命令级纯函数逐帧拼接（能力边界显式报错：barcode/image/rect/spacer/pageBreak
// 不在内核共享子集或 v0.1 范围）。列宽按显示宽度近似（CJK 双宽）。
import { EscPosBuilder, concatBytes, type EscPosAlign, type EscPosFontSize } from 'taprint';
import { ToolError } from './errors.ts';
import { renderTemplateString } from './template-string.ts';

type Json = Record<string, unknown>;

/** mm 纸宽 → ESC/POS 列数近似（80mm≈48 列 / 58mm≈32 列；其余按 32 列）。 */
export function receiptColumns(widthMm: number | undefined): number {
  if (widthMm === undefined) return 32;
  if (widthMm >= 76) return 48;
  return 32;
}

/** 显示宽度（CJK/全角按 2 列近似——GBK 双字节同口径）。 */
function displayWidth(text: string): number {
  let w = 0;
  for (const ch of text) w += ch.charCodeAt(0) > 0xff ? 2 : 1;
  return w;
}

/** 按显示宽度截断。 */
function truncateWidth(text: string, maxCols: number): string {
  let w = 0;
  let out = '';
  for (const ch of text) {
    const cw = ch.charCodeAt(0) > 0xff ? 2 : 1;
    if (w + cw > maxCols) break;
    out += ch;
    w += cw;
  }
  return out;
}

/** 单元格文本：截断 + 对齐补空。 */
function cell(text: string, widthCols: number, align: string | undefined): string {
  const clipped = truncateWidth(text, widthCols);
  const pad = Math.max(0, widthCols - displayWidth(clipped));
  if (align === 'right') return ' '.repeat(pad) + clipped;
  if (align === 'center') {
    const left = Math.floor(pad / 2);
    return ' '.repeat(left) + clipped + ' '.repeat(pad - left);
  }
  return clipped + ' '.repeat(pad);
}

export interface ReceiptMapping {
  bytes: Uint8Array;
  summary: string[];
}

/** receipt 呈现 → ESC/POS 字节帧序 + 元素级行序摘要。 */
export function mapReceiptPresentation(
  pres: Json,
  scope: Record<string, unknown>,
): ReceiptMapping {
  const widthMm = pres.width !== undefined && typeof pres.width !== 'object' ? mmNumber(pres.width) : undefined;
  const cols = receiptColumns(widthMm);
  const resolve = (tpl: string) => renderTemplateString(tpl, scope);
  const parts: Uint8Array[] = [];
  const summary: string[] = [];

  const initCommands = pres.initCommands;
  if (Array.isArray(initCommands)) {
    for (const mnemonic of initCommands) {
      const bytes = EscPosBuilder.mapCommand(String(mnemonic));
      if (!bytes) {
        throw new ToolError('unsupported-command', `initCommands 助记符 "${String(mnemonic)}" 不在内核白名单（仅 ESC @ / GS V 0|1）`);
      }
      parts.push(bytes);
      summary.push(`INIT ${String(mnemonic).trim()}`);
    }
  } else {
    parts.push(EscPosBuilder.initialize());
    summary.push('INIT ESC @');
  }

  const body = pres.body;
  if (!Array.isArray(body)) {
    throw new ToolError('bad-presentation', 'presentations.receipt 缺 body 数组');
  }

  body.forEach((raw, i) => {
    const el = raw as Json;
    const path = `presentations.receipt.body[${i}]`;
    const type = el?.type;
    switch (type) {
      case 'text': {
        const text = resolve(String(el.content ?? ''));
        const style = (el.style ?? {}) as Json;
        const options = {
          align: (typeof el.align === 'string' ? el.align : 'left') as EscPosAlign,
          fontSize: (typeof style.fontSize === 'string' ? style.fontSize : 'normal') as EscPosFontSize,
          bold: style.bold === true,
        };
        parts.push(EscPosBuilder.textLine(text, options));
        summary.push(
          `TEXT align=${options.align} size=${options.fontSize}${options.bold ? ' bold' : ''} "${truncate(text)}"`,
        );
        break;
      }
      case 'line': {
        const style = typeof el.lineStyle === 'string' ? el.lineStyle : 'solid';
        parts.push(EscPosBuilder.divider(cols));
        summary.push(
          style === 'solid'
            ? `DIVIDER '-'×${cols}`
            : `DIVIDER '-'×${cols}（lineStyle=${style} 降级 solid——内核 divider 仅 '-'）`,
        );
        break;
      }
      case 'kvtable': {
        const rows = el.rows;
        if (!Array.isArray(rows)) {
          throw new ToolError('bad-presentation', `${path}：kvtable 缺 rows`);
        }
        let lines = 0;
        for (const group of rows) {
          if (!Array.isArray(group)) continue;
          for (const entry of group) {
            if (!Array.isArray(entry) || entry.length < 2) continue;
            const label = resolve(String(entry[0]));
            const value = resolve(String(entry[1]));
            const line = `${label}: ${value}`;
            parts.push(EscPosBuilder.textLine(line));
            lines += 1;
          }
        }
        summary.push(`KVTABLE ${lines} 行`);
        break;
      }
      case 'table': {
        const source = String(el.source ?? '');
        const columns = Array.isArray(el.columns) ? (el.columns as Json[]) : [];
        const rows = scope[source];
        if (!Array.isArray(rows)) {
          throw new ToolError(
            'missing-data',
            `${path}：table 源 "${source}" 未提供数据（compile 入参 data 需含该明细数组）`,
          );
        }
        const widths = columns.map((c) => {
          const pct = typeof c.width === 'string' ? Number.parseFloat(c.width) : NaN;
          return Number.isFinite(pct) ? Math.max(4, Math.round((pct / 100) * cols)) : Math.floor(cols / Math.max(1, columns.length));
        });
        parts.push(
          EscPosBuilder.textLine(
            columns.map((c, ci) => cell(String(c.header ?? ''), widths[ci], typeof c.align === 'string' ? c.align : undefined)).join(''),
            { bold: true },
          ),
        );
        for (const row of rows) {
          const rec = (row ?? {}) as Record<string, unknown>;
          parts.push(
            EscPosBuilder.textLine(
              columns
                .map((c, ci) => cell(resolve(String(rec[String(c.field)] ?? '')), widths[ci], typeof c.align === 'string' ? c.align : undefined))
                .join(''),
            ),
          );
        }
        summary.push(`TABLE ${source} ${rows.length + 1} 行 × ${columns.length} 列（列宽 ${widths.join('/')}）`);
        break;
      }
      case 'qrcode': {
        const content = resolve(String(el.content ?? ''));
        const moduleSize = typeof el.size === 'number' ? el.size : 6;
        parts.push(EscPosBuilder.qrCode(content, moduleSize));
        summary.push(content === '' ? 'QRCODE (空内容跳过)' : `QRCODE 原生五步 module=${moduleSize}`);
        break;
      }
      case 'cut': {
        const partial = el.partial !== false;
        parts.push(EscPosBuilder.cut(partial));
        summary.push(`CUT GS V ${partial ? 1 : 0}`);
        break;
      }
      case 'cashDrawer': {
        // Dart 便捷档口径：pulse 2 → 引脚 5，否则引脚 2；t1=t2=0x19。
        const pin = (el.pulse === 2 ? 1 : 0) as 0 | 1;
        parts.push(EscPosBuilder.drawerKickPulse(pin, 0x19, 0x19));
        summary.push(`CASHDRAWER ESC p pin=${pin} t=0x19/0x19`);
        break;
      }
      case 'barcode': {
        // 内核 Dart 兜底口径：ESC/POS 共享子集无条码命令，未知元素按空行占位。
        // 本层同口径跳过并显式记 WARN（帧序可见，不静默丢失）。
        parts.push(EscPosBuilder.lineFeed());
        summary.push(`WARN barcode[${i}] 跳过（空行占位）——ESC/POS 条码命令不在内核共享子集；条码需求请走 qrcode 或标签呈现`);
        break;
      }
      case 'image':
      case 'rect':
      case 'spacer':
      case 'pageBreak': {
        throw new ToolError(
          'unsupported-element',
          `${path}：${String(type)} 元素不在 v0.1 收据编码范围（ADR-0008；光栅化属 v0.3）`,
        );
      }
      default: {
        throw new ToolError('unsupported-element', `${path}：未知元素类型 "${String(type)}"`);
      }
    }
  });

  const tailCommands = pres.tailCommands;
  if (Array.isArray(tailCommands)) {
    for (const mnemonic of tailCommands) {
      const bytes = EscPosBuilder.mapCommand(String(mnemonic));
      if (!bytes) {
        throw new ToolError('unsupported-command', `tailCommands 助记符 "${String(mnemonic)}" 不在内核白名单（仅 ESC @ / GS V 0|1）`);
      }
      parts.push(bytes);
      summary.push(`TAIL ${String(mnemonic).trim()}`);
    }
  }

  return { bytes: concatBytes(...parts), summary };
}

function mmNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const m = value.trim().match(/^(\d+(?:\.\d+)?)\s*mm$/);
    if (m) return Number(m[1]);
  }
  return undefined;
}

function truncate(text: string, max = 24): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
