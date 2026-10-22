// SPDX-License-Identifier: Apache-2.0
// ZPL 标签命令构建器（命令级纯函数 + 整帧组装）。
//
// 参照：Java ZplRenderer（v0.2 内置字库路由，ADR-0001——CJK 位图路由 ^GFA
// 留给 v0.2.x 增量，本面不发）：
// - 帧骨架 `^XA^LH0,0^PW<w>^LL<h> → 元素 → [^PQ<n>] → ^XZ`（^PQ 仅份数 >1 时发）；
// - 文本逐行 `^FOx,y^A0N,h,h^FD<escaped>^FS`，h = 28 × 倍率（域 1-10），
//   行距 = 字高；CJK 内容同走内置字库路由（v0.2 口径）；
// - 一维码 `^FOx,y^BY2,3,<h>` + 码制指令 + `^FD^FS`：CODE128→^BCN,h,Y,N,N、
//   EAN13→^BEN,h,Y,N,N、EAN8→^BEN,h,Y,N、UPC→^BUN,h,Y,N、CODE39→^B3N,N,h,Y,N、
//   ITF→^B2N,h,N,N；未知码制折 CODE128（Java 参照 Symbology.of 口径，
//   与 CPCL 构建器的「拒绝不印」纪律不同——差异登记 conformance.md）；
// - QR `^FOx,y^BQN,2,<size>^FDMA,<data>^FS`（型号 2 + MA 前缀 = 纠错 M +
//   掩码自动；size 域 1-10 缺省 6）；
// - 线/框 `^FOx,y^GB<w>,<h>,2^FS`（线 = 细框，线高下夹厚度 2）；
// - ^FD 域转义：反斜杠先行，^ ~ → \^ \~（ZPL II 指令前缀子集）。
// 内容通道：GBK 表 + U+FFFD 占位（ADR-0009 §3，与 TSPL/CPCL 同纪律）——
// Java 参照原 ^CI28（UTF-8 通道）被内核口径替换，登记 conformance.md。
// dot 折算：LABEL_DOTS_PER_MM = 8（label.ts 同口径；Java 参照 203/25.4 ≈
// 7.9921，非整点坐标的中点帧差见 conformance.md Z 段）。
import { gbkEncode } from '../internal/gbk.ts';
import { asciiBytes, concatBytes } from './bytes.ts';
import { clampInt, dotFromMm, requireInt } from './numeric.ts';
import {
  LABEL_DEFAULTS,
  LABEL_DOTS_PER_MM,
  elementExtentDots,
  elementOriginDots,
  resolveCopies,
  styleFontSizeName,
  topSizeMultiplier,
  type LabelBuildOptions,
  type LabelElement,
  type LabelSpec,
} from './label.ts';

/** ^A0 内置字库基准字高（dot）——Java 参照 ASCII_FONT_HEIGHT 同口径。 */
export const ZPL_ASCII_FONT_HEIGHT = 28;

/** 线/框厚度缺省（dot）——Java 参照 BOX_THICKNESS 同档。 */
export const ZPL_BOX_THICKNESS = 2;

/** QR 单元域（1-10，缺省 6——Java 参照 size 缺省同口径）。 */
export const ZPL_QR_SIZE_DEFAULT = 6;

export interface ZplTextOptions {
  /** 字高 dot（命令级直传；组装层按 28×倍率算出）。 */
  readonly fontHeight?: number;
  readonly encode?: (text: string) => Uint8Array;
}

export interface ZplBarcodeOptions {
  /** 窄条宽 dot（缺省 2）。 */
  readonly narrow?: number;
  /** 宽窄比（缺省 3）。 */
  readonly ratio?: number;
  readonly encode?: (text: string) => Uint8Array;
}

export interface ZplBoxOptions {
  /** 厚度 dot（缺省 2，下限 1）。 */
  readonly thickness?: number;
}

/**
 * ZPL 标签命令构建器：命令级方法返回单命令字节段；buildLabel 按 Java
 * 参照帧序（帧头 → 元素 → 份数 → ^XZ）组装整帧。
 */
export class ZplBuilder {
  private constructor() {}

  /**
   * 帧头 `^XA^LH0,0^PW<w>^LL<h>`：建立原点左上的点阵坐标系并声明画幅
   * （宽度/高度 dot；非负夹 0——负画幅无设备语义）。
   */
  static frameHeader(widthDots: number, heightDots: number): Uint8Array {
    return asciiBytes(
      `^XA^LH0,0^PW${Math.max(0, requireInt(widthDots, 'widthDots'))}` +
      `^LL${Math.max(0, requireInt(heightDots, 'heightDots'))}`,
    );
  }

  /** 字段原点 `^FOx,y`（非负夹 0）。 */
  static fieldOrigin(xDots: number, yDots: number): Uint8Array {
    return asciiBytes(
      `^FO${Math.max(0, requireInt(xDots, 'xDots'))},${Math.max(0, requireInt(yDots, 'yDots'))}`,
    );
  }

  /**
   * 单行文本 `^A0N,h,h^FD<escaped>^FS`（须先接 fieldOrigin；内容为空返回
   * 空段——空域不发帧）。fontHeight 缺省基准字高。
   */
  static textLine(content: string, options: ZplTextOptions = {}): Uint8Array {
    if (content === '') return new Uint8Array(0);
    const encode = options.encode ?? gbkEncode;
    const h = Math.max(1, options.fontHeight ?? ZPL_ASCII_FONT_HEIGHT);
    return concatBytes(
      asciiBytes(`^A0N,${h},${h}^FD`),
      encode(ZplBuilder.escapeFieldData(content)),
      asciiBytes('^FS'),
    );
  }

  /** ^FD 域转义：反斜杠先行 → \\\\，指令前缀 ^ ~ → \^ \~。 */
  static escapeFieldData(text: string): string {
    return text.replace(/\\/g, '\\\\').replace(/\^/g, '\\^').replace(/~/g, '\\~');
  }

  /**
   * 一维码 `^BY<narrow>,<ratio>,<h>` + 码制指令 + `^FD<escaped>^FS`（须先接
   * fieldOrigin；内容为空返回空段）。码制全表映射见 mapSymbology。
   */
  static barcode(
    symbology: string,
    heightDots: number,
    content: string,
    options: ZplBarcodeOptions = {},
  ): Uint8Array {
    if (content === '') return new Uint8Array(0);
    const encode = options.encode ?? gbkEncode;
    const narrow = Math.max(1, requireInt(options.narrow ?? 2, 'narrow'));
    const ratio = Math.max(1, requireInt(options.ratio ?? 3, 'ratio'));
    const h = Math.max(1, requireInt(heightDots, 'heightDots'));
    return concatBytes(
      asciiBytes(`^BY${narrow},${ratio},${h}`),
      asciiBytes(ZplBuilder.symbologyCommand(symbology, h)),
      asciiBytes('^FD'),
      encode(ZplBuilder.escapeFieldData(content)),
      asciiBytes('^FS'),
    );
  }

  /**
   * 码制指令（Java 参照全表）：按码制返回 `^XX<args>` 形态。
   * CODE128/^BCN,h,Y,N,N；EAN13/^BEN,h,Y,N,N；EAN8/^BEN,h,Y,N；
   * UPC/^BUN,h,Y,N；CODE39/^B3N,N,h,Y,N；ITF/^B2N,h,N,N；未知折 CODE128
   * （Symbology.of 缺省口径）。
   */
  static symbologyCommand(symbology: string, heightDots: number): string {
    const h = Math.max(1, heightDots);
    switch ((symbology ?? '').trim().toUpperCase()) {
      case 'EAN13':
        return `^BEN,${h},Y,N,N`;
      case 'EAN8':
        return `^BEN,${h},Y,N`;
      case 'UPC':
      case 'UPCA':
        return `^BUN,${h},Y,N`;
      case 'CODE39':
        return `^B3N,N,${h},Y,N`;
      case 'ITF':
      case 'I2OF5':
        return `^B2N,${h},N,N`;
      default:
        // 含 CODE128 与未知码制：Symbology.of 缺省折 CODE128
        return `^BCN,${h},Y,N,N`;
    }
  }

  /**
   * QR `^BQN,2,<size>^FDMA,<data>^FS`（须先接 fieldOrigin；内容为空返回
   * 空段）。size 域 1-10 缺省 6；MA 前缀 = 纠错 M + 掩码自动。
   */
  static qr(size: number, content: string, options: { encode?: (text: string) => Uint8Array } = {}): Uint8Array {
    if (content === '') return new Uint8Array(0);
    const encode = options.encode ?? gbkEncode;
    const n = clampInt(requireInt(size, 'size'), 1, 10);
    return concatBytes(
      asciiBytes(`^BQN,2,${n}^FDMA,`),
      encode(ZplBuilder.escapeFieldData(content)),
      asciiBytes('^FS'),
    );
  }

  /** 线/框 `^GB<w>,<h>,<t>`（须先接 fieldOrigin；厚度下限 1）。 */
  static box(widthDots: number, heightDots: number, options: ZplBoxOptions = {}): Uint8Array {
    const t = Math.max(1, requireInt(options.thickness ?? ZPL_BOX_THICKNESS, 'thickness'));
    return asciiBytes(
      `^GB${Math.max(1, requireInt(widthDots, 'widthDots'))},` +
      `${Math.max(1, requireInt(heightDots, 'heightDots'))},${t}^FS`,
    );
  }

  /** 份数 `^PQ<n>`（copies >1 才有 ZPL 帧语义；命令级恒发，组装层把关）。 */
  static printQty(copies: number): Uint8Array {
    return asciiBytes(`^PQ${Math.max(1, requireInt(copies, 'copies'))}`);
  }

  /** 收尾 `^XZ`。 */
  static frameEnd(): Uint8Array {
    return asciiBytes('^XZ');
  }

  /**
   * 文本倍率（Java 参照口径：顶层 size 为准，域 1-10、0 折 1；缺省回
   * style.fontSize 兼容档——tall/normal/wide → 1、double → 2、triple → 3、
   * quadruple → 4。Java 参照不读 style，grades 用例为潜在分叉面，
   * 登记 conformance.md）。
   */
  static resolveTextMultiplier(el: LabelElement): number {
    const top = topSizeMultiplier(el);
    if (top != null) return top;
    switch (styleFontSizeName(el)) {
      case 'double':
        return 2;
      case 'triple':
        return 3;
      case 'quadruple':
        return 4;
      default:
        return 1;
    }
  }

  /**
   * 整帧组装（Java 参照帧序）：帧头（画幅 = mm×8 dot）→ 元素
   * （text 多行逐行、barcode、qrcode、line/rect → ^GB 细框；未知类型跳过
   * ——绝对坐标布局无占位语义）→ [^PQ 份数 >1] → ^XZ。
   */
  static buildLabel(spec: LabelSpec, options: LabelBuildOptions = {}): Uint8Array {
    const resolve = options.resolve ?? ((t: string) => t);
    const encode = options.encode ?? ((t: string) => gbkEncode(t, options));
    const dotsPerMm = LABEL_DOTS_PER_MM;
    const widthDots = dotFromMm(spec.widthMm ?? LABEL_DEFAULTS.widthMm, dotsPerMm);
    const heightDots = dotFromMm(spec.heightMm ?? LABEL_DEFAULTS.heightMm, dotsPerMm);
    const parts: Uint8Array[] = [ZplBuilder.frameHeader(widthDots, heightDots)];
    for (const el of spec.body ?? []) {
      const { x, y } = elementOriginDots(el);
      switch (el.type) {
        case 'text': {
          const content = resolve(el.content ?? '');
          if (content === '') break;
          const mul = ZplBuilder.resolveTextMultiplier(el);
          const h = ZPL_ASCII_FONT_HEIGHT * mul;
          const lines = content.split('\n');
          for (let lineNo = 0; lineNo < lines.length; lineNo++) {
            parts.push(ZplBuilder.fieldOrigin(x, y + lineNo * h));
            parts.push(ZplBuilder.textLine(lines[lineNo], { fontHeight: h, encode }));
          }
          break;
        }
        case 'barcode': {
          const content = resolve(el.content ?? '');
          if (content === '') break;
          const { h } = elementExtentDots(el);
          parts.push(ZplBuilder.fieldOrigin(x, y));
          parts.push(ZplBuilder.barcode(el.symbology ?? 'CODE128', h, content, { encode }));
          break;
        }
        case 'qrcode': {
          const content = resolve(el.content ?? '');
          if (content === '') break;
          const size = el.cellSize ?? ZPL_QR_SIZE_DEFAULT;
          parts.push(ZplBuilder.fieldOrigin(x, y));
          parts.push(ZplBuilder.qr(size, content, { encode }));
          break;
        }
        case 'line': {
          const { w } = elementExtentDots(el);
          // 线高 = height 折算下夹厚度（零高度框无 ZPL 语义）
          const stroke = Math.max(ZPL_BOX_THICKNESS, dotFromMm(el.heightMm ?? 0, dotsPerMm));
          parts.push(ZplBuilder.fieldOrigin(x, y));
          parts.push(ZplBuilder.box(w, stroke));
          break;
        }
        case 'rect': {
          const { w, h } = elementExtentDots(el);
          parts.push(ZplBuilder.fieldOrigin(x, y));
          parts.push(ZplBuilder.box(w, h));
          break;
        }
        default:
          break; // 未知元素跳过
      }
    }
    const copies = resolveCopies(spec.copies, resolve);
    if (copies > 1) {
      parts.push(ZplBuilder.printQty(copies));
    }
    parts.push(ZplBuilder.frameEnd());
    return concatBytes(...parts);
  }
}
