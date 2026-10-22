// SPDX-License-Identifier: Apache-2.0
// TSPL 构建器单测：整帧序 golden、TEXT/BARCODE/QRCODE 指令骨架、码制白名单、
// 字号倍率解析、份数解析与参数域夹取。
import { describe, expect, it } from 'vitest';
import { asciiBytes, concatBytes, indexOfBytes, TsplBuilder } from '../src/index';
import type { LabelElement, LabelSpec } from '../src/index';

const u8 = (...n: number[]) => Uint8Array.from(n);
const eq = (actual: Uint8Array, expected: number[]) => expect([...actual]).toEqual(expected);
const pattern = (p: number[] | Uint8Array): Uint8Array => (p instanceof Uint8Array ? p : u8(...p));
const has = (stream: Uint8Array, p: number[] | Uint8Array) =>
  expect(indexOfBytes(stream, pattern(p))).toBeGreaterThanOrEqual(0);
const hasText = (stream: Uint8Array, text: string) =>
  expect(indexOfBytes(stream, asciiBytes(text))).toBeGreaterThanOrEqual(0);
const notHasText = (stream: Uint8Array, text: string) =>
  expect(indexOfBytes(stream, asciiBytes(text))).toBe(-1);

const el = (partial: Partial<LabelElement>): LabelElement => ({ type: 'text', content: 'X', ...partial });
const label = (body: LabelElement[], spec: Partial<LabelSpec> = {}): LabelSpec => ({ body, ...spec });

describe('整帧序 golden（SIZE→GAP→DENSITY→SPEED→DIRECTION→CLS→body→PRINT）', () => {
  it('空 body + 缺省纸面：整帧逐字节锁定（CR LF 行尾）', () => {
    const frame = TsplBuilder.buildLabel(label([]));
    eq(
      frame,
      [...asciiBytes('SIZE 40 mm,30 mm\r\nGAP 2 mm,0 mm\r\nDENSITY 8\r\nSPEED 4\r\nDIRECTION 1\r\nCLS\r\nPRINT 1\r\n')],
    );
  });
  it('非整毫米纸面走定点格式化：40.5×30.25mm、间隙 2.5mm', () => {
    const frame = TsplBuilder.buildLabel(label([], { widthMm: 40.5, heightMm: 30.25, gapMm: 2.5 }));
    hasText(frame, 'SIZE 40.5 mm,30.25 mm\r\nGAP 2.5 mm,0 mm\r\n');
  });
  it('未知元素类型跳过：帧与空 body 逐字节一致', () => {
    const withImage = TsplBuilder.buildLabel(label([el({ type: 'image' })]));
    const empty = TsplBuilder.buildLabel(label([]));
    eq(withImage, [...empty]);
  });
});

describe('TEXT 指令', () => {
  it('golden：mm→dot（8 dot/mm）+ 7 参顺序 rotation 在倍率前', () => {
    const frame = TsplBuilder.buildLabel(label([el({ xMm: 10, yMm: 10, content: 'HELLO' })]));
    hasText(frame, 'TEXT 80,80,"SIMPLIFIED CHINESE",0,1,1,"HELLO"\r\n');
  });
  it('中文内容 GBK 双字节：收银 → CA D5 D2 F8（连续子序列）', () => {
    const frame = TsplBuilder.buildLabel(label([el({ xMm: 4, yMm: 4, content: '收银' })]));
    has(
      frame,
      concatBytes(asciiBytes('TEXT 32,32,"SIMPLIFIED CHINESE",0,1,1,"'), u8(0xca, 0xd5, 0xd2, 0xf8), asciiBytes('"\r\n')),
    );
  });
  it('顶层 size 为准：textSize=2 → 2,2；0 折 1；越界夹 10', () => {
    hasText(TsplBuilder.buildLabel(label([el({ textSize: 2 })])), ',0,2,2,"X"\r\n');
    hasText(TsplBuilder.buildLabel(label([el({ textSize: 0 })])), ',0,1,1,"X"\r\n');
    hasText(TsplBuilder.buildLabel(label([el({ textSize: 99 })])), ',0,10,10,"X"\r\n');
  });
  it('style.fontSize 兼容档：tall→1,2 / wide→2,1 / double→2,2', () => {
    hasText(TsplBuilder.buildLabel(label([el({ style: { fontSize: 'tall' } })])), ',0,1,2,"X"\r\n');
    hasText(TsplBuilder.buildLabel(label([el({ style: { fontSize: 'wide' } })])), ',0,2,1,"X"\r\n');
    hasText(TsplBuilder.buildLabel(label([el({ style: { fontSize: 'double' } })])), ',0,2,2,"X"\r\n');
  });
  it('内容清洗：引号/CR/LF 剔除（引号串无转义文法）', () => {
    has(TsplBuilder.text(0, 0, 'A"B\rC\nD'), asciiBytes('"ABCD"'));
  });
  it('负坐标夹 0', () => {
    hasText(TsplBuilder.text(-5, -5, 'X'), 'TEXT 0,0,');
  });
});

describe('BARCODE 指令', () => {
  it('CODE128 golden：height mm→dot + human/rotation/narrow/wide 缺省', () => {
    const frame = TsplBuilder.buildLabel(
      label([{ type: 'barcode', xMm: 10, yMm: 50, heightMm: 12.5, content: '12345' }]),
    );
    hasText(frame, 'BARCODE 80,400,"CODE128",100,2,0,2,2,"12345"\r\n');
  });
  it('人读位：humanReadable=true → 1', () => {
    hasText(TsplBuilder.barcode(0, 0, 'CODE128', 100, '12345', { humanReadable: true }), ',100,1,0,2,2,');
  });
  it('码制白名单：EAN13 直通、大小写不敏感；白名单外拒绝不印 + onWarn', () => {
    expect(TsplBuilder.mapSymbology('code128')).toBe('CODE128');
    expect(TsplBuilder.mapSymbology('EAN13')).toBe('EAN13');
    expect(TsplBuilder.mapSymbology('CODE39')).toBeNull();
    const warns: string[] = [];
    const frame = TsplBuilder.buildLabel(
      label([{ type: 'barcode', content: '12345', symbology: 'CODE39' }]),
      { onWarn: (m) => warns.push(m) },
    );
    expect(warns.length).toBe(1);
    notHasText(frame, 'BARCODE ');
    hasText(
      TsplBuilder.buildLabel(label([{ type: 'barcode', content: '6901234567892', symbology: 'EAN13' }])),
      '"EAN13"',
    );
  });
  it('码制字符域清洗：非可见 ASCII 降 ?', () => {
    has(TsplBuilder.barcode(0, 0, 'CODE128', 100, 'ABé'), asciiBytes('"AB?"'));
  });
});

describe('QRCODE 指令', () => {
  it('golden：QRCODE x,y,M,cell,A,0,M,7,"content"（带 model/mask 完整形态）', () => {
    const frame = TsplBuilder.buildLabel(label([{ type: 'qrcode', xMm: 4, yMm: 4, content: 'XY' }]));
    hasText(frame, 'QRCODE 32,32,M,4,A,0,M,7,"XY"\r\n');
  });
  it('cell 夹 1-10：33→10；空内容跳过', () => {
    hasText(TsplBuilder.qrCode(0, 0, 'X', { cell: 33 }), 'QRCODE 0,0,M,10,');
    expect(TsplBuilder.qrCode(0, 0, '').length).toBe(0);
    notHasText(TsplBuilder.buildLabel(label([{ type: 'qrcode', content: '' }])), 'QRCODE ');
  });
});

describe('line/其他命令', () => {
  it('line → BAR 实心矩形：宽度 dot、厚度夹 ≥1（0.05mm→0.4dot→1）', () => {
    const frame = TsplBuilder.buildLabel(label([{ type: 'line', xMm: 0, yMm: 8, widthMm: 10, heightMm: 0.05 }]));
    hasText(frame, 'BAR 0,64,80,1\r\n');
  });
  it('BLINE/SET TEAR/BOX/FORMFEED/方向与速度浓度夹取', () => {
    hasText(TsplBuilder.bLine(2), 'BLINE 2 mm,0 mm\r\n');
    hasText(TsplBuilder.setTear(true), 'SET TEAR ON\r\n');
    hasText(TsplBuilder.box(0, 0, 80, 60, 2), 'BOX 0,0,80,60,2\r\n');
    hasText(TsplBuilder.formFeed(), 'FORMFEED\r\n');
    hasText(TsplBuilder.direction(9), 'DIRECTION 3\r\n');
    hasText(TsplBuilder.speed(99), 'SPEED 10\r\n');
    hasText(TsplBuilder.density(-1), 'DENSITY 0\r\n');
  });
  it('printCopies 下限夹 1', () => {
    hasText(TsplBuilder.printCopies(0), 'PRINT 1\r\n');
  });
});

describe('份数解析与模板注入', () => {
  it('copies：数值直用；模板经 resolve；非法归 1；0 夹 1', () => {
    hasText(TsplBuilder.buildLabel(label([], { copies: 3 })), 'PRINT 3\r\n');
    hasText(TsplBuilder.buildLabel(label([], { copies: ' 2 ' })), 'PRINT 2\r\n');
    hasText(TsplBuilder.buildLabel(label([], { copies: 'abc' })), 'PRINT 1\r\n');
    hasText(TsplBuilder.buildLabel(label([], { copies: 0 })), 'PRINT 1\r\n');
    const frame = TsplBuilder.buildLabel(label([], { copies: '{{copies}}' }), {
      resolve: (t) => (t === '{{copies}}' ? '5' : t),
    });
    hasText(frame, 'PRINT 5\r\n');
  });
  it('内容模板经 resolve 注入：{{name}} → 实值', () => {
    const frame = TsplBuilder.buildLabel(label([el({ content: '{{name}}' })]), {
      resolve: (t) => (t === '{{name}}' ? '收银员' : t),
    });
    has(
      frame,
      concatBytes(asciiBytes('"'), u8(0xca, 0xd5, 0xd2, 0xf8, 0xd4, 0xb1), asciiBytes('"\r\n')),
    );
  });
  it('encode 注入：自定义字节编码器替换缺省 GBK', () => {
    const frame = TsplBuilder.buildLabel(label([el({ content: 'A' })]), {
      encode: () => u8(0xff),
    });
    has(frame, concatBytes(asciiBytes(',"'), u8(0xff), asciiBytes('"\r\n')));
  });
});
