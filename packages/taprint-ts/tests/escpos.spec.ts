// SPDX-License-Identifier: Apache-2.0
// ESC/POS 构造器单测：命令字节冻结、QR 五步序列、帧序（自检票）、钱箱/切纸形态。
import { describe, expect, it } from 'vitest';
import { asciiBytes, concatBytes, indexOfBytes } from '../src/index';
import { EscPosBuilder } from '../src/index';

const u8 = (...n: number[]) => Uint8Array.from(n);
const eq = (actual: Uint8Array, expected: number[]) => expect([...actual]).toEqual(expected);
const has = (stream: Uint8Array, pattern: number[]) =>
  expect(indexOfBytes(stream, u8(...pattern))).toBeGreaterThanOrEqual(0);

describe('基础命令字节冻结', () => {
  it('initialize → ESC @（1B 40）', () => {
    eq(EscPosBuilder.initialize(), [0x1b, 0x40]);
  });
  it('lineFeed → LF；feedLines 3 → ESC d 3，越界夹 255', () => {
    eq(EscPosBuilder.lineFeed(), [0x0a]);
    eq(EscPosBuilder.feedLines(3), [0x1b, 0x64, 0x03]);
    eq(EscPosBuilder.feedLines(300), [0x1b, 0x64, 0xff]);
    expect(() => EscPosBuilder.feedLines(1.5)).toThrow(TypeError);
  });
  it('align：left/center/right → ESC a 0/1/2；非法值抛错', () => {
    eq(EscPosBuilder.align('left'), [0x1b, 0x61, 0x00]);
    eq(EscPosBuilder.align('center'), [0x1b, 0x61, 0x01]);
    eq(EscPosBuilder.align('right'), [0x1b, 0x61, 0x02]);
    expect(() => EscPosBuilder.align('centre' as never)).toThrow(RangeError);
  });
  it('fontSize：normal/tall/wide/double/triple/quadruple 位组合', () => {
    eq(EscPosBuilder.fontSize('normal'), [0x1d, 0x21, 0x00]);
    eq(EscPosBuilder.fontSize('tall'), [0x1d, 0x21, 0x01]);
    eq(EscPosBuilder.fontSize('wide'), [0x1d, 0x21, 0x10]);
    eq(EscPosBuilder.fontSize('double'), [0x1d, 0x21, 0x11]);
    eq(EscPosBuilder.fontSize('triple'), [0x1d, 0x21, 0x22]);
    eq(EscPosBuilder.fontSize('quadruple'), [0x1d, 0x21, 0x33]);
  });
  it('bold 开关 ESC E n；FS & 选择中文字符集', () => {
    eq(EscPosBuilder.bold(true), [0x1b, 0x45, 0x01]);
    eq(EscPosBuilder.bold(false), [0x1b, 0x45, 0x00]);
    eq(EscPosBuilder.selectChineseEncoding(), [0x1c, 0x26]);
  });
});

describe('文本编码', () => {
  it('encodeText 走 GBK 子集：收 → CA D5', () => {
    eq(EscPosBuilder.encodeText('收'), [0xca, 0xd5]);
  });
  it('encodeAscii：超 ASCII 降 ?（0x3F）', () => {
    eq(EscPosBuilder.encodeAscii('Aé'), [0x41, 0x3f]);
  });
  it('textLine 帧结构：对齐 + 字号 + 粗体 → GBK 行 + LF → 回落复位', () => {
    const frame = EscPosBuilder.textLine('收银', { align: 'center', fontSize: 'double', bold: true });
    eq(frame, [
      0x1b, 0x61, 0x01,
      0x1d, 0x21, 0x11,
      0x1b, 0x45, 0x01,
      0xca, 0xd5, 0xd2, 0xf8, 0x0a,
      0x1d, 0x21, 0x00,
      0x1b, 0x45, 0x00,
    ]);
  });
  it('textLine 多行：逐行 LF', () => {
    const frame = EscPosBuilder.textLine('A\nB');
    eq(frame, [0x1b, 0x61, 0x00, 0x1d, 0x21, 0x00, 0x1b, 0x45, 0x00, 0x41, 0x0a, 0x42, 0x0a, 0x1d, 0x21, 0x00, 0x1b, 0x45, 0x00]);
  });
  it('divider：左对齐 + "-"×n + LF', () => {
    eq(EscPosBuilder.divider(4), [0x1b, 0x61, 0x00, 0x2d, 0x2d, 0x2d, 0x2d, 0x0a]);
  });
});

describe('QR 原生五步序列', () => {
  it("内容 'AB'（模块 6）：模型 2 → 模块 → 纠错 M → 存数据(pL=5) → 打印 + LF", () => {
    eq(EscPosBuilder.qrCode('AB'), [
      0x1d, 0x28, 0x6b, 0x04, 0x00, 0x31, 0x41, 0x02, 0x00,
      0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x43, 0x06,
      0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x45, 0x31,
      0x1d, 0x28, 0x6b, 0x05, 0x00, 0x31, 0x50, 0x30, 0x41, 0x42,
      0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x51, 0x30,
      0x0a,
    ]);
  });
  it('模块大小夹 1-16：20→0x10、0→0x01', () => {
    has(EscPosBuilder.qrCode('X', 20), [0x31, 0x43, 0x10]);
    has(EscPosBuilder.qrCode('X', 0), [0x31, 0x43, 0x01]);
  });
  it('中文内容经 GBK 落数据段：收 → CA D5', () => {
    has(EscPosBuilder.qrCode('收'), [0x31, 0x50, 0x30, 0xca, 0xd5]);
  });
  it('空内容 → 空段（元素级跳过同口径）', () => {
    expect(EscPosBuilder.qrCode('').length).toBe(0);
  });
});

describe('切纸与钱箱', () => {
  it('cut：前留 3 行 + GS V m（半切=1 / 全切=0）', () => {
    eq(EscPosBuilder.cut(true), [0x0a, 0x0a, 0x0a, 0x1d, 0x56, 0x01]);
    eq(EscPosBuilder.cut(false), [0x0a, 0x0a, 0x0a, 0x1d, 0x56, 0x00]);
  });
  it('cutAtPosition：GS V 66 n 变体（C# 形态）', () => {
    eq(EscPosBuilder.cutAtPosition(0), [0x1d, 0x56, 0x42, 0x00]);
  });
  it('drawerKickPulse：pin 0/1 → m=0/1；默认档 (0,25,250)', () => {
    eq(EscPosBuilder.drawerKickPulse(0, 25, 250), [0x1b, 0x70, 0x00, 0x19, 0xfa]);
    eq(EscPosBuilder.drawerKickPulseDefault(), [0x1b, 0x70, 0x00, 0x19, 0xfa]);
    eq(EscPosBuilder.drawerKickPulse(1, 0x19, 0x19), [0x1b, 0x70, 0x01, 0x19, 0x19]);
    expect(() => EscPosBuilder.drawerKickPulse(2 as never, 1, 1)).toThrow(RangeError);
  });
});

describe('命令助记符白名单与帧组装', () => {
  it("mapCommand：'ESC @'/'GS V 0|48'/'GS V 1|49' 直通，规范化大小写与空白，未知 null", () => {
    eq(EscPosBuilder.mapCommand('ESC @')!, [0x1b, 0x40]);
    eq(EscPosBuilder.mapCommand('  gs   v  1 ')!, [0x1d, 0x56, 0x01]);
    eq(EscPosBuilder.mapCommand('GS V 48')!, [0x1d, 0x56, 0x00]);
    expect(EscPosBuilder.mapCommand('FOO BAR')).toBeNull();
  });
  it('buildSelfTestReceipt 帧序：初始化起始 → 标识行+LF → 走纸 3 行 → 走纸到位半切收尾', () => {
    const frame = EscPosBuilder.buildSelfTestReceipt();
    eq(frame.slice(0, 2), [0x1b, 0x40]);
    has(frame, [...asciiBytes('TAPRINT PRINT SELFTEST'), 0x0a]);
    has(frame, [0x1b, 0x64, 0x03]);
    eq(frame.slice(frame.length - 4), [0x1d, 0x56, 0x42, 0x00]);
    // 走纸在标识行之后、切纸之前（帧序）
    expect(indexOfBytes(frame, asciiBytes('TAPRINT'))).toBeLessThan(indexOfBytes(frame, u8(0x1b, 0x64, 0x03)));
    expect(indexOfBytes(frame, u8(0x1b, 0x64, 0x03))).toBeLessThan(frame.length - 4);
  });
  it('手工组帧：init + FS& + 居中行 + 走纸 + 半切（concatBytes 拼接语义）', () => {
    const frame = concatBytes(
      EscPosBuilder.initialize(),
      EscPosBuilder.selectChineseEncoding(),
      EscPosBuilder.textLine('收银小票', { align: 'center' }),
      EscPosBuilder.feedLines(3),
      EscPosBuilder.cut(true),
    );
    eq(frame.slice(0, 4), [0x1b, 0x40, 0x1c, 0x26]);
    eq(frame.slice(frame.length - 6), [0x0a, 0x0a, 0x0a, 0x1d, 0x56, 0x01]);
  });
  it('toHex：大写、空格分隔；null → 空串', () => {
    expect(EscPosBuilder.toHex(u8(0x1b, 0x40, 0x05))).toBe('1B 40 05');
    expect(EscPosBuilder.toHex(null)).toBe('');
  });
});
