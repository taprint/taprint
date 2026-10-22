// SPDX-License-Identifier: Apache-2.0
// CPCL 构建器单测：格式头/尾部 golden、TEXT 不带引号、QR 三段式、
// 码制白名单（128/EAN13 助记符）、档位解析与份数解析。
import { describe, expect, it } from 'vitest';
import { asciiBytes, concatBytes, indexOfBytes, CpclBuilder } from '../src/index';
import type { LabelElement, LabelSpec } from '../src/index';

const u8 = (...n: number[]) => Uint8Array.from(n);
const pattern = (p: number[] | Uint8Array): Uint8Array => (p instanceof Uint8Array ? p : u8(...p));
const has = (stream: Uint8Array, p: number[] | Uint8Array) =>
  expect(indexOfBytes(stream, pattern(p))).toBeGreaterThanOrEqual(0);
const hasText = (stream: Uint8Array, text: string) =>
  expect(indexOfBytes(stream, asciiBytes(text))).toBeGreaterThanOrEqual(0);
const notHasText = (stream: Uint8Array, text: string) =>
  expect(indexOfBytes(stream, asciiBytes(text))).toBe(-1);

const el = (partial: Partial<LabelElement>): LabelElement => ({ type: 'text', content: 'X', ...partial });
const label = (body: LabelElement[], spec: Partial<LabelSpec> = {}): LabelSpec => ({ body, ...spec });

describe('格式头与尾部', () => {
  it('golden：头部 ! 0 200 200 height qty（height mm→dot 8 dot/mm）起始于 0', () => {
    const frame = CpclBuilder.buildLabel(label([], { heightMm: 30 }));
    expect(indexOfBytes(frame, asciiBytes('! 0 200 200 240 1\n'))).toBe(0);
  });
  it('尾部 FORM + PRINT 收帧', () => {
    const frame = CpclBuilder.buildLabel(label([]));
    const tail = asciiBytes('FORM\nPRINT\n');
    expect(indexOfBytes(frame, tail)).toBe(frame.length - tail.length);
  });
  it('qty：数值直用；模板经 resolve；非法归 1（组装层夹 ≥1）', () => {
    hasText(CpclBuilder.buildLabel(label([], { copies: 3 })), '! 0 200 200 240 3\n');
    hasText(CpclBuilder.buildLabel(label([], { copies: ' 2 ' })), '! 0 200 200 240 2\n');
    hasText(CpclBuilder.buildLabel(label([], { copies: 'x' })), '! 0 200 200 240 1\n');
    hasText(CpclBuilder.buildLabel(label([], { copies: 0 })), '! 0 200 200 240 1\n');
    const frame = CpclBuilder.buildLabel(label([], { copies: '{{n}}' }), {
      resolve: (t) => (t === '{{n}}' ? '4' : t),
    });
    hasText(frame, '! 0 200 200 240 4\n');
  });
  it('header 命令级透明：qty=0 原样透传（夹取只在组装层）；DPI/offset 可注入', () => {
    hasText(CpclBuilder.header(240, 0), '! 0 200 200 240 0\n');
    hasText(CpclBuilder.header(240, 1, { offset: 16, horizontal: 300, vertical: 300 }), '! 16 300 300 240 1\n');
  });
});

describe('TEXT 指令（内容不带引号，行尾结束）', () => {
  it('golden：TEXT 4 0 80 80 HELLO', () => {
    const frame = CpclBuilder.buildLabel(label([el({ xMm: 10, yMm: 10, content: 'HELLO' })]));
    hasText(frame, 'TEXT 4 0 80 80 HELLO\n');
  });
  it('中文内容 GBK 双字节、不带引号', () => {
    const frame = CpclBuilder.buildLabel(label([el({ xMm: 4, yMm: 4, content: '收银' })]));
    has(frame, concatBytes(asciiBytes('TEXT 4 0 32 32 '), u8(0xca, 0xd5, 0xd2, 0xf8), asciiBytes('\n')));
  });
  it('档位解析：顶层 size 2→2、0→0、7→顶格 4；style double→2、tall→0', () => {
    hasText(CpclBuilder.buildLabel(label([el({ textSize: 2 })])), 'TEXT 4 2 0 0 X\n');
    hasText(CpclBuilder.buildLabel(label([el({ textSize: 0 })])), 'TEXT 4 0 0 0 X\n');
    hasText(CpclBuilder.buildLabel(label([el({ textSize: 7 })])), 'TEXT 4 4 0 0 X\n');
    hasText(CpclBuilder.buildLabel(label([el({ style: { fontSize: 'double' } })])), 'TEXT 4 2 0 0 X\n');
    hasText(CpclBuilder.buildLabel(label([el({ style: { fontSize: 'tall' } })])), 'TEXT 4 0 0 0 X\n');
  });
  it('空内容跳过', () => {
    notHasText(CpclBuilder.buildLabel(label([el({ content: '' })])), 'TEXT ');
    expect(CpclBuilder.text(0, 0, 0, '').length).toBe(0);
  });
});

describe('BARCODE 指令', () => {
  it('CODE128 golden：BARCODE 128 2 1 height x y content（助记符 128）', () => {
    const frame = CpclBuilder.buildLabel(
      label([{ type: 'barcode', xMm: 10, yMm: 50, heightMm: 12.5, content: '12345' }]),
    );
    hasText(frame, 'BARCODE 128 2 1 100 80 400 12345\n');
  });
  it('EAN13 助记符直通；白名单外拒绝不印 + onWarn', () => {
    hasText(
      CpclBuilder.buildLabel(label([{ type: 'barcode', content: '6901234567892', symbology: 'EAN13' }])),
      'BARCODE EAN13 2 1 ',
    );
    const warns: string[] = [];
    const frame = CpclBuilder.buildLabel(
      label([{ type: 'barcode', content: '12345', symbology: 'CODE39' }]),
      { onWarn: (m) => warns.push(m) },
    );
    expect(warns.length).toBe(1);
    notHasText(frame, 'BARCODE ');
    expect(CpclBuilder.mapSymbology('code128')).toBe('128');
    expect(CpclBuilder.mapSymbology('CODE39')).toBeNull();
  });
  it('人读号开关：开时补 BARCODE-TEXT 行（缺省关=不发）', () => {
    const off = CpclBuilder.barcode('CODE128', 100, 80, 400, '12345');
    notHasText(off, 'BARCODE-TEXT');
    const on = CpclBuilder.barcode('CODE128', 100, 80, 400, '12345', { humanReadable: true });
    hasText(on, 'BARCODE-TEXT 4 0 80 400 12345\n');
  });
});

describe('QR 三段式', () => {
  it('golden：BARCODE QR x y M 2 U n → M0A,data → ENDQR', () => {
    const frame = CpclBuilder.buildLabel(label([{ type: 'qrcode', xMm: 4, yMm: 4, content: 'XY' }]));
    hasText(frame, 'BARCODE QR 32 32 M 2 U 4\nM0A,XY\nENDQR\n');
  });
  it('单元域：缺省 1-32（40→32）；narrow 开关收窄 1-10（40→10）', () => {
    hasText(CpclBuilder.qr(0, 0, 40, 'X'), 'U 32\n');
    hasText(CpclBuilder.qr(0, 0, 40, 'X', { narrow: true }), 'U 10\n');
  });
  it('中文数据段 GBK 双字节', () => {
    has(CpclBuilder.qr(0, 0, 4, '收'), concatBytes(asciiBytes('M0A,'), u8(0xca, 0xd5), asciiBytes('\n')));
  });
});

describe('LINE 与整帧', () => {
  it('line golden：LINE x y x+w y thickness（thickness=高度 dot 夹 ≥1）', () => {
    const frame = CpclBuilder.buildLabel(label([{ type: 'line', xMm: 2, yMm: 4, widthMm: 10, heightMm: 1 }]));
    hasText(frame, 'LINE 16 32 96 32 8\n');
  });
  it('未知元素跳过；空 body 帧与仅未知元素帧一致', () => {
    const empty = CpclBuilder.buildLabel(label([]));
    const withUnknown = CpclBuilder.buildLabel(label([el({ type: 'image' })]));
    expect([...withUnknown]).toEqual([...empty]);
  });
  it('整帧帧序：格式头 → TEXT → BARCODE → QR → FORM → PRINT', () => {
    const frame = CpclBuilder.buildLabel(
      label([
        el({ xMm: 0, yMm: 0, content: 'A' }),
        { type: 'barcode', xMm: 0, yMm: 10, heightMm: 10, content: '12345' },
        { type: 'qrcode', xMm: 0, yMm: 20, content: 'XY' },
      ]),
    );
    const positions = [
      indexOfBytes(frame, asciiBytes('! 0 200 200')),
      indexOfBytes(frame, asciiBytes('TEXT 4 0 0 0 A\n')),
      indexOfBytes(frame, asciiBytes('BARCODE 128 2 1 80 0 80 12345\n')),
      indexOfBytes(frame, asciiBytes('BARCODE QR 0 160 M 2 U 4\n')),
      indexOfBytes(frame, asciiBytes('FORM\nPRINT\n')),
    ];
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });
});
