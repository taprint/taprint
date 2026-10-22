// SPDX-License-Identifier: Apache-2.0
// compile 工具：模板 + 数据 → 三方言字节流。
//   escpos → receipt 呈现（EscPosBuilder 行序）
//   tspl/cpcl → label 呈现（内核 buildLabel 帧序）
// 能力外请求（缺对应呈现、image/barcode 收据元素、非 200/203 dpi、ESC/POS 份数）
// 一律 ToolError 显式报错，不静默降级（ADR-0008）。
import { CpclBuilder, TsplBuilder } from 'taprint';
import { ToolError } from '../lib/errors.ts';
import { mapLabelPresentation } from '../lib/label.ts';
import { mapReceiptPresentation } from '../lib/receipt.ts';
import { buildScope, renderTemplateString } from '../lib/template-string.ts';

export type CompileTarget = 'escpos' | 'tspl' | 'cpcl';

export const COMPILE_TARGETS: readonly CompileTarget[] = ['escpos', 'tspl', 'cpcl'];

export interface CompileOptions {
  /** 目标 dpi；内核锁 8 dot/mm（=203dpi TSPL / 200dpi CPCL），仅接受 200/203。 */
  dpi?: number;
  /** 覆盖纸宽 mm（label：SIZE 宽；receipt：列宽档）。 */
  widthMm?: number;
  /** 覆盖份数（label：PRINT n；ESC/POS 收据份数属宿主重发语义，v0.1 报错）。 */
  copies?: number;
}

export interface CompileInput {
  template: Record<string, unknown>;
  data?: Record<string, unknown>;
  target: CompileTarget;
  options?: CompileOptions;
}

export interface CompileOutput {
  bytesBase64: string;
  byteCount: number;
  frameSummary: string[];
}

export function compileTemplate(input: CompileInput): CompileOutput {
  const target = input.target;
  if (!(COMPILE_TARGETS as readonly string[]).includes(target)) {
    throw new ToolError(
      'unknown-target',
      `未知 target "${String(target)}"（支持：${COMPILE_TARGETS.join(' / ')}）`,
    );
  }
  const options = input.options ?? {};
  if (options.dpi !== undefined && options.dpi !== 200 && options.dpi !== 203) {
    throw new ToolError(
      'unsupported-dpi',
      `dpi=${options.dpi} 不受支持：内核锁 8 dot/mm（200/203dpi 同口径），其他密度待 v0.3`,
    );
  }
  if (options.copies !== undefined && (!Number.isInteger(options.copies) || options.copies < 1 || options.copies > 9999)) {
    throw new ToolError('bad-option', `copies=${String(options.copies)} 非法（1-9999 整数）`);
  }

  const template = input.template;
  const presentations = template.presentations as Record<string, unknown> | undefined;
  const scope = buildScope(template, input.data ?? {});
  const resolve = (tpl: string) => renderTemplateString(tpl, scope);

  if (target === 'escpos') {
    if (options.copies !== undefined) {
      throw new ToolError(
        'option-not-supported',
        'ESC/POS 收据无份数命令（份数=宿主重发整帧），options.copies 仅用于 label 目标',
      );
    }
    const pres = presentations?.receipt as Record<string, unknown> | undefined;
    if (!pres || typeof pres !== 'object') {
      throw new ToolError(
        'missing-presentation',
        '模板无 presentations.receipt——ESC/POS 目标需要收据呈现（label 呈现请选 tspl/cpcl 目标）',
      );
    }
    if (options.widthMm !== undefined) {
      (pres as Record<string, unknown>).width = `${options.widthMm}mm`;
    }
    const { bytes, summary } = mapReceiptPresentation(pres, scope);
    return finish(bytes, summary);
  }

  // tspl / cpcl：label 呈现
  const pres = presentations?.label as Record<string, unknown> | undefined;
  if (!pres || typeof pres !== 'object') {
    throw new ToolError(
      'missing-presentation',
      `模板无 presentations.label——${target.toUpperCase()} 目标需要标签呈现（receipt 呈现请选 escpos 目标）`,
    );
  }
  const mapping = mapLabelPresentation(pres, resolve);
  if (options.widthMm !== undefined) {
    mapping.spec = { ...mapping.spec, widthMm: options.widthMm };
    mapping.summary[0] = `SIZE ${options.widthMm} mm,${mapping.spec.heightMm} mm`;
  }
  if (options.copies !== undefined) {
    mapping.spec = { ...mapping.spec, copies: options.copies };
    mapping.summary[mapping.summary.length - 1] = `PRINT ${options.copies}`;
  }
  const warns: string[] = [];
  const bytes =
    target === 'tspl'
      ? TsplBuilder.buildLabel(mapping.spec, { resolve, onWarn: (m) => warns.push(m) })
      : CpclBuilder.buildLabel(mapping.spec, { resolve, onWarn: (m) => warns.push(m) });
  const summary =
    target === 'tspl'
      ? mapping.summary
      : cpclSummary(mapping.spec, options);
  return finish(bytes, [...summary, ...warns.map((w) => `WARN ${w}`)]);
}

function finish(bytes: Uint8Array, summary: string[]): CompileOutput {
  return {
    bytesBase64: Buffer.from(bytes).toString('base64'),
    byteCount: bytes.length,
    frameSummary: summary,
  };
}

/** CPCL 帧序摘要：header + 元素 + FORM/PRINT（内核 CpclBuilder.buildLabel 同序）。 */
function cpclSummary(spec: import('taprint').LabelSpec, options: CompileOptions): string[] {
  const heightDots = Math.round((spec.heightMm ?? 30) * 8);
  const qty = typeof spec.copies === 'number' ? spec.copies : 1;
  const out = [`! ${options.dpi === 203 ? '203' : '200'} dpi header h=${heightDots} qty=${qty}`];
  for (const el of spec.body ?? []) {
    switch (el.type) {
      case 'text':
        out.push(`T ${Math.round((el.xMm ?? 0) * 8)},${Math.round((el.yMm ?? 0) * 8)} "${String(el.content ?? '').slice(0, 24)}"`);
        break;
      case 'barcode':
        out.push(`B ${Math.round((el.xMm ?? 0) * 8)},${Math.round((el.yMm ?? 0) * 8)} ${el.symbology ?? 'CODE128'}`);
        break;
      case 'qrcode':
        out.push(`Q ${Math.round((el.xMm ?? 0) * 8)},${Math.round((el.yMm ?? 0) * 8)} unit=${el.cellSize ?? 4}`);
        break;
      case 'line':
        out.push(`L ${Math.round((el.xMm ?? 0) * 8)},${Math.round((el.yMm ?? 0) * 8)}`);
        break;
      default:
        break;
    }
  }
  out.push('FORM', 'PRINT');
  return out;
}
