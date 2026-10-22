// SPDX-License-Identifier: Apache-2.0
// label 呈现（presentations.label）→ 内核 LabelSpec 映射：mm 长度解析、
// line 单形（横/竖）→ BAR 语义换算、qrcode size→cellSize、box/image 的
// 显式处理。帧序由内核 TsplBuilder/CpclBuilder.buildLabel 产出。
import type { LabelElement, LabelSpec } from 'taprint';
import { ToolError } from './errors.ts';
import { mmFromDots, mmOf } from './mm.ts';

type Json = Record<string, unknown>;

/** label 元素映射结果：spec + 帧序摘要（与 buildLabel 帧序一一对应的命令级描述）。 */
export interface LabelMapping {
  spec: LabelSpec;
  summary: string[];
}

/** 元素 x/y（mm）→ dot（内核 dotFromMm 同口径，用于摘要文本）。 */
function dot(mm: number): number {
  return Math.round(mm * 8);
}

/** label 呈现 → LabelSpec + 帧序摘要（不含 SIZE 等纸面命令，见 mapLabelPresentation 组装处）。 */
export function mapLabelPresentation(
  pres: Json,
  resolve: (tpl: string) => string,
): LabelMapping {
  const size = pres.size as Json | undefined;
  if (!size || typeof size !== 'object') {
    throw new ToolError('bad-presentation', 'presentations.label 缺 size（width/height mm）');
  }
  const notes: string[] = [];
  const elements: LabelElement[] = [];
  const body = pres.body;

  if (Array.isArray(body)) {
    body.forEach((raw, i) => {
      const el = raw as Json;
      const path = `presentations.label.body[${i}]`;
      const type = el?.type;
      const xMm = mmOf(el?.x, `${path}.x`);
      const yMm = mmOf(el?.y, `${path}.y`);
      switch (type) {
        case 'text': {
          const sizeNum = typeof el.size === 'number' ? el.size : null;
          elements.push({ type: 'text', xMm, yMm, content: String(el.content ?? ''), textSize: sizeNum });
          notes.push(`TEXT ${dot(xMm)},${dot(yMm)} "${truncate(resolve(String(el.content ?? '')))}"`);
          break;
        }
        case 'barcode': {
          const symbology = String(el.symbology ?? 'CODE128');
          const heightMm = el.height !== undefined ? mmOf(el.height, `${path}.height`) : 6;
          elements.push({ type: 'barcode', xMm, yMm, content: String(el.content ?? ''), symbology, heightMm });
          notes.push(`BARCODE ${dot(xMm)},${dot(yMm)} ${symbology} h=${dot(heightMm)}dot`);
          break;
        }
        case 'qrcode': {
          const cellSize = typeof el.size === 'number' ? el.size : undefined;
          elements.push({ type: 'qrcode', xMm, yMm, content: String(el.content ?? ''), cellSize });
          notes.push(`QRCODE ${dot(xMm)},${dot(yMm)} cell=${cellSize ?? 4}`);
          break;
        }
        case 'line': {
          // D9 单形：横线 height="0mm"（长度=width），竖线 width="0mm"（长度=height）；
          // thickness 以 dot 计（1-32）——BAR 的短边。
          const widthMm = mmOf(el.width, `${path}.width`);
          const heightMm = mmOf(el.height, `${path}.height`);
          const thicknessDots = typeof el.thickness === 'number' ? el.thickness : 2;
          const tMm = mmFromDots(thicknessDots);
          let barW: number;
          let barH: number;
          if (heightMm <= 0) {
            barW = widthMm;
            barH = tMm;
          } else if (widthMm <= 0) {
            barW = tMm;
            barH = heightMm;
          } else {
            barW = widthMm;
            barH = heightMm;
            notes.push(`NOTE line[${i}] 双向非零长度，按实心矩形 BAR 输出`);
          }
          elements.push({ type: 'line', xMm, yMm, widthMm: barW, heightMm: barH });
          notes.push(`BAR ${dot(xMm)},${dot(yMm)} ${dot(barW)}x${dot(Math.max(barH, mmFromDots(1)))}dot (thickness=${thicknessDots})`);
          break;
        }
        case 'box': {
          // 内核 buildLabel 不产 BOX 命令（v0.1 能力边界）；显式记入摘要，不静默丢失。
          notes.push(
            `SKIP box[${i}] — 内核 buildLabel 无 BOX 帧（v0.1 显式跳过，帧序见 ADR-0008 边界）`,
          );
          break;
        }
        case 'image': {
          throw new ToolError(
            'unsupported-element',
            `${path}：image 元素 v0.1 不支持（光栅化属 v0.3 render_preview，ADR-0008）`,
          );
        }
        default: {
          notes.push(`SKIP ${String(type)}[${i}] — 未知元素类型，内核 buildLabel 跳过`);
        }
      }
    });
  }

  const spec: LabelSpec = {
    widthMm: mmOf(size.width, 'presentations.label.size.width'),
    heightMm: mmOf(size.height, 'presentations.label.size.height'),
    gapMm: pres.gap !== undefined ? mmOf(pres.gap, 'presentations.label.gap') : undefined,
    density: typeof pres.density === 'number' ? pres.density : undefined,
    speed: typeof pres.speed === 'number' ? pres.speed : undefined,
    copies: pres.copies as number | string | undefined,
    body: elements,
  };

  const summary = [
    `SIZE ${spec.widthMm} mm,${spec.heightMm} mm`,
    `GAP ${spec.gapMm ?? 2} mm,0 mm`,
    `DENSITY ${spec.density ?? 8}`,
    `SPEED ${spec.speed ?? 4}`,
    ...(notes.length > 0 ? notes : ['(空 body)']),
    `PRINT ${previewCopies(spec.copies, resolve)}`,
  ];
  return { spec, summary };
}

/** 份数预览（number 直读；模板串按 resolve 后整数读，失败归 1——内核 resolveCopies 同口径）。 */
function previewCopies(copies: number | string | null | undefined, resolve: (t: string) => string): number {
  if (copies === undefined || copies === null) return 1;
  if (typeof copies === 'number') return Math.trunc(copies) >= 1 ? Math.trunc(copies) : 1;
  const parsed = Number.parseInt(resolve(copies).trim(), 10);
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : 1;
}

function truncate(text: string, max = 24): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
