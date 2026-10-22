// SPDX-License-Identifier: Apache-2.0
// MCP server 组装：McpServer 高层 API 注册四工具（ADR-0008；v0.1 三工具 +
// M3a render_preview 位图预览）。
// createServer 独立导出供 InMemoryTransport 端到端测试复用。
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ToolError } from './lib/errors.ts';
import { compileTemplate, COMPILE_TARGETS } from './tools/compile.ts';
import { listExamples } from './tools/examples.ts';
import { renderPreview } from './tools/render-preview.ts';
import { validateTemplate } from './tools/validate.ts';

export const SERVER_INFO = { name: 'taprint-mcp', version: '0.1.0' } as const;

const textResult = (payload: unknown): { content: Array<{ type: 'text'; text: string }> } => ({
  content: [{ type: 'text', text: JSON.stringify(payload) }],
});

/** ToolError → isError 结果（其余异常原样上抛，由 SDK 转 MCP 错误）。 */
const errorResult = (e: unknown): { content: Array<{ type: 'text'; text: string }>; isError: true } => {
  const err = e instanceof ToolError ? e : null;
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          error: {
            code: err?.code ?? 'internal-error',
            message: e instanceof Error ? e.message : String(e),
          },
        }),
      },
    ],
    isError: true,
  };
};

export function createServer(): McpServer {
  const server = new McpServer(SERVER_INFO);

  server.registerTool(
    'validate_template',
    {
      title: 'Validate a taprint template',
      description:
        'Validate a taprint print-template DSL JSON: JSON Schema (v1.0/v1.1/v2.0, by schemaVersion), kernel business rules (expression grammar, field binding, DSL 2.0 cross-field shapes), and a static host-function audit (ADR-0007: every `fn(...)` call in an expression must be listed in hostFunctions). Returns {valid, errors:[{path,code,message}]}.',
      inputSchema: {
        template: z.record(z.unknown()).describe('taprint 模板 JSON 对象'),
        hostFunctions: z
          .array(z.string())
          .optional()
          .describe('已注册宿主函数名单（表达式 call 白名单；缺省为空）'),
      },
    },
    async ({ template, hostFunctions }) =>
      textResult(validateTemplate({ template, hostFunctions: hostFunctions ?? [] })),
  );

  server.registerTool(
    'compile',
    {
      title: 'Compile a template to printer bytes',
      description:
        'Compile a taprint template (plus data) into an ESC/POS (receipt presentation), TSPL or CPCL (label presentation) byte stream: returns {bytesBase64, byteCount, frameSummary}. Out-of-scope requests (missing presentation, image/barcode receipt elements, dpi other than 200/203, escpos copies) fail with an explicit error. Preview rasterization and physical printing are out of v0.1 (ADR-0008).',
      inputSchema: {
        template: z.record(z.unknown()).describe('taprint 模板 JSON 对象'),
        data: z.record(z.unknown()).optional().describe('绑定数据（字段按模板 dataSources/parameters 提供）'),
        target: z.enum(COMPILE_TARGETS as unknown as [string, string, string]).describe('目标方言：escpos | tspl | cpcl'),
        options: z
          .object({
            dpi: z.number().optional().describe('目标 dpi（内核锁 8 dot/mm，仅 200/203 等效）'),
            widthMm: z.number().optional().describe('覆盖纸宽 mm'),
            copies: z.number().int().optional().describe('覆盖份数（label：PRINT n；escpos 不支持）'),
          })
          .optional(),
      },
    },
    async (input) => {
      try {
        return textResult(
          compileTemplate({
            template: input.template as Record<string, unknown>,
            data: input.data as Record<string, unknown> | undefined,
            target: input.target as 'escpos' | 'tspl' | 'cpcl',
            options: input.options,
          }),
        );
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    'list_examples',
    {
      title: 'List bundled example templates',
      description:
        'List the 6 curated example templates bundled with the package (2 receipts, 2 price/shelf labels, 2 A4 documents): each entry carries {name, code, schemaVersion, category, template}. Use them as validate/compile inputs.',
    },
    async () => textResult(listExamples()),
  );

  server.registerTool(
    'render_preview',
    {
      title: 'Render a template to a monochrome PNG preview',
      description:
        'Render a taprint template (plus data) into a monochrome bitmap preview and write it to a temporary PNG file: returns {path, byteCount, presentation, widthDots, heightDots, warnings}. Label presentations use absolute layout, receipts use flow layout (24-dot line grid); CJK text via the bundled Noto Sans SC (OFL-1.1), Code128/EAN13/QR via bwip-js, pure JavaScript rasterization (ADR-0008). Reads back the PNG from the returned path; the file is a temp file the host may delete. Physical printing remains out of scope.',
      inputSchema: {
        template: z.record(z.unknown()).describe('taprint 模板 JSON 对象'),
        data: z.record(z.unknown()).optional().describe('绑定数据（字段按模板 dataSources/parameters 提供）'),
        presentation: z.enum(['auto', 'label', 'receipt']).optional().describe('呈现选择（缺省 auto：label 优先，缺则 receipt）'),
        options: z
          .object({
            dpi: z.union([z.literal(203), z.literal(300)]).optional().describe('预览 dpi（缺省 203）'),
            threshold: z.number().min(0).max(255).optional().describe('单色化阈值（缺省 128）'),
          })
          .optional(),
      },
    },
    async (input) => {
      try {
        return textResult(
          await renderPreview({
            template: input.template as Record<string, unknown>,
            data: input.data as Record<string, unknown> | undefined,
            presentation: input.presentation as 'auto' | 'label' | 'receipt' | undefined,
            options: input.options as { dpi?: 203 | 300; threshold?: number } | undefined,
          }),
        );
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  return server;
}
