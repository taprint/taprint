// SPDX-License-Identifier: Apache-2.0
// 长度折算单测（ADR-0009 half-up away-from-zero）：mm/pt→dot 中点与边界例。
import { describe, expect, it } from 'vitest';
import { dotsPerMm, lengthToDots, mmToDots, parseMm, ptToDots } from '../src/length.ts';
import { dotFromMm, roundHalfAwayFromZero } from 'taprint';

describe('length 折算（ADR-0009 half-up）', () => {
  it('length 文法 → mm：mm/cm/pt/px（与 taprint-java LengthUtil 同推导）', () => {
    expect(parseMm('70mm')).toBe(70);
    expect(parseMm('1.5cm')).toBeCloseTo(15, 10);
    expect(parseMm('72pt')).toBeCloseTo(25.4, 10);
    expect(parseMm('96px')).toBeCloseTo(25.4, 10);
    expect(parseMm('bogus', 3)).toBe(3);
    expect(parseMm(undefined, 5)).toBe(5);
  });

  it('mm→dot half-up：0.0423mm@300dpi→0、0.0424mm@300dpi→1（dot 边界两侧）', () => {
    expect(mmToDots(0.0423, 300)).toBe(0);
    expect(mmToDots(0.0424, 300)).toBe(1);
  });

  it('mm→dot：12.7mm@203dpi=101.5→102（half-up 中点进位）；与内核 dotFromMm 同语义', () => {
    expect(mmToDots(12.7, 203)).toBe(102);
    expect(mmToDots(12.7, 203)).toBe(dotFromMm(12.7, 203 / 25.4));
  });

  it('pt→dot 精确折算：12pt@300dpi=50、6.3pt@203dpi=18、8.5pt@203dpi=24（half-up）', () => {
    expect(ptToDots(12, 300)).toBe(50);
    expect(ptToDots(6.3, 203)).toBe(18); // 17.7625 → 18
    expect(ptToDots(8.5, 203)).toBe(24); // 23.9799… → 24
  });

  it('pt→dot 中点走 away-from-zero：roundHalfAwayFromZero(2.5)===3（内核公共件同源）', () => {
    expect(roundHalfAwayFromZero(2.5)).toBe(3);
    expect(roundHalfAwayFromZero(-2.5)).toBe(-3);
  });

  it('dpi 非法值显式抛错；lengthToDots 兜底 fallback', () => {
    expect(() => dotsPerMm(0)).toThrow(RangeError);
    expect(() => ptToDots(-1, 203)).toThrow(RangeError);
    expect(lengthToDots('nope', 203, 10)).toBe(mmToDots(10, 203));
  });
});
