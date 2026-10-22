// SPDX-License-Identifier: Apache-2.0
// 协议命令流数值规范公共件（ADR-0009：Canonical numeric and encoding rules）。
//
// 铁则：
// 1. mm→dot 折算一律 half-up away-from-zero——禁止直用 Math.round（其负数中点
//    语义相反：Math.round(-2.5) === -2，而规范要求 -3）；
// 2. 命令流中的数字字段一律走本文件的定点格式化——禁止裸 toString/toFixed
//    （平台默认浮点转字符串产生最短表示变体，跨语言字节不可对齐；toFixed
//    的中点取整方向属实现细节，不构成跨语言契约）。
// 多语言实现（TS/C#/Dart/Java）必须复现同语义。

/** 校验值为有限数（NaN/Infinity 抛错——编码器不得产出此类字段）。 */
function assertFinite(value: number, name: string): void {
  if (!Number.isFinite(value)) {
    throw new TypeError(`${name} 必须为有限数值（实际：${value}）`);
  }
}

/**
 * half-up away-from-zero 取整（ADR-0009 §1）。
 * 2.5 → 3；-2.5 → -3（远离零）；-2.4 → -2；-0.4 → 0（非 -0）。
 */
export function roundHalfAwayFromZero(value: number): number {
  assertFinite(value, 'value');
  const magnitude = Math.abs(value);
  const floor = Math.floor(magnitude);
  const rounded = floor + (magnitude - floor >= 0.5 ? 1 : 0);
  const signed = value < 0 ? -rounded : rounded;
  // -0 归一为 +0（定点格式化与跨语言字节比较不受负零干扰）
  return signed === 0 ? 0 : signed;
}

/**
 * mm → dot 折算：dot = roundHalfAwayFromZero(mm × dotsPerMm)。
 * 缺省 8 dot/mm（203dpi/200dpi 标签机通行折算口径）。
 * 中点例：dotFromMm(2.5, 1) === 3、dotFromMm(-2.5, 1) === -3、
 * dotFromMm(0.3125, 8) === 3（2.5 dot 精确中点）；dotFromMm(12.7, 8) === 102。
 */
export function dotFromMm(mm: number, dotsPerMm = 8): number {
  assertFinite(mm, 'mm');
  if (!Number.isFinite(dotsPerMm) || dotsPerMm <= 0) {
    throw new RangeError(`dotsPerMm 必须为正有限数（实际：${dotsPerMm}）`);
  }
  return roundHalfAwayFromZero(mm * dotsPerMm);
}

/**
 * 定点数字格式化（ADR-0009 §2）：按 fractionDigits 位小数 half-away-from-zero
 * 取整后输出十进制定点串（不出现科学计数法，不出现 "-0"）。
 * 中点例：formatFixed(2.5, 0) === "3"、formatFixed(-2.5, 0) === "-3"、
 * formatFixed(0.125, 2) === "0.13"（0.125 为二进制精确值，中点可见）。
 */
export function formatFixed(value: number, fractionDigits: number): string {
  assertFinite(value, 'value');
  if (!Number.isInteger(fractionDigits) || fractionDigits < 0 || fractionDigits > 20) {
    throw new RangeError(`fractionDigits 须为 0-20 的整数（实际：${fractionDigits}）`);
  }
  const scale = 10 ** fractionDigits;
  const scaled = roundHalfAwayFromZero(value * scale);
  const negative = scaled < 0;
  let digits = Math.abs(scaled).toString();
  if (fractionDigits === 0) return negative ? `-${digits}` : digits;
  digits = digits.padStart(fractionDigits + 1, '0');
  const cut = digits.length - fractionDigits;
  const text = `${digits.slice(0, cut)}.${digits.slice(cut)}`;
  return negative ? `-${text}` : text;
}

/**
 * 毫米字段格式化：formatFixed 后裁尾零（"40.00" → "40"、"40.50" → "40.5"），
 * 全零小数归 "0"（-0 归一）。命令流 SIZE/GAP 等毫米参数的唯一出口。
 */
export function formatMm(value: number, maxFractionDigits = 2): string {
  const fixed = formatFixed(value, maxFractionDigits);
  if (!fixed.includes('.')) return fixed;
  const trimmed = fixed.replace(/0+$/, '').replace(/\.$/, '');
  return trimmed === '-0' ? '0' : trimmed;
}

/** 整数参数校验（点阵坐标/字节数等——非整数直接抛 TypeError）。 */
export function requireInt(value: number, name: string): number {
  if (!Number.isInteger(value)) {
    throw new TypeError(`${name} 必须为整数（实际：${value}）`);
  }
  return value;
}

/** 整数区间夹取（clamp——越界值收敛到边界，不抛错）。 */
export function clampInt(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}
