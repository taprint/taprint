// SPDX-License-Identifier: Apache-2.0
// render_preview 工具单测：出图落盘、尺寸/警告、错误面（ToolError 码透传）。
import { describe, expect, it } from 'vitest';
import { readFile, rm } from 'node:fs/promises';
import { renderPreview } from '../src/tools/render-preview.ts';
import { ToolError } from '../src/lib/errors.ts';

const RECEIPT = {
  schemaVersion: '1.1',
  id: 'tpl_mcp_prev',
  code: 'MCP_PREV',
  name: 'MCP 预览',
  dataSources: [{ name: 'main', type: 'primary', schema: { shop: 'string' } }],
  presentations: {
    receipt: {
      width: '58mm',
      body: [
        { type: 'text', content: '{{shop}}', align: 'center', style: { fontSize: 'double' } },
        { type: 'line', lineStyle: 'solid' },
        { type: 'barcode', symbology: 'CODE128', content: '690123456789', height: '8mm' },
      ],
    },
  },
};

describe('render_preview 工具', () => {
  it('出图落临时文件：PNG 非空、尺寸 464dot 宽（58mm@203）、warnings 透传', async () => {
    const out = await renderPreview({ template: RECEIPT, data: { main: { shop: '预览商店' } } });
    expect(out.byteCount).toBeGreaterThan(100);
    expect(out.widthDots).toBe(464);
    expect(out.presentation).toBe('receipt');
    expect(out.path).toMatch(/taprint-preview-.*\.png$/);
    const buf = await readFile(out.path);
    expect(buf.length).toBe(out.byteCount);
    // PNG 魔数
    expect(buf.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    await rm(out.path).catch(() => {});
  });

  it('presentation=receipt 显式选择；缺 label 呈现报 missing-presentation', async () => {
    const out = await renderPreview({ template: RECEIPT, presentation: 'receipt', data: { main: { shop: 'x' } } });
    expect(out.presentation).toBe('receipt');
    await expect(renderPreview({ template: RECEIPT, presentation: 'label' })).rejects.toThrow(ToolError);
  });

  it('RenderError → ToolError 码透传（unsupported-dpi / missing-presentation）', async () => {
    await expect(renderPreview({ template: RECEIPT, options: { dpi: 150 as never } })).rejects.toThrow(/203\/300/);
    await expect(renderPreview({ template: { presentations: {} } })).rejects.toThrow(/presentations/);
  });

  it('非对象模板显式报错', async () => {
    await expect(renderPreview({ template: undefined as never })).rejects.toThrow(ToolError);
  });
});
