// SPDX-License-Identifier: Apache-2.0
// CPCL 标签命令构建器（命令级纯函数 + 整帧组装）。
//
// 参照：Dart CPCL 编码器（本协议无 C# 参照——单参照移植，语义全量承接）：
// - 格式头 `! offset horz vert height qty`（缺省 0/200/200——200 DPI 即
//   8 dot/mm，与 TSPL 同换算）；
// - TEXT 内容不带引号（行尾结束）：`TEXT font size x y content`；
// - 一维码 `BARCODE type width ratio height x y content`（宽 2/比率 1 缺省）；
// - QR 三段式：`BARCODE QR x y M 2 U n` / 数据行 `M0A,data`（ECC M + 掩码 0
//   + 模式 A 自动——三字符形态）/ `ENDQR`；
// - 尾部 `FORM` + `PRINT`；份数 qty 在格式头末参。
// 业务 logger 在 Dart 源中用于白外媒制告警，此处改为可选 onWarn 注入（缺省丢弃）。
import { gbkEncode } from '../internal/gbk.ts';
import { asciiBytes, concatBytes } from './bytes.ts';
import { clampInt, dotFromMm, requireInt } from './numeric.ts';
import {
  LABEL_DEFAULTS,
  LABEL_DOTS_PER_MM,
  QRCODE_CELL_DEFAULT,
  elementExtentDots,
  elementOriginDots,
  resolveCopies,
  styleFontSizeName,
  topSizeMultiplier,
  type LabelBuildOptions,
  type LabelElement,
  type LabelSpec,
} from './label.ts';

export interface CpclHeaderOptions {
  /** 左边距 dot（缺省 0）。 */
  readonly offset?: number;
  /** 水平 DPI（缺省 200）。 */
  readonly horizontal?: number;
  /** 垂直 DPI（缺省 200）。 */
  readonly vertical?: number;
}

export interface CpclTextOptions {
  /** 字体号（缺省 4=位图字体，仅纵向放大）。 */
  readonly font?: number;
  readonly encode?: (text: string) => Uint8Array;
}

export interface CpclBarcodeOptions {
  /** 条宽 dot（缺省 2，下限 1）。 */
  readonly width?: number;
  /** 宽窄比（缺省 1，下限 1）。 */
  readonly ratio?: number;
  /** 人读号（缺省关=不发 BARCODE-TEXT 行；开时补 `BARCODE-TEXT 4 0 x y content`）。 */
  readonly humanReadable?: boolean;
  readonly encode?: (text: string) => Uint8Array;
  /** 码制白名单外告警出口（缺省丢弃）。 */
  readonly onWarn?: (message: string) => void;
}

export interface CpclQrOptions {
  /**
   * 单元域收窄开关（false=1-32 既有域；true=1-10 与 TSPL 同域）。
   * 缺省 false——与 Dart 源 E2 开关保持关的口径一致。
   */
  readonly narrow?: boolean;
  readonly encode?: (text: string) => Uint8Array;
}

/**
 * CPCL 标签命令构建器：命令级方法返回单命令字节段；buildLabel 按
 * Dart 帧序（格式头 → 元素 → FORM → PRINT）组装整帧。
 */
export class CpclBuilder {
  private constructor() {}

  /** 位图字体号缺省（仅纵向放大，档 0-4）。 */
  static readonly DEFAULT_FONT = 4;
  /** 格式头缺省 DPI（200 DPI = 8 dot/mm，与 TSPL 同换算）。 */
  static readonly DEFAULT_DPI = 200;

  /**
   * 格式头 `! offset horz vert height qty`：height 为标签高 dot、qty 为份数
   * （命令级不做份数下限夹取——组装层 resolveCopies 已夹 ≥1）。
   */
  static header(heightDots: number, qty: number, options: CpclHeaderOptions = {}): Uint8Array {
    requireInt(heightDots, 'heightDots');
    requireInt(qty, 'qty');
    const offset = requireInt(options.offset ?? 0, 'offset');
    const horizontal = requireInt(options.horizontal ?? CpclBuilder.DEFAULT_DPI, 'horizontal');
    const vertical = requireInt(options.vertical ?? CpclBuilder.DEFAULT_DPI, 'vertical');
    return asciiBytes(`! ${offset} ${horizontal} ${vertical} ${heightDots} ${qty}\n`);
  }

  /**
   * 文本 `TEXT font size x y content`（内容不带引号，行尾结束；内容为空
   * 返回空段——Dart 元素级跳过同口径）。size 档 0-4。
   */
  static text(sizeGrade: number, xDots: number, yDots: number, content: string, options: CpclTextOptions = {}): Uint8Array {
    if (content === '') return new Uint8Array(0);
    const encode = options.encode ?? gbkEncode;
    const font = requireInt(options.font ?? CpclBuilder.DEFAULT_FONT, 'font');
    const size = clampInt(requireInt(sizeGrade, 'sizeGrade'), 0, 4);
    return concatBytes(
      asciiBytes(`TEXT ${font} ${size} ${Math.max(0, requireInt(xDots, 'xDots'))} ${Math.max(0, requireInt(yDots, 'yDots'))} `),
      encode(content),
      asciiBytes('\n'),
    );
  }

  /**
   * 一维码 `BARCODE type width ratio height x y content`：码制白名单
   * （CODE128→'128'、EAN13→'EAN13'，其余拒绝不印 + onWarn）；内容为空返回
   * 空段；人读号开时补发 `BARCODE-TEXT 4 0 x y content` 行（E3 开关缺省关）。
   */
  static barcode(
    symbology: string,
    heightDots: number,
    xDots: number,
    yDots: number,
    content: string,
    options: CpclBarcodeOptions = {},
  ): Uint8Array {
    if (content === '') return new Uint8Array(0);
    const mapped = CpclBuilder.mapSymbology(symbology);
    if (!mapped) {
      options.onWarn?.(`CPCL 码制 "${symbology}" 不在白名单（CODE128/EAN13），该条码不印`);
      return new Uint8Array(0);
    }
    const encode = options.encode ?? gbkEncode;
    const width = Math.max(1, requireInt(options.width ?? 2, 'width'));
    const ratio = Math.max(1, requireInt(options.ratio ?? 1, 'ratio'));
    const x = Math.max(0, requireInt(xDots, 'xDots'));
    const y = Math.max(0, requireInt(yDots, 'yDots'));
    const height = Math.max(1, requireInt(heightDots, 'heightDots'));
    const body = concatBytes(
      asciiBytes(`BARCODE ${mapped} ${width} ${ratio} ${height} ${x} ${y} `),
      encode(content),
      asciiBytes('\n'),
    );
    if (options.humanReadable !== true) return body;
    return concatBytes(
      body,
      asciiBytes(`BARCODE-TEXT ${CpclBuilder.DEFAULT_FONT} 0 ${x} ${y} `),
      encode(content),
      asciiBytes('\n'),
    );
  }

  /**
   * QR 三段式（内容为空返回空段）：
   * ① `BARCODE QR x y M 2 U n`（型号 2、单元 n——域 1-32，narrow 开关收窄 1-10）；
   * ② 数据行 `M0A,content`（ECC M + 掩码 0 + 模式 A 自动，三字符形态）；
   * ③ `ENDQR`。
   */
  static qr(xDots: number, yDots: number, unit: number, content: string, options: CpclQrOptions = {}): Uint8Array {
    if (content === '') return new Uint8Array(0);
    const encode = options.encode ?? gbkEncode;
    const max = options.narrow === true ? 10 : 32;
    const n = clampInt(requireInt(unit, 'unit'), 1, max);
    return concatBytes(
      asciiBytes(`BARCODE QR ${Math.max(0, requireInt(xDots, 'xDots'))} ${Math.max(0, requireInt(yDots, 'yDots'))} M 2 U ${n}\n`),
      asciiBytes('M0A,'),
      encode(content),
      asciiBytes('\n'),
      asciiBytes('ENDQR\n'),
    );
  }

  /** 直线 `LINE x1 y1 x2 y2 thickness`（厚度夹 ≥1——零厚度线无设备语义）。 */
  static line(x1: number, y1: number, x2: number, y2: number, thickness: number): Uint8Array {
    return asciiBytes(
      `LINE ${Math.max(0, requireInt(x1, 'x1'))} ${Math.max(0, requireInt(y1, 'y1'))} ${Math.max(
        0,
        requireInt(x2, 'x2'),
      )} ${Math.max(0, requireInt(y2, 'y2'))} ${Math.max(1, requireInt(thickness, 'thickness'))}\n`,
    );
  }

  /** 结束格式 FORM。 */
  static form(): Uint8Array {
    return asciiBytes('FORM\n');
  }

  /** 打印 PRINT。 */
  static print(): Uint8Array {
    return asciiBytes('PRINT\n');
  }

  /** 码制白名单映射（CPCL 助记符）：CODE128→'128'、EAN13→'EAN13'、其余 null（拒绝）。 */
  static mapSymbology(symbology: string): '128' | 'EAN13' | null {
    const upper = symbology.toUpperCase();
    if (upper === 'CODE128') return '128';
    if (upper === 'EAN13') return 'EAN13';
    return null;
  }

  /**
   * 文本档位解析（Dart _resolveCpclTextSize 同构）：顶层 textSize 为准
   * （0 折 1、夹 1-10）→ 档位 1→0 不放大、2/3/4→同档、≥5 顶格 4；缺省回
   * style.fontSize 兼容档（double→2 / triple→3 / quadruple→4，其余含
   * tall/wide→0——font 4 位图字体仅纵向放大，wide 无横向参数）。
   */
  static resolveTextSizeGrade(el: LabelElement): number {
    const top = topSizeMultiplier(el);
    if (top != null) return top <= 1 ? 0 : Math.min(top, 4);
    switch (styleFontSizeName(el)) {
      case 'double':
        return 2;
      case 'triple':
        return 3;
      case 'quadruple':
        return 4;
      default:
        return 0;
    }
  }

  /**
   * 整帧组装（Dart 帧序）：格式头（高 = mm×8 dot、qty = 份数解析夹 ≥1）→
   * 元素（text/barcode/qrcode/line，未知类型跳过——绝对坐标布局无占位
   * 语义）→ FORM → PRINT。
   */
  static buildLabel(spec: LabelSpec, options: LabelBuildOptions = {}): Uint8Array {
    const resolve = options.resolve ?? ((t: string) => t);
    const encode = options.encode ?? ((t: string) => gbkEncode(t, options));
    const heightDots = dotFromMm(spec.heightMm ?? LABEL_DEFAULTS.heightMm, LABEL_DOTS_PER_MM);
    const parts: Uint8Array[] = [
      CpclBuilder.header(heightDots, resolveCopies(spec.copies, resolve)),
    ];
    for (const el of spec.body ?? []) {
      const { x, y } = elementOriginDots(el);
      switch (el.type) {
        case 'text': {
          parts.push(
            CpclBuilder.text(CpclBuilder.resolveTextSizeGrade(el), x, y, resolve(el.content ?? ''), { encode }),
          );
          break;
        }
        case 'barcode': {
          const content = resolve(el.content ?? '');
          if (content === '') break;
          if (!CpclBuilder.mapSymbology(el.symbology ?? 'CODE128')) {
            options.onWarn?.(`CPCL 码制 "${el.symbology ?? 'CODE128'}" 不在白名单，该条码不印`);
            break;
          }
          const { h } = elementExtentDots(el);
          parts.push(
            CpclBuilder.barcode(el.symbology ?? 'CODE128', h, x, y, content, {
              encode,
              onWarn: options.onWarn,
            }),
          );
          break;
        }
        case 'qrcode': {
          const content = resolve(el.content ?? '');
          if (content === '') break;
          parts.push(
            CpclBuilder.qr(x, y, el.cellSize ?? QRCODE_CELL_DEFAULT, content, { encode }),
          );
          break;
        }
        case 'line': {
          const { w, h } = elementExtentDots(el);
          parts.push(CpclBuilder.line(x, y, x + w, y, h));
          break;
        }
        default:
          break; // 未知元素跳过
      }
    }
    parts.push(CpclBuilder.form(), CpclBuilder.print());
    return concatBytes(...parts);
  }
}
