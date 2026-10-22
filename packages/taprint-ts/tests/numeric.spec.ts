// SPDX-License-Identifier: Apache-2.0
// ADR-0009 数值规范单测：中点值（half-up away-from-zero）与定点格式化锁定。
import { describe, expect, it } from 'vitest';
import { clampInt, dotFromMm, formatFixed, formatMm, requireInt, roundHalfAwayFromZero } from '../src/index';

describe('roundHalfAwayFromZero（中点锁定）', () => {
  it('正中点进位：2.5 → 3', () => {
    expect(roundHalfAwayFromZero(2.5)).toBe(3);
  });
  it('负中点远离零：-2.5 → -3（Math.round 为 -2，语义相反——禁用理由）', () => {
    expect(Math.round(-2.5)).toBe(-2);
    expect(roundHalfAwayFromZero(-2.5)).toBe(-3);
  });
  it('非中点正常取整：-2.4 → -2、-0.4 → 0（非 -0）', () => {
    expect(roundHalfAwayFromZero(-2.4)).toBe(-2);
    expect(roundHalfAwayFromZero(-0.4)).toBe(0);
    expect(Object.is(roundHalfAwayFromZero(-0.4), -0)).toBe(false);
  });
  it('非有限数抛 TypeError', () => {
    expect(() => roundHalfAwayFromZero(Number.NaN)).toThrow(TypeError);
    expect(() => roundHalfAwayFromZero(Number.POSITIVE_INFINITY)).toThrow(TypeError);
  });
});

describe('dotFromMm（mm→dot 折算）', () => {
  it('缺省 8 dot/mm：12.7mm → 102（101.6 进位）', () => {
    expect(dotFromMm(12.7)).toBe(102);
  });
  it('中点：0.3125mm × 8 = 2.5 dot → 3；负值 → -3', () => {
    expect(dotFromMm(0.3125, 8)).toBe(3);
    expect(dotFromMm(-0.3125, 8)).toBe(-3);
  });
  it('中点：0.0625mm × 8 = 0.5 dot → 1；负值 → -1', () => {
    expect(dotFromMm(0.0625, 8)).toBe(1);
    expect(dotFromMm(-0.0625, 8)).toBe(-1);
  });
  it('203dpi（203/25.4 dot/mm）下 12.7mm 恰为 101.5 dot 中点 → 102', () => {
    expect(12.7 * (203 / 25.4)).toBe(101.5); // 浮点乘积恰为精确中点（前置自证）
    expect(dotFromMm(12.7, 203 / 25.4)).toBe(102);
  });
  it('dotsPerMm 非正/非有限抛错', () => {
    expect(() => dotFromMm(1, 0)).toThrow(RangeError);
    expect(() => dotFromMm(1, -8)).toThrow(RangeError);
    expect(() => dotFromMm(1, Number.NaN)).toThrow(RangeError);
  });
});

describe('formatFixed（定点格式化）', () => {
  it('中点：2.5 位 0 → "3"；-2.5 → "-3"', () => {
    expect(formatFixed(2.5, 0)).toBe('3');
    expect(formatFixed(-2.5, 0)).toBe('-3');
  });
  it('中点：0.125 位 2 → "0.13"；-0.125 → "-0.13"（0.125 为二进制精确值）', () => {
    expect(formatFixed(0.125, 2)).toBe('0.13');
    expect(formatFixed(-0.125, 2)).toBe('-0.13');
  });
  it('缩放后中点：2.675 位 2 → "2.68"（2.675×100 恰为 267.5）', () => {
    expect(2.675 * 100).toBe(267.5); // 前置自证：缩放乘积恰为中点
    expect(formatFixed(2.675, 2)).toBe('2.68');
  });
  it('固定位数补零：1 位 2 → "1.00"', () => {
    expect(formatFixed(1, 2)).toBe('1.00');
  });
  it('无科学计数法：大值/小值均十进制定点', () => {
    expect(formatFixed(1234567, 2)).toBe('1234567.00');
    expect(formatFixed(0.000001, 6)).toBe('0.000001');
  });
  it('fractionDigits 越界抛错', () => {
    expect(() => formatFixed(1, -1)).toThrow(RangeError);
    expect(() => formatFixed(1, 21)).toThrow(RangeError);
    expect(() => formatFixed(1, 1.5)).toThrow(RangeError);
  });
});

describe('formatMm（毫米字段：裁尾零 + -0 归一）', () => {
  it('整数值不带小数：40 → "40"', () => {
    expect(formatMm(40)).toBe('40');
  });
  it('尾零裁剪：40.5 → "40.5"、40.25 → "40.25"、40.256 → "40.26"', () => {
    expect(formatMm(40.5)).toBe('40.5');
    expect(formatMm(40.25)).toBe('40.25');
    expect(formatMm(40.256)).toBe('40.26');
  });
  it('近似零归一："0"（非 "-0"/"0.00"）', () => {
    expect(formatMm(0)).toBe('0');
    expect(formatMm(-0.001)).toBe('0');
  });
});

describe('参数工具', () => {
  it('requireInt：非整数抛 TypeError', () => {
    expect(requireInt(3, 'n')).toBe(3);
    expect(() => requireInt(1.5, 'n')).toThrow(TypeError);
  });
  it('clampInt：区间夹取', () => {
    expect(clampInt(-1, 0, 15)).toBe(0);
    expect(clampInt(99, 1, 10)).toBe(10);
    expect(clampInt(5, 1, 10)).toBe(5);
  });
});
