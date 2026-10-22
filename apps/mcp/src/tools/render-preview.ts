// SPDX-License-Identifier: Apache-2.0
// render_preview 工具：模板 + 数据 → 单色 PNG 落临时文件（MCP 文本协议不内联
// 二进制，返回绝对路径 + 尺寸 + 警告）。渲染走 taprint-preview（纯 JS，
// ADR-0008）；物理打印仍永久出圈。
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { renderPng, RenderError, type Dpi, type Presentation } from 'taprint-preview';
import { ToolError } from '../lib/errors.ts';

export interface RenderPreviewInput {
  template: Record<string, unknown>;
  data?: Record<string, unknown>;
  presentation?: Presentation;
  options?: { dpi?: Dpi; threshold?: number };
}

export interface RenderPreviewOutput {
  /** PNG 临时文件绝对路径（宿主自行读取/展示；用后自清理）。 */
  path: string;
  byteCount: number;
  presentation: 'label' | 'receipt';
  widthDots: number;
  heightDots: number;
  warnings: string[];
}

/** 模板 + 数据 → 单色 PNG 临时文件。 */
export async function renderPreview(input: RenderPreviewInput): Promise<RenderPreviewOutput> {
  if (!input.template || typeof input.template !== 'object') {
    throw new ToolError('bad-template', 'template 必须为对象');
  }
  try {
    const result = await renderPng(
      input.template as Record<string, unknown>,
      input.data ?? {},
      { dpi: input.options?.dpi ?? 203, presentation: input.presentation ?? 'auto', threshold: input.options?.threshold },
    );
    const dir = await mkdtemp(join(tmpdir(), 'taprint-preview-'));
    const file = join(dir, `preview-${randomBytes(4).toString('hex')}.png`);
    await writeFile(file, result.png);
    return {
      path: file,
      byteCount: result.png.length,
      presentation: result.presentation,
      widthDots: result.widthDots,
      heightDots: result.heightDots,
      warnings: result.warnings,
    };
  } catch (e) {
    if (e instanceof RenderError) {
      throw new ToolError(e.code, e.message);
    }
    throw e;
  }
}
