// SPDX-License-Identifier: Apache-2.0
// ZPL 构建器测试（Java ZplRenderer v0.2 参照对拍移植）：
// - 帧骨架序（^XA→^LH0,0→^PW→^LL→元素→[^PQ]→^XZ）与份数位
// - ^FD 域转义（反斜杠先行 / ^ ~ 指令前缀）与多行逐行推进
// - 码制全表映射（含未知折 CODE128 的 Symbology.of 口径）
// - QR MA 三段一域、框线厚度夹取、坐标负值夹 0
// - numeric 内核：half-up away-from-zero 中点（6.3125mm→50.5dot→51）
// - GBK 内容通道：表内字符 2 字节原样、表外 U+FFFD 占位（ADR-0009）
import { describe, expect, it } from 'vitest';
import { gbkEncode, GBK_REPLACEMENT_BYTES } from '../src/internal/gbk.ts';
import { ZplBuilder, ZPL_ASCII_FONT_HEIGHT } from '../src/protocols/zpl.ts';
import type { LabelSpec } from '../src/protocols/label.ts';

const latin1 = (bytes: Uint8Array): string => {
  let out = '';
  for (const b of bytes) out += String.fromCharCode(b);
  return out;
};

const label = (body: LabelSpec['body'], extra: Partial<LabelSpec> = {}): LabelSpec => ({
  widthMm: 60,
  heightMm: 40,
  copies: 1,
  body,
  ...extra,
});

const build = (spec: LabelSpec): string =>
  latin1(ZplBuilder.buildLabel(spec, { encode: gbkEncode }));

describe('ZplBuilder 帧骨架', () => {
  it('整帧帧序：^XA→^LH0,0→^PW→^LL→元素→^XZ（份数=1 不发 ^PQ）', () => {
    expect(build(label([{ type: 'text', xMm: 4, yMm: 18, content: 'HELLO', textSize: 1 }])))
      .toBe('^XA^LH0,0^PW480^LL320^FO32,144^A0N,28,28^FDHELLO^FS^XZ');
  });

  it('份数 >1 发 ^PQ 且紧邻 ^XZ；份数字符串模板解析', () => {
    expect(build(label([{ type: 'text', xMm: 0, yMm: 0, content: 'X' }], { copies: 3 })))
      .toContain('^PQ3^XZ');
    expect(build(label([{ type: 'text', xMm: 0, yMm: 0, content: 'X' }], { copies: '{{copies}}' })))
      .not.toContain('^PQ2');
  });

  it('画幅/坐标负值夹 0；空内容元素整帧跳过', () => {
    expect(latin1(ZplBuilder.frameHeader(-5, -1))).toBe('^XA^LH0,0^PW0^LL0');
    expect(latin1(ZplBuilder.fieldOrigin(-3, -4))).toBe('^FO0,0');
    expect(build(label([{ type: 'text', xMm: 0, yMm: 0, content: '' }])))
      .toBe('^XA^LH0,0^PW480^LL320^XZ');
  });
});

describe('ZplBuilder 文本', () => {
  it('^FD 域转义：反斜杠先行，^ ~ → \\^ \\~', () => {
    expect(ZplBuilder.escapeFieldData('a^b~c\\d')).toBe('a\\^b\\~c\\\\d');
    expect(build(label([{ type: 'text', xMm: 0, yMm: 0, content: 'a^b' }])))
      .toContain('^FDa\\^b^FS');
  });

  it('多行文本逐行 ^FD、行距 = 字高（size 2 → 行高 56）', () => {
    expect(build(label([{ type: 'text', xMm: 4, yMm: 4, content: 'A\nB', textSize: 2 }])))
      .toBe('^XA^LH0,0^PW480^LL320'
        + '^FO32,32^A0N,56,56^FDA^FS'
        + '^FO32,88^A0N,56,56^FDB^FS^XZ');
  });

  it('字号倍率：顶层 size 域 1-10（0 折 1、15 顶格 10）；缺省回 style.fontSize 档', () => {
    expect(ZplBuilder.resolveTextMultiplier({ type: 'text', textSize: 0 })).toBe(1);
    expect(ZplBuilder.resolveTextMultiplier({ type: 'text', textSize: 15 })).toBe(10);
    expect(ZplBuilder.resolveTextMultiplier({ type: 'text', style: { fontSize: 'double' } })).toBe(2);
    expect(ZplBuilder.resolveTextMultiplier({ type: 'text' })).toBe(1);
    // 基准字高 28（Java 参照 ASCII_FONT_HEIGHT 同口径）
    expect(ZPL_ASCII_FONT_HEIGHT).toBe(28);
    expect(build(label([{ type: 'text', xMm: 0, yMm: 0, content: 'X', textSize: 15 }])))
      .toContain('^A0N,280,280');
  });

  it('CJK 表内字符 GBK 2 字节原样、表外字符 U+FFFD 占位（ADR-0009 §3）', () => {
    const bytes = ZplBuilder.buildLabel(
      label([{ type: 'text', xMm: 0, yMm: 0, content: '货位😀07' }]),
      { encode: gbkEncode },
    );
    // 期望字节序列：^FD + 货(BB F5) 位(CE BB) + U+FFFD(EF BF BD) + "07" + ^FS
    const expected: number[] = [];
    for (const ch of '^FD') expected.push(ch.charCodeAt(0));
    expected.push(0xbb, 0xf5, 0xce, 0xbb, 0xef, 0xbf, 0xbd, 0x30, 0x37);
    for (const ch of '^FS') expected.push(ch.charCodeAt(0));
    let hit = false;
    outer:
    for (let i = 0; i + expected.length <= bytes.length; i++) {
      for (let j = 0; j < expected.length; j++) {
        if (bytes[i + j] !== expected[j]) continue outer;
      }
      hit = true;
      break;
    }
    expect(hit).toBe(true);
    expect(GBK_REPLACEMENT_BYTES).toEqual([0xef, 0xbf, 0xbd]);
  });
});

describe('ZplBuilder 码制', () => {
  it('CODE128：^BY2,3,<h> + ^BCN,<h>,Y,N,N + ^FD', () => {
    expect(build(label([
      { type: 'barcode', xMm: 4, yMm: 22, heightMm: 10, content: 'SKU-100086', symbology: 'CODE128' },
    ]))).toContain('^FO32,176^BY2,3,80^BCN,80,Y,N,N^FDSKU-100086^FS');
  });

  it('码制全表：EAN13/EAN8 同头异参、UPC、CODE39、ITF；未知折 CODE128', () => {
    expect(ZplBuilder.symbologyCommand('EAN13', 80)).toBe('^BEN,80,Y,N,N');
    expect(ZplBuilder.symbologyCommand('EAN8', 80)).toBe('^BEN,80,Y,N');
    expect(ZplBuilder.symbologyCommand('UPC', 80)).toBe('^BUN,80,Y,N');
    expect(ZplBuilder.symbologyCommand('CODE39', 80)).toBe('^B3N,N,80,Y,N');
    expect(ZplBuilder.symbologyCommand('ITF', 80)).toBe('^B2N,80,N,N');
    // Java 参照 Symbology.of 缺省口径：未知码制折 CODE128（非静默丢帧）
    expect(ZplBuilder.symbologyCommand('PDF417', 80)).toBe('^BCN,80,Y,N,N');
    expect(ZplBuilder.symbologyCommand('code128', 80)).toBe('^BCN,80,Y,N,N');
  });

  it('条码空内容返回空段（不发 ^BY/^FD 帧）', () => {
    expect(ZplBuilder.barcode('CODE128', 80, '')).toHaveLength(0);
  });
});

describe('ZplBuilder QR 与框线', () => {
  it('QR：^BQN,2,<size>^FDMA,<data>^FS；size 域 1-10（0→1、99→10）', () => {
    expect(latin1(ZplBuilder.qr(6, 'TAPRINT'))).toBe('^BQN,2,6^FDMA,TAPRINT^FS');
    expect(latin1(ZplBuilder.qr(0, 'X'))).toContain('^BQN,2,1');
    expect(latin1(ZplBuilder.qr(99, 'X'))).toContain('^BQN,2,10');
    expect(ZplBuilder.qr(6, '')).toHaveLength(0);
  });

  it('线/框：^GB<w>,<h>,<t>（厚度缺省 2、下限 1；线高下夹厚度）', () => {
    expect(latin1(ZplBuilder.box(448, 288))).toBe('^GB448,288,2^FS');
    expect(latin1(ZplBuilder.box(448, 288, { thickness: 0 }))).toBe('^GB448,288,1^FS');
    expect(build(label([
      { type: 'line', xMm: 2, yMm: 34, widthMm: 56, heightMm: 0.5 },
      { type: 'rect', xMm: 2, yMm: 2, widthMm: 56, heightMm: 36 },
    ]))).toContain('^FO16,272^GB448,4,2^FS');
    expect(build(label([{ type: 'rect', xMm: 2, yMm: 2, widthMm: 56, heightMm: 36 }])))
      .toContain('^FO16,16^GB448,288,2^FS');
  });
});

describe('ZplBuilder 数值内核', () => {
  it('mm→dot 走 numeric 内核 half-up away-from-zero（6.3125mm=50.5dot→51）', () => {
    // dotFromMm 由 buildLabel 间接消费：6.3125mm 坐标中点应入 51（非 50）
    expect(build(label([{ type: 'text', xMm: 6.3125, yMm: 6.3125, content: 'MID' }])))
      .toContain('^FO51,51');
  });
});
