// SPDX-License-Identifier: Apache-2.0
// ESC/POS 字节构造器（命令级纯函数，双参照移植）。
//
// 双参照与取舍（歧义处以语义更完整者为准，差异逐命令标注）：
// - Dart 移动端兜底编码器：对齐/字号/粗体/QR 原生五步/切纸留白/钱箱脉冲/
//   知名命令白名单映射——模板级语义最全，本文件的命令面以其为准；
// - C# 构造器层：feedLines/钱箱参数化/cutAtPosition 形态/ASCII 编码/
//   自检票组装/toHex 诊断——参数校验与帧组装语义以其为准。
// 条码命令不在共享子集（Dart 端按「未知元素空行」兜底），本层不提供。
import { gbkEncode, type GbkEncodeOptions } from '../internal/gbk.ts';
import { asciiBytes, concatBytes } from './bytes.ts';
import { clampInt, requireInt } from './numeric.ts';

/** 对齐位（ESC a n：0/1/2）。 */
export type EscPosAlign = 'left' | 'center' | 'right';

/** 字号档名（GS ! n 位组合）。 */
export type EscPosFontSize = 'normal' | 'tall' | 'wide' | 'double' | 'triple' | 'quadruple';

export interface EscPosTextOptions extends GbkEncodeOptions {
  readonly align?: EscPosAlign;
  readonly fontSize?: EscPosFontSize;
  readonly bold?: boolean;
}

/** ESC/POS 控制字节。 */
const ESC = 0x1b;
const GS = 0x1d;

function byte(value: number): Uint8Array {
  return new Uint8Array([value]);
}

function bytes(...list: number[]): Uint8Array {
  return Uint8Array.from(list);
}

/**
 * ESC/POS 字节构造器：全部方法纯函数返回独立字节段，由调用方按帧序拼接
 * （frame 组装示范见 buildSelfTestReceipt）。
 */
export class EscPosBuilder {
  private constructor() {}

  /** ESC 控制字节 0x1B。 */
  static readonly esc = ESC;
  /** GS 组控制字节 0x1D。 */
  static readonly gs = GS;

  /** 初始化 ESC @（0x1B 0x40）：清打印缓冲、复位模式；帧首惯例。 */
  static initialize(): Uint8Array {
    return bytes(ESC, 0x40);
  }

  /** 换行走纸 LF（0x0A）：按当前行高走一行。 */
  static lineFeed(): Uint8Array {
    return byte(0x0a);
  }

  /** 走纸 n 行 ESC d n（0x1B 0x64 n）；n 为 0-255 整数。 */
  static feedLines(lineCount: number): Uint8Array {
    requireInt(lineCount, 'lineCount');
    return bytes(ESC, 0x64, clampInt(lineCount, 0, 255));
  }

  /**
   * 对齐 ESC a n：left=0 / center=1 / right=2。
   * Dart 端对未知名静默归 left；本层收紧为显式枚举校验（非法值抛错，
   * 防帧序里混入静默错位——差异点）。
   */
  static align(position: EscPosAlign): Uint8Array {
    if (position !== 'left' && position !== 'center' && position !== 'right') {
      throw new RangeError(`align 非法取值：${String(position)}`);
    }
    const n = position === 'center' ? 0x01 : position === 'right' ? 0x02 : 0x00;
    return bytes(ESC, 0x61, n);
  }

  /** 字号 GS ! n（位组合：高 4 位横向、低 4 位纵向；Dart 映射同款）。 */
  static fontSize(size: EscPosFontSize): Uint8Array {
    const n = EscPosBuilder.fontSizeByte(size);
    return bytes(GS, 0x21, n);
  }

  /** 字号档名 → GS ! 参数字节（normal=00 / tall=01 / wide=10 / double=11 / triple=22 / quadruple=33）。 */
  static fontSizeByte(size: EscPosFontSize): number {
    switch (size) {
      case 'tall':
        return 0x01;
      case 'wide':
        return 0x10;
      case 'double':
        return ((2 - 1) << 4) | (2 - 1);
      case 'triple':
        return ((3 - 1) << 4) | (3 - 1);
      case 'quadruple':
        return ((4 - 1) << 4) | (4 - 1);
      case 'normal':
        return 0x00;
      default:
        throw new RangeError(`fontSize 非法取值：${String(size)}`);
    }
  }

  /** 粗体开关 ESC E n（1=开 / 0=关）。 */
  static bold(on: boolean): Uint8Array {
    return bytes(ESC, 0x45, on ? 0x01 : 0x00);
  }

  /** 选择中文字符集 FS &（0x1C 0x26）：中文 GBK 字节流写入前的换挡前缀。 */
  static selectChineseEncoding(): Uint8Array {
    return bytes(0x1c, 0x26);
  }

  /** 文本 → GBK 子集字节（表外字符策略见 internal/gbk；Dart 源同通道）。 */
  static encodeText(text: string, options: GbkEncodeOptions = {}): Uint8Array {
    return gbkEncode(text, options);
  }

  /**
   * ASCII 文本编码：可见 ASCII 原样，≥ 0x80 降 '?'（0x3F）——
   * C# Encoding.ASCII 同语义（替换而非抛错）。
   */
  static encodeAscii(text: string): Uint8Array {
    const out = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      out[i] = code >= 0x80 ? 0x3f : code;
    }
    return out;
  }

  /**
   * 文本行帧（Dart _encodeText 同构）：对齐 + 字号 + 粗体 → 按行 GBK+LF →
   * 回落 normal 字号 + 关粗体（状态回落防污染后续行）。
   */
  static textLine(text: string, options: EscPosTextOptions = {}): Uint8Array {
    const align = options.align ?? 'left';
    const size = options.fontSize ?? 'normal';
    return concatBytes(
      EscPosBuilder.align(align),
      bytes(GS, 0x21, EscPosBuilder.fontSizeByte(size)),
      EscPosBuilder.bold(options.bold === true),
      ...text.split('\n').flatMap((line) => [gbkEncode(line, options), EscPosBuilder.lineFeed()]),
      bytes(GS, 0x21, 0x00),
      EscPosBuilder.bold(false),
    );
  }

  /** 分隔线（Dart line 元素同构）：左对齐 + '-'×widthCols + LF。 */
  static divider(widthCols = 32): Uint8Array {
    requireInt(widthCols, 'widthCols');
    if (widthCols < 1) throw new RangeError('widthCols 须为正整数');
    return concatBytes(
      EscPosBuilder.align('left'),
      asciiBytes('-'.repeat(widthCols)),
      EscPosBuilder.lineFeed(),
    );
  }

  /**
   * QR 原生五步序列（Dart 端与后端 writeQrCodeNative 逐字节一致）：
   * ① 模型 2 → ② 模块大小 n（夹 1-16）→ ③ 纠错 M → ④ 存数据
   * （pL/pH = 数据长+3，小端）→ ⑤ 打印 + LF。内容为空返回空段
   * （Dart 元素级跳过同口径）。
   */
  static qrCode(content: string, moduleSize = 6): Uint8Array {
    if (content === '') return new Uint8Array(0);
    requireInt(moduleSize, 'moduleSize');
    const n = clampInt(moduleSize, 1, 16);
    const data = gbkEncode(content);
    const len = data.length + 3;
    return concatBytes(
      bytes(0x1d, 0x28, 0x6b, 0x04, 0x00, 0x31, 0x41, 0x02, 0x00),
      bytes(0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x43, n),
      bytes(0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x45, 0x31),
      bytes(0x1d, 0x28, 0x6b, len & 0xff, (len >> 8) & 0xff, 0x31, 0x50, 0x30),
      data,
      bytes(0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x51, 0x30),
      EscPosBuilder.lineFeed(),
    );
  }

  /**
   * 切纸（Dart writeCut 同构）：前留 3 行走纸（0A×3）+ GS V m
   * （m=1 半切 / 0 全切）。
   */
  static cut(partial = true): Uint8Array {
    return bytes(0x0a, 0x0a, 0x0a, GS, 0x56, partial ? 0x01 : 0x00);
  }

  /**
   * 走纸到位切纸 GS V 66 n（0x1D 0x56 0x42 n）：带第二参数的 m=0x42 变体，
   * 自动切刀机型最通用形态（C# CutPaper 同款；与 cut() 的 m=0/1 形态并存，
   * 按机型兼容面选用）。
   */
  static cutAtPosition(feedLineCount = 0): Uint8Array {
    requireInt(feedLineCount, 'feedLineCount');
    return bytes(GS, 0x56, 0x42, clampInt(feedLineCount, 0, 255));
  }

  /**
   * 钱箱脉冲 ESC p m t1 t2：m=0 引脚 2 / 1 引脚 5；t1 接通、t2 释放刻度
   * （芯片按 ×2ms 近似归一）。pin 限定 0/1（C# 校验同款）。
   * Dart 端为便捷档：m 由 pulse(2→1 否则 0) 选取且 t1=t2=0x19 固定——
   * 等价于 drawerKickPulse(0, 0x19, 0x19)（差异点）。
   */
  static drawerKickPulse(pin: 0 | 1, onTicks: number, offTicks: number): Uint8Array {
    if (pin !== 0 && pin !== 1) {
      throw new RangeError('钱箱脉冲引脚只允许 0（引脚 2）/ 1（引脚 5）两值');
    }
    requireInt(onTicks, 'onTicks');
    requireInt(offTicks, 'offTicks');
    return bytes(ESC, 0x70, pin, clampInt(onTicks, 0, 255), clampInt(offTicks, 0, 255));
  }

  /** 钱箱便捷档：引脚 2，接通约 50ms（t1=25）/ 释放占位 250（C# 经验缺省）。 */
  static drawerKickPulseDefault(): Uint8Array {
    return EscPosBuilder.drawerKickPulse(0, 25, 250);
  }

  /**
   * 知名命令助记符映射（Dart initCommands/tailCommands 白名单同款）：
   * 规范化（trim/大写/压空白）后映射 'ESC @'、'GS V 0|48'、'GS V 1|49'；
   * 未知助记符返回 null（调用方决定丢弃或告警）。
   */
  static mapCommand(mnemonic: string): Uint8Array | null {
    const norm = mnemonic.trim().toUpperCase().replace(/\s+/g, ' ');
    switch (norm) {
      case 'ESC @':
        return EscPosBuilder.initialize();
      case 'GS V 0':
      case 'GS V 48':
        return bytes(GS, 0x56, 0x00);
      case 'GS V 1':
      case 'GS V 49':
        return bytes(GS, 0x56, 0x01);
      default:
        return null;
    }
  }

  /**
   * 最小自检票帧（C# BuildSelfTestReceipt 同构、文案中性化）：
   * 初始化 + 标识行 + LF + 走纸 3 行 + 走纸到位半切。纯 ASCII 零中文编码依赖。
   */
  static buildSelfTestReceipt(): Uint8Array {
    return concatBytes(
      EscPosBuilder.initialize(),
      EscPosBuilder.encodeAscii('TAPRINT PRINT SELFTEST'),
      EscPosBuilder.lineFeed(),
      EscPosBuilder.feedLines(3),
      EscPosBuilder.cutAtPosition(0),
    );
  }

  /** 字节序十六进制串化（大写、空格分隔；null/undefined → 空串）——诊断辅助，非送打路径。 */
  static toHex(bytesIn: Uint8Array | null): string {
    if (!bytesIn) return '';
    return [...bytesIn].map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
  }
}
