// SPDX-License-Identifier: Apache-2.0
// GBK 子集表编码单测：表内双字节、表外占位策略（U+FFFD 默认 / '?' 兼容档）、
// 码点级迭代与表完整性巡检。
import { describe, expect, it } from 'vitest';
import {
  GBK_REPLACEMENT_BYTES,
  GBK_SUBSET_TABLE,
  gbkEncode,
} from '../src/internal/gbk.ts';

const bytes = (s: string) => [...gbkEncode(s)];

describe('gbkEncode（ASCII 与表内字符）', () => {
  it('ASCII 原样单字节', () => {
    expect(bytes('ABC123')).toEqual([0x41, 0x42, 0x43, 0x31, 0x32, 0x33]);
  });
  it('空串 → 0 字节', () => {
    expect(gbkEncode('').length).toBe(0);
  });
  it('商业核心词：收银 → CA D5 D2 F8；销售单 → CF FA CA DB B5 A5', () => {
    expect(bytes('收银')).toEqual([0xca, 0xd5, 0xd2, 0xf8]);
    expect(bytes('销售单')).toEqual([0xcf, 0xfa, 0xca, 0xdb, 0xb5, 0xa5]);
  });
  it('日期词：年月日 → C4 EA D4 C2 C8 D5', () => {
    expect(bytes('年月日')).toEqual([0xc4, 0xea, 0xd4, 0xc2, 0xc8, 0xd5]);
  });
  it('中文标点：单号： → B5 A5 BA C5 A3 BA（全角冒号双字节）', () => {
    expect(bytes('单号：')).toEqual([0xb5, 0xa5, 0xba, 0xc5, 0xa3, 0xba]);
  });
  it('全角字母：Ｍ → A3 CD；顿号 、 → A1 A4（Dart 源保守取值锁定）', () => {
    expect(bytes('Ｍ')).toEqual([0xa3, 0xcd]);
    expect(bytes('、')).toEqual([0xa1, 0xa4]);
  });
});

describe('gbkEncode（表外占位策略）', () => {
  it('默认 replacement：表外字符 → U+FFFD 的 UTF-8 字节 EF BF BD（ADR-0009）', () => {
    expect(bytes('囍')).toEqual([...GBK_REPLACEMENT_BYTES]);
    expect(bytes('A囍B')).toEqual([0x41, 0xef, 0xbf, 0xbd, 0x42]);
  });
  it('question 档（Dart 源兼容）：表外字符 → 单字节 0x3F', () => {
    expect([...gbkEncode('囍', { unmapped: 'question' })]).toEqual([0x3f]);
  });
  it('码点级迭代：代理对（U+20000 表外）整体只产生一个占位符', () => {
    const out = gbkEncode('𠀀');
    expect(out.length).toBe(3);
    expect([...out]).toEqual([...GBK_REPLACEMENT_BYTES]);
  });
});

describe('GBK 子集表完整性巡检', () => {
  it('表规模 ≥ 150 条目（移植完整性哨兵）', () => {
    expect(GBK_SUBSET_TABLE.size).toBeGreaterThanOrEqual(150);
  });
  it('双字节域合规：首字节 0x81-0xFE，次字节 0x40-0xFE 且非 0x7F', () => {
    for (const [codePoint, pair] of GBK_SUBSET_TABLE) {
      expect(codePoint).toBeGreaterThanOrEqual(0x80);
      expect(pair[0]).toBeGreaterThanOrEqual(0x81);
      expect(pair[0]).toBeLessThanOrEqual(0xfe);
      expect(pair[1]).toBeGreaterThanOrEqual(0x40);
      expect(pair[1]).toBeLessThanOrEqual(0xfe);
      expect(pair[1]).not.toBe(0x7f);
    }
  });
  it('表内样点抽查：年=C4EA、金=BDF0、印=D3A1', () => {
    expect(GBK_SUBSET_TABLE.get(0x5e74)).toEqual([0xc4, 0xea]);
    expect(GBK_SUBSET_TABLE.get(0x91d1)).toEqual([0xbd, 0xf0]);
    expect(GBK_SUBSET_TABLE.get(0x5370)).toEqual([0xd3, 0xa1]);
  });
});
