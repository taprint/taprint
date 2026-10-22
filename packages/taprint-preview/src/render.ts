// SPDX-License-Identifier: Apache-2.0
// 渲染入口：DSL 模板 + 数据 → 画布 / PNG。呈现选择 auto（label 优先，缺则
// receipt）、显式 dpi（203/300）、阈值单色化（抖动为后续任务）。
import { FontProvider, type FontProviderOptions } from './font-provider.ts';
import { renderLabelPresentation } from './label-render.ts';
import { renderReceiptPresentation } from './receipt-render.ts';
import { RenderError, buildScope, type Json } from './scope.ts';

export type Dpi = 203 | 300;
export type Presentation = 'auto' | 'label' | 'receipt';

export interface RenderOptions extends FontProviderOptions {
  /** 目标 dpi（缺省 203）。 */
  dpi?: Dpi;
  /** 呈现选择（缺省 auto：label 优先）。 */
  presentation?: Presentation;
  /** 单色化阈值 0-255（缺省 128）。 */
  threshold?: number;
}

export interface CanvasResult {
  canvas: import('./canvas.ts').MonoCanvas;
  warnings: string[];
  presentation: 'label' | 'receipt';
  widthDots: number;
  heightDots: number;
}

export interface RenderResult {
  /** 单色 PNG（grayscale 8bpp）。 */
  png: Buffer;
  /** 渲染警告（缺字形/元素跳过/码制不支持/圆角降级等，诚实登记不静默）。 */
  warnings: string[];
  presentation: 'label' | 'receipt';
  widthDots: number;
  heightDots: number;
}

function pickPresentation(template: Json, want: Presentation): 'label' | 'receipt' {
  const pres = template.presentations as Json | undefined;
  const hasLabel = Boolean(pres?.label);
  const hasReceipt = Boolean(pres?.receipt);
  if (want === 'label') {
    if (!hasLabel) throw new RenderError('missing-presentation', '模板无 presentations.label（options.presentation=label）');
    return 'label';
  }
  if (want === 'receipt') {
    if (!hasReceipt) throw new RenderError('missing-presentation', '模板无 presentations.receipt（options.presentation=receipt）');
    return 'receipt';
  }
  if (hasLabel) return 'label';
  if (hasReceipt) return 'receipt';
  throw new RenderError('missing-presentation', '模板无 presentations.label / presentations.receipt——预览无票面可渲染');
}

function checkOptions(options: RenderOptions): void {
  if (options.dpi !== undefined && options.dpi !== 203 && options.dpi !== 300) {
    throw new RenderError('unsupported-dpi', `dpi=${String(options.dpi)} 不受支持（预览支持 203/300）`);
  }
  if (options.threshold !== undefined && (!Number.isFinite(options.threshold) || options.threshold < 0 || options.threshold > 255)) {
    throw new RenderError('bad-option', `threshold=${String(options.threshold)} 非法（0-255）`);
  }
}

/** DSL 模板 + 数据 → 画布（中间层；PNG 编码见 renderPng）。 */
export async function renderCanvas(
  template: Json,
  data: Json = {},
  options: RenderOptions = {},
): Promise<CanvasResult> {
  checkOptions(options);
  const dpi = options.dpi ?? 203;
  const presentation = pickPresentation(template, options.presentation ?? 'auto');
  const pres = (template.presentations as Json)[presentation] as Json;
  const scope = buildScope(template, data);
  const provider = new FontProvider({ fontPath: options.fontPath });
  const result =
    presentation === 'label'
      ? await renderLabelPresentation(pres, scope, provider, dpi)
      : await renderReceiptPresentation(pres, scope, provider, dpi);
  return { ...result, presentation };
}

/** DSL 模板 + 数据 → 单色 PNG。 */
export async function renderPng(
  template: Json,
  data: Json = {},
  options: RenderOptions = {},
): Promise<RenderResult> {
  const { canvas, warnings, presentation, widthDots, heightDots } = await renderCanvas(template, data, options);
  const png = canvas.toPng(options.threshold ?? 128);
  return { png, warnings, presentation, widthDots, heightDots };
}

export { FontProvider } from './font-provider.ts';
export { MonoCanvas } from './canvas.ts';
export { RenderError } from './scope.ts';
export { mmToDots, ptToDots, parseMm, dotsPerMm, lengthToDots } from './length.ts';
export type { InkMask } from './barcode.ts';
