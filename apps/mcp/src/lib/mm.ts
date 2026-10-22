// SPDX-License-Identifier: Apache-2.0
// 长度度量换算：DSL 的 length 文法（"70mm"/"1.5mm"/数字）与 mm↔dot（内核
// LABEL_DOTS_PER_MM=8，即 203dpi TSPL / 200dpi CPCL 通行口径）。
import { LABEL_DOTS_PER_MM } from 'taprint';
import { ToolError } from './errors.ts';

/** length 字面量 → mm 数值（"70mm"→70、1.5→1.5；非 mm 单位显式报错）。 */
export function mmOf(value: unknown, path: string): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const m = value.trim().match(/^(-?\d+(?:\.\d+)?)\s*mm$/);
    if (m) return Number(m[1]);
  }
  throw new ToolError(
    'bad-length',
    `${path} 非法长度 "${String(value)}"（v0.1 只接受 mm 字面量或数值，如 "70mm" / 1.5）`,
  );
}

/** dot 数 → mm（标签线宽 thickness 以 dot 计，1-32 域）。 */
export function mmFromDots(dots: number): number {
  return dots / LABEL_DOTS_PER_MM;
}
