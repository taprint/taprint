// SPDX-License-Identifier: Apache-2.0
// 长度换算（ADR-0009）：DSL length 文法 mm/cm/pt/px → mm；mm/pt → dot 一律
// half-up away-from-zero（taprint 内核 roundHalfAwayFromZero 同语义）。
//
// 与内核 8 dot/mm 口径的关系：内核编码器按 8 dot/mm（203dpi TSPL / 200dpi CPCL
// 通行口径）出字节流；本包是预览渲染，按显式 dpi（203/300）取真实折算
// dotsPerMm = dpi / 25.4 —— 与 taprint-java LengthUtil.DOTS_PER_MM 同推导，
// 中点方向同为 half-up（ADR-0009 §1）。
import { dotFromMm, roundHalfAwayFromZero } from 'taprint';

/** length 字面量 → mm（"70mm"→70、"1.5cm"→15、"12pt"→25.4/72、"96px"→25.4；非法 → fallback）。 */
export function parseMm(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return fallback;
  const s = value.trim().toLowerCase();
  const m = s.match(/^(\d+(?:\.\d+)?)\s*(mm|cm|pt|px)?$/);
  if (!m) return fallback;
  const n = Number(m[1]);
  switch (m[2]) {
    case 'cm':
      return n * 10;
    case 'pt':
      return (n * 25.4) / 72;
    case 'px':
      return (n * 25.4) / 96;
    default:
      return n;
  }
}

/** dpi → dotsPerMm（203 → 7.9921259…、300 → 11.8110236…）。 */
export function dotsPerMm(dpi: number): number {
  if (!Number.isFinite(dpi) || dpi <= 0) {
    throw new RangeError(`dpi 必须为正有限数（实际：${dpi}）`);
  }
  return dpi / 25.4;
}

/** mm → dot（按显式 dpi 折算，half-up）。 */
export function mmToDots(mm: number, dpi: number): number {
  return dotFromMm(mm, dotsPerMm(dpi));
}

/** length 字面量 → dot（按显式 dpi 折算，half-up；非法 → fallbackMm 兜底）。 */
export function lengthToDots(value: unknown, dpi: number, fallbackMm = 0): number {
  return mmToDots(parseMm(value, fallbackMm), dpi);
}

/**
 * 字号 pt → glyph 高 dot（按显式 dpi 折算，half-up；1pt = 1/72 inch）。
 * 例：12pt@300dpi = 50；6.3pt@203dpi = 17.7625 → 18；8.5pt@203dpi = 23.98 → 24。
 */
export function ptToDots(pt: number, dpi: number): number {
  if (!Number.isFinite(pt) || pt <= 0) {
    throw new RangeError(`pt 必须为正有限数（实际：${pt}）`);
  }
  return roundHalfAwayFromZero((pt * dpi) / 72);
}
