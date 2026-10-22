// SPDX-License-Identifier: Apache-2.0
// TSPL/TSPL2 标签命令构建器（命令级纯函数 + 整帧组装，双参照移植）。
//
// 双参照与取舍（歧义处以语义更完整者为准，差异逐命令标注）：
// - C# 构造器层：命令面冻结集（SIZE/BLINE/SET TEAR/DIRECTION/BAR/BOX/GAP/
//   SPEED/DENSITY/CLS/TEXT/BARCODE/QRCODE/FORMFEED/PRINT）、CR LF 行尾、
//   内容清洗（引号串无转义文法）、参数域夹取、毫米定点格式化；
// - Dart 标签编码器：整帧序（SIZE→GAP→DENSITY→SPEED→DIRECTION 1→CLS→
//   body→PRINT）、QR 带 model/mask 参数形态、条码码制白名单（CODE128/
//   EAN13 直通、其余拒绝不印+告警注入）、mm→dot 折算缺省 8 dot/mm、
//   字号倍率解析（顶层 size 为准、style.fontSize 兼容档回退）。
// 差异裁决已内联标注的要点：行尾 C# CR LF（手册通例）胜出 Dart 单 LF；
// SIZE 参数形态 C# 带空格 "40 mm" 胜出 Dart 无空格 "40mm"；human-readable
// C# 布尔→1/2（手册域）胜出 Dart 常量 0；BARCODE 内容 C# 可见 ASCII 域
// 清洗胜出 Dart GBK 直落。
import { gbkEncode } from '../internal/gbk.ts';
import { asciiBytes, concatBytes } from './bytes.ts';
import { clampInt, formatMm, requireInt } from './numeric.ts';
import {
  LABEL_DEFAULTS,
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

export interface TsplTextOptions {
  /** 字库名（缺省 "SIMPLIFIED CHINESE" 中文简体字库；经 SafeToken 清洗）。 */
  readonly font?: string;
  /** 旋转 0-3（缺省 0）。 */
  readonly rotation?: number;
  /** 横向倍率 1-10（缺省 1）。 */
  readonly xMul?: number;
  /** 纵向倍率 1-10（缺省 1）。 */
  readonly yMul?: number;
  /** 文本段字节编码器（缺省 GBK 子集表；调用方注入以换 GB18030 全表等）。 */
  readonly encode?: (text: string) => Uint8Array;
}

export interface TsplBarcodeOptions {
  /** 人读位：true→1 附读 / false→2 不附（手册域；C# 布尔映射）。 */
  readonly humanReadable?: boolean;
  /** 旋转 0-3（缺省 0）。 */
  readonly rotation?: number;
  /** 窄条宽 dot（缺省 2，下限 1）。 */
  readonly narrow?: number;
  /** 宽条宽 dot（缺省 2，下限 1）。 */
  readonly wide?: number;
  /** 码制白名单外告警出口（缺省丢弃；Dart 端接日志，禁静默折码）。 */
  readonly onWarn?: (message: string) => void;
}

export interface TsplQrOptions {
  /** 纠错档（缺省 M；裸词清洗）。 */
  readonly ecc?: string;
  /** 模块格边长 dot 1-10（缺省 4）。 */
  readonly cell?: number;
  /** 模式（缺省 A=自动；裸词清洗）。 */
  readonly mode?: string;
  /** 旋转 0-3（缺省 0）。 */
  readonly rotation?: number;
  /** 型号（缺省 M——Dart 可执行形态字面量；其注释自称 M2，全表核对归后续）。 */
  readonly model?: string;
  /** 掩码 0-7（缺省 7）。 */
  readonly mask?: number;
  readonly encode?: (text: string) => Uint8Array;
}

/** 点阵参数串：整数校验 + 负值夹 0（负坐标无设备域意义，C# Dot 同款）。 */
function dot(dots: number, name: string): string {
  requireInt(dots, name);
  return Math.max(0, dots).toString();
}

function asciiLine(command: string): Uint8Array {
  return asciiBytes(command);
}

/**
 * TSPL 标签命令构建器：命令级方法返回带 CR LF 行尾的单命令字节段；
 * buildLabel 按 Dart 帧序组装整帧。
 */
export class TsplBuilder {
  private constructor() {}

  /** 命令行收尾（手册通例 CR LF；Dart 端为单 LF——差异裁决取 C#）。 */
  static readonly LINE_TERMINATOR = '\r\n';
  /** 标签间隙遮蔽段缺省（GAP 第二参数 0mm）。 */
  static readonly GAP_BLACKOUT_MM = 0;
  /** 中文字库缺省名。 */
  static readonly DEFAULT_FONT = 'SIMPLIFIED CHINESE';

  /** 纸面尺寸 SIZE width mm,height mm（毫米定点格式化，出参不带多余小数）。 */
  static size(widthMm: number, heightMm: number): Uint8Array {
    return asciiLine(
      `SIZE ${formatMm(widthMm)} mm,${formatMm(heightMm)} mm${TsplBuilder.LINE_TERMINATOR}`,
    );
  }

  /** 黑标定位 BLINE m mm,blackout mm（黑标纸与 GAP 二选一）。 */
  static bLine(blineMm: number): Uint8Array {
    return asciiLine(
      `BLINE ${formatMm(blineMm)} mm,${formatMm(TsplBuilder.GAP_BLACKOUT_MM)} mm${TsplBuilder.LINE_TERMINATOR}`,
    );
  }

  /** 撕纸位送纸 SET TEAR ON|OFF。 */
  static setTear(on: boolean): Uint8Array {
    return asciiLine(`SET TEAR ${on ? 'ON' : 'OFF'}${TsplBuilder.LINE_TERMINATOR}`);
  }

  /** 出图方向 DIRECTION n（0-3；负坐标原点语义缺省 0）。 */
  static direction(direction: number): Uint8Array {
    requireInt(direction, 'direction');
    return asciiLine(
      `DIRECTION ${clampInt(direction, 0, 3)}${TsplBuilder.LINE_TERMINATOR}`,
    );
  }

  /** 实心矩形/粗线 BAR x,y,width,height（宽夹 ≥0、高夹 ≥1——Dart 高度下限胜出 C# 双 0）。 */
  static bar(xDots: number, yDots: number, widthDots: number, heightDots: number): Uint8Array {
    return asciiLine(
      `BAR ${dot(xDots, 'xDots')},${dot(yDots, 'yDots')},${Math.max(0, requireInt(widthDots, 'widthDots'))},${Math.max(
        1,
        requireInt(heightDots, 'heightDots'),
      )}${TsplBuilder.LINE_TERMINATOR}`,
    );
  }

  /** 线框 BOX x,y,width,height,thickness（厚度夹 ≥1）。 */
  static box(
    xDots: number,
    yDots: number,
    widthDots: number,
    heightDots: number,
    thicknessDots: number,
  ): Uint8Array {
    return asciiLine(
      `BOX ${dot(xDots, 'xDots')},${dot(yDots, 'yDots')},${Math.max(
        0,
        requireInt(widthDots, 'widthDots'),
      )},${Math.max(0, requireInt(heightDots, 'heightDots'))},${Math.max(
        1,
        requireInt(thicknessDots, 'thicknessDots'),
      )}${TsplBuilder.LINE_TERMINATOR}`,
    );
  }

  /** 标签间隙 GAP gap mm,blackout mm（遮蔽段缺省 0）。 */
  static gap(gapMm: number): Uint8Array {
    return asciiLine(
      `GAP ${formatMm(gapMm)} mm,${formatMm(TsplBuilder.GAP_BLACKOUT_MM)} mm${TsplBuilder.LINE_TERMINATOR}`,
    );
  }

  /** 打印速度 SPEED n（1-10 夹取）。 */
  static speed(speed: number): Uint8Array {
    requireInt(speed, 'speed');
    return asciiLine(`SPEED ${clampInt(speed, 1, 10)}${TsplBuilder.LINE_TERMINATOR}`);
  }

  /** 打印浓度 DENSITY n（0-15 夹取；Dart 端未夹取直发——差异裁决取 C# 夹域）。 */
  static density(density: number): Uint8Array {
    requireInt(density, 'density');
    return asciiLine(`DENSITY ${clampInt(density, 0, 15)}${TsplBuilder.LINE_TERMINATOR}`);
  }

  /** 清打印缓冲 CLS（每帧首置，残留即重影）。 */
  static cls(): Uint8Array {
    return asciiLine(`CLS${TsplBuilder.LINE_TERMINATOR}`);
  }

  /**
   * 文本 TEXT x,y,"font",rotation,xmul,ymul,"content"。
   * 内容经 sanitize（剔除引号/CR/LF，防命令碎裂——C# 口径；Dart 端未清洗，
   * 差异裁决取 C#）；倍率夹 1-10。
   */
  static text(xDots: number, yDots: number, content: string, options: TsplTextOptions = {}): Uint8Array {
    const encode = options.encode ?? gbkEncode;
    const font = TsplBuilder.safeToken(options.font ?? TsplBuilder.DEFAULT_FONT);
    const rotation = clampInt(options.rotation ?? 0, 0, 3);
    const xMul = clampInt(options.xMul ?? 1, 1, 10);
    const yMul = clampInt(options.yMul ?? 1, 1, 10);
    return concatBytes(
      asciiBytes(
        `TEXT ${dot(xDots, 'xDots')},${dot(yDots, 'yDots')},"${font}",${rotation},${xMul},${yMul},"`,
      ),
      encode(TsplBuilder.sanitize(content)),
      asciiBytes(`"${TsplBuilder.LINE_TERMINATOR}`),
    );
  }

  /**
   * 条码 BARCODE x,y,"symbology",height,human,rotation,narrow,wide,"content"。
   * 码制白名单（Dart E4 口径）：仅 CODE128/EAN13 直通，其余**拒绝不印**
   * （返回空段 + onWarn 告警，禁静默折 CODE128）；内容经 asciiSafe
   * （可见 ASCII 域，C# 口径胜出 Dart GBK 直落）。
   */
  static barcode(
    xDots: number,
    yDots: number,
    symbology: string,
    heightDots: number,
    content: string,
    options: TsplBarcodeOptions = {},
  ): Uint8Array {
    const mapped = TsplBuilder.mapSymbology(symbology);
    if (!mapped) {
      options.onWarn?.(`TSPL 码制 "${symbology}" 不在白名单（CODE128/EAN13），该条码不印`);
      return new Uint8Array(0);
    }
    const human = options.humanReadable === true ? 1 : 2;
    const rotation = clampInt(options.rotation ?? 0, 0, 3);
    const narrow = Math.max(1, requireInt(options.narrow ?? 2, 'narrow'));
    const wide = Math.max(1, requireInt(options.wide ?? 2, 'wide'));
    return concatBytes(
      asciiBytes(
        `BARCODE ${dot(xDots, 'xDots')},${dot(yDots, 'yDots')},"${TsplBuilder.safeToken(
          mapped,
        )}",${Math.max(1, requireInt(heightDots, 'heightDots'))},${human},${rotation},${narrow},${wide},"`,
      ),
      asciiBytes(TsplBuilder.asciiSafe(content)),
      asciiBytes(`"${TsplBuilder.LINE_TERMINATOR}`),
    );
  }

  /**
   * 二维码 QRCODE x,y,ecc,cell,mode,rotation,model,mask,"content"
   * （Dart 带 model/mask 的完整参数形态胜出 C# 7 参形态）。内容经 sanitize；
   * 模块格夹 1-10；内容为空返回空段（Dart 元素级跳过同口径）。
   */
  static qrCode(xDots: number, yDots: number, content: string, options: TsplQrOptions = {}): Uint8Array {
    if (content === '') return new Uint8Array(0);
    const encode = options.encode ?? gbkEncode;
    const ecc = TsplBuilder.safeToken(options.ecc ?? 'M');
    const cell = clampInt(requireInt(options.cell ?? QRCODE_CELL_DEFAULT, 'cell'), 1, 10);
    const mode = TsplBuilder.safeToken(options.mode ?? 'A');
    const rotation = clampInt(options.rotation ?? 0, 0, 3);
    const model = TsplBuilder.safeToken(options.model ?? 'M');
    const mask = clampInt(requireInt(options.mask ?? 7, 'mask'), 0, 7);
    return concatBytes(
      asciiBytes(
        `QRCODE ${dot(xDots, 'xDots')},${dot(yDots, 'yDots')},${ecc},${cell},${mode},${rotation},${model},${mask},"`,
      ),
      encode(TsplBuilder.sanitize(content)),
      asciiBytes(`"${TsplBuilder.LINE_TERMINATOR}`),
    );
  }

  /** 走纸到下一张标签原点 FORMFEED（帧尾收位）。 */
  static formFeed(): Uint8Array {
    return asciiLine(`FORMFEED${TsplBuilder.LINE_TERMINATOR}`);
  }

  /** 打印 PRINT m（份数语义单帧承载，禁客户端逐份循环重发；下限夹 1）。 */
  static printCopies(copies: number): Uint8Array {
    requireInt(copies, 'copies');
    return asciiLine(`PRINT ${Math.max(1, copies)}${TsplBuilder.LINE_TERMINATOR}`);
  }

  /** 码制白名单映射（大小写不敏感）：CODE128/EAN13 直通，其余 null（拒绝）。 */
  static mapSymbology(symbology: string): 'CODE128' | 'EAN13' | null {
    const upper = symbology.toUpperCase();
    if (upper === 'CODE128') return 'CODE128';
    if (upper === 'EAN13') return 'EAN13';
    return null;
  }

  /** 引号串内容清洗：剔除 '"'、CR、LF（TSPL 引号串无转义文法，帧结构字符混入即碎裂）。 */
  static sanitize(content: string): string {
    return content.replace(/["\r\n]/g, '');
  }

  /** 码制字符域清洗：非可见 ASCII（0x20-0x7E）降 '?'。 */
  static asciiSafe(content: string): string {
    let out = '';
    for (const ch of content) {
      const code = ch.charCodeAt(0);
      out += code >= 0x20 && code <= 0x7e ? ch : '?';
    }
    return out;
  }

  /** 引号外裸词清洗（字库/码制/纠错档/模式）：仅保留 ASCII 字母数字与空格。 */
  static safeToken(token: string): string {
    return TsplBuilder.sanitize(token).replace(/[^A-Za-z0-9 ]/g, '');
  }

  /**
   * 字号倍率解析（Dart resolveTextMultiplier 同构，几何层与编码器两处同源）：
   * 顶层 textSize 为准（0 折 1、夹 1-10，x-mul=y-mul 同倍）；缺省回
   * style.fontSize 兼容档（tall=(1,2) / wide=(2,1) / double=(2,2) /
   * triple=(3,3) / quadruple=(4,4) / normal=(1,1)）。
   */
  static resolveTextMultiplier(el: LabelElement): [number, number] {
    const top = topSizeMultiplier(el);
    if (top != null) return [top, top];
    switch (styleFontSizeName(el)) {
      case 'tall':
        return [1, 2];
      case 'wide':
        return [2, 1];
      case 'double':
        return [2, 2];
      case 'triple':
        return [3, 3];
      case 'quadruple':
        return [4, 4];
      default:
        return [1, 1];
    }
  }

  /**
   * 整帧组装（Dart 帧序）：SIZE → GAP → DENSITY → SPEED → DIRECTION 1 →
   * CLS → 元素（text/barcode/qrcode/line，未知类型跳过）→ PRINT 份数。
   * FORMFEED 不入帧（Dart 帧尾无此命令；按机型需要由调用方追加——差异点）。
   * 内容/份数模板经 options.resolve 解析（缺省恒等）；白外媒制经
   * options.onWarn 告警后跳过。
   */
  static buildLabel(spec: LabelSpec, options: LabelBuildOptions = {}): Uint8Array {
    const resolve = options.resolve ?? ((t: string) => t);
    const encode = options.encode ?? ((t: string) => gbkEncode(t, options));
    const parts: Uint8Array[] = [
      TsplBuilder.size(spec.widthMm ?? LABEL_DEFAULTS.widthMm, spec.heightMm ?? LABEL_DEFAULTS.heightMm),
      TsplBuilder.gap(spec.gapMm ?? LABEL_DEFAULTS.gapMm),
      TsplBuilder.density(spec.density ?? LABEL_DEFAULTS.density),
      TsplBuilder.speed(spec.speed ?? LABEL_DEFAULTS.speed),
      TsplBuilder.direction(1),
      TsplBuilder.cls(),
    ];
    for (const el of spec.body ?? []) {
      const { x, y } = elementOriginDots(el);
      switch (el.type) {
        case 'text': {
          const [xMul, yMul] = TsplBuilder.resolveTextMultiplier(el);
          parts.push(
            TsplBuilder.text(x, y, resolve(el.content ?? ''), { xMul, yMul, encode }),
          );
          break;
        }
        case 'barcode': {
          if (!TsplBuilder.mapSymbology(el.symbology ?? 'CODE128')) {
            options.onWarn?.(`TSPL 码制 "${el.symbology ?? 'CODE128'}" 不在白名单，该条码不印`);
            break;
          }
          const { h } = elementExtentDots(el);
          parts.push(
            TsplBuilder.barcode(
              x,
              y,
              el.symbology ?? 'CODE128',
              Math.max(1, h),
              resolve(el.content ?? ''),
              { onWarn: options.onWarn },
            ),
          );
          break;
        }
        case 'qrcode': {
          const content = resolve(el.content ?? '');
          if (content === '') break;
          parts.push(
            TsplBuilder.qrCode(x, y, content, { cell: el.cellSize ?? QRCODE_CELL_DEFAULT, encode }),
          );
          break;
        }
        case 'line': {
          const { w, h } = elementExtentDots(el);
          parts.push(TsplBuilder.bar(x, y, w, Math.max(1, h)));
          break;
        }
        default:
          break; // 未知元素跳过：绝对坐标布局无占位语义（Dart/C# 同口径）
      }
    }
    parts.push(TsplBuilder.printCopies(resolveCopies(spec.copies, resolve)));
    return concatBytes(...parts);
  }
}
