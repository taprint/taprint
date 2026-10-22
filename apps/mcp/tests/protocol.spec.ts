// SPDX-License-Identifier: Apache-2.0
// MCP 协议层端到端：InMemoryTransport 成对连接 Client ↔ McpServer，
// 走完整 JSON-RPC 通路验证 listTools/callTool（SDK 自带测试运输）。
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.ts';

const fixture = (name: string): Record<string, unknown> =>
  JSON.parse(
    readFileSync(
      fileURLToPath(new URL(`../../../fixtures/templates/${name}`, import.meta.url)),
      'utf8',
    ),
  );

async function connectClient(): Promise<Client> {
  const server = createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'taprint-mcp-test', version: '0.0.1' });
  await client.connect(clientTransport);
  return client;
}

const payload = (result: unknown): unknown => {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content;
  return JSON.parse(content?.[0]?.text ?? '{}');
};

describe('MCP 协议端到端（InMemoryTransport）', () => {
  it('listTools 返回四工具且 schema 可序列化', async () => {
    const client = await connectClient();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['compile', 'list_examples', 'render_preview', 'validate_template']);
    for (const t of tools) expect(t.description!.length).toBeGreaterThan(0);
  });

  it('callTool validate_template：合法货架标签 → valid:true', async () => {
    const client = await connectClient();
    const result = await client.callTool({
      name: 'validate_template',
      arguments: { template: fixture('shelf-label-v1.0.json') },
    });
    expect(payload(result)).toMatchObject({ valid: true, errors: [] });
  });

  it('callTool compile：escpos 小票 → bytesBase64/byteCount/frameSummary 齐备', async () => {
    const client = await connectClient();
    const result = await client.callTool({
      name: 'compile',
      arguments: {
        template: fixture('esc-pos-receipt-v1.0.json'),
        data: {
          main: {
            billNo: 'SN001',
            billDate: '2026-10-22T10:30:00',
            store: { name: 'S', phone: '1' },
            cashier: 'c',
            totalAmount: 1,
            discount: 0,
            paidAmount: 1,
            changeAmount: 0,
            payMethod: 'cash',
          },
          items: [{ name: 'milk', qty: 1, price: 1, amount: 1 }],
        },
        target: 'escpos',
      },
    });
    const out = payload(result) as { bytesBase64: string; byteCount: number; frameSummary: string[] };
    expect(out.byteCount).toBeGreaterThan(0);
    expect(Buffer.from(out.bytesBase64, 'base64')).toHaveLength(out.byteCount);
    expect(out.frameSummary.length).toBeGreaterThan(0);
  });

  it('callTool list_examples：count=6', async () => {
    const client = await connectClient();
    const result = await client.callTool({ name: 'list_examples', arguments: {} });
    expect(payload(result)).toMatchObject({ count: 6 });
  });

  it('callTool 能力外请求 → isError:true + 结构化 error.code', async () => {
    const client = await connectClient();
    const result = await client.callTool({
      name: 'compile',
      arguments: { template: fixture('shelf-label-v1.0.json'), target: 'escpos' },
    });
    expect(result.isError).toBe(true);
    expect(payload(result)).toMatchObject({ error: { code: 'missing-presentation' } });
  });
});
