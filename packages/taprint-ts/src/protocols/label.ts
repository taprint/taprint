// SPDX-License-Identifier: Apache-2.0
// 标签方言（TSPL/CPCL）共用布局模型与缺省口径（双参照移植：Dart 移动端
// 兜底标签编码器的 LabelSpec 语义；本层为中性协议模型，不含模板解析）。
//
// 口径：纸面与元素坐标均为 mm；dot 折算统一 numeric.dotFromMm（缺省
// 8 dot/mm——203dpi/200dpi 标签机通行换算）。元素类型兼容子集
// text/barcode/qrcode/line，其余类型编码器跳过（绝对坐标布局无占位语义）。
import { dotFromMm, clampInt } from './numeric.ts';
import type { GbkEncodeOptions } from '../internal/gbk.ts';

/** 8 dot/mm（203dpi 标签机折算口径；CPCL 200dpi 同按 8 dot/mm）。 */
export const LABEL_DOTS_PER_MM = 8;

/** qrcode 模块格缺省（域 1-10；模板显式给 size 时本值不参与）。 */
export const QRCODE_CELL_DEFAULT = 4;

/** 纸面缺省：40×30mm、间隙 2mm、浓度 8、速度 4。 */
export const LABEL_DEFAULTS = {
  widthMm: 40,
  heightMm: 30,
  gapMm: 2,
  density: 8,
  speed: 4,
} as const;

/** 标签元素（绝对坐标 mm；缺省值与 Dart 兼容子集对齐）。 */
export interface LabelElement {
  readonly type: string;
  /** x 坐标 mm（缺省 0）。 */
  readonly xMm?: number;
  /** y 坐标 mm（缺省 0）。 */
  readonly yMm?: number;
  /** 宽 mm（line 缺省 20）。 */
  readonly widthMm?: number;
  /** 高 mm（line/barcode 高度源；缺省 6）。 */
  readonly heightMm?: number;
  /** text/barcode/qrcode 内容（可含模板表达式，经 options.resolve 解析）。 */
  readonly content?: string;
  /** 样式（fontSize 兼容档：normal/tall/wide/double/triple/quadruple）。 */
  readonly style?: Readonly<Record<string, unknown>>;
  /** 条码体系（白名单 CODE128/EAN13，其余拒绝不印）。 */
  readonly symbology?: string;
  /** qrcode 单元大小（缺省 4）。 */
  readonly cellSize?: number;
  /** text 顶层 size 倍率（域 1-10，0 折 1；null=未写 → 按 style.fontSize 兼容档）。 */
  readonly textSize?: number | null;
}

/** 标签规格（纸面 mm + 元素序列；copies 为份数数值或模板串）。 */
export interface LabelSpec {
  readonly widthMm?: number;
  readonly heightMm?: number;
  readonly gapMm?: number;
  /** 打印浓度（TSPL DENSITY 域 0-15）。 */
  readonly density?: number;
  /** 打印速度（TSPL SPEED 域 1-10）。 */
  readonly speed?: number;
  /** 份数：number 直用；string 为模板（经 resolve 解析后按整数读，失败归 1）。 */
  readonly copies?: number | string | null;
  readonly body?: readonly LabelElement[];
}

/** 标签帧组装选项：模板解析/告警/文本编码均为注入面（缺省零依赖）。 */
export interface LabelBuildOptions extends GbkEncodeOptions {
  /** 模板串解析器（缺省恒等——字面量直通；宿主可注入表达式求值器）。 */
  readonly resolve?: (template: string) => string;
  /** 兼容告警出口（白外媒制/未知元素等；缺省丢弃，可接 console/宿主日志）。 */
  readonly onWarn?: (message: string) => void;
  /** 文本段字节编码器（缺省 GBK 子集表，unmapped 策略透传）。 */
  readonly encode?: (text: string) => Uint8Array;
}

/**
 * 份数解析：number 直用；string 经 resolve 后按十进制整数读，空/非法归 1。
 * 与 Dart 端 `int.tryParse(resolved.trim()) ?? 1` 同口径；下限夹 1（0/负份数
 * 无设备语义，C# 构造器层 Math.Max(1, m) 同款——差异已在两处注释标注）。
 */
export function resolveCopies(
  copies: number | string | null | undefined,
  resolve: (template: string) => string,
): number {
  let raw: number;
  if (typeof copies === 'number') {
    raw = copies;
  } else if (typeof copies === 'string') {
    const parsed = Number.parseInt(resolve(copies).trim(), 10);
    raw = Number.isNaN(parsed) ? 1 : parsed;
  } else {
    raw = 1;
  }
  return Math.max(1, Math.trunc(raw));
}

/** 元素顶层 size 倍率：0 折 1、域 1-10；未写（null/undefined）返回 null。 */
export function topSizeMultiplier(el: LabelElement): number | null {
  if (el.textSize == null) return null;
  return el.textSize === 0 ? 1 : clampInt(el.textSize, 1, 10);
}

/** style.fontSize 兼容档名（缺省 normal）。 */
export function styleFontSizeName(el: LabelElement): string {
  const raw = el.style?.['fontSize'];
  return typeof raw === 'string' ? raw : 'normal';
}

/** 元素 x/y 坐标 dot（缺省 0mm）。 */
export function elementOriginDots(el: LabelElement): { x: number; y: number } {
  return {
    x: dotFromMm(el.xMm ?? 0, LABEL_DOTS_PER_MM),
    y: dotFromMm(el.yMm ?? 0, LABEL_DOTS_PER_MM),
  };
}

/** 元素宽/高 dot（缺省 20mm/6mm——line 与条码高度的 Dart 同款缺省）。 */
export function elementExtentDots(el: LabelElement): { w: number; h: number } {
  return {
    w: dotFromMm(el.widthMm ?? 20, LABEL_DOTS_PER_MM),
    h: dotFromMm(el.heightMm ?? 6, LABEL_DOTS_PER_MM),
  };
}
