// SPDX-License-Identifier: Apache-2.0
// 包内资产防漂断言（与 scripts/sync-assets.mjs 的 --check 构建门互为双保险，
// 模式对齐 apps/mcp 的 examples.spec.ts）：清单哈希必须与实文件一致，
// 同步脚本声明的资产面必须与清单一致（防"复制脚本产物落谎"）。
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

describe('包内资产防漂', () => {
  const manifest = JSON.parse(readFileSync(join(pkgRoot, 'assets-manifest.json'), 'utf8')) as {
    generatedBy: string;
    assets: { file: string; sha256: string; bytes: number }[];
  };

  it('清单由同步脚本生成且非空', () => {
    expect(manifest.generatedBy).toContain('sync-assets.mjs');
    expect(manifest.assets.length).toBeGreaterThan(0);
  });

  it('assets-manifest.json 哈希与资产实文件一致（复制脚本产物不落谎）', () => {
    for (const entry of manifest.assets) {
      const buf = readFileSync(join(pkgRoot, entry.file));
      const sha = createHash('sha256').update(buf).digest('hex');
      expect(`${entry.file}:${sha}`).toBe(`${entry.file}:${entry.sha256}`);
      expect(buf.length).toBe(entry.bytes);
    }
  });

  it('同步脚本声明的资产面与清单一致（schema 四件 + 样例三件）', () => {
    const script = readFileSync(join(pkgRoot, 'scripts', 'sync-assets.mjs'), 'utf8');
    for (const entry of manifest.assets) {
      const base = entry.file.split('/').pop();
      expect(script).toContain(base);
    }
    const files = manifest.assets.map((a) => a.file).sort();
    expect(files).toEqual([
      'samples/coupon-sheet-v2.0.json',
      'samples/inventory-report-v2.0.json',
      'samples/sales-note-v1.0.json',
      'schemas/message-protocol.json',
      'schemas/v1.0.json',
      'schemas/v1.1.json',
      'schemas/v2.0.json',
    ]);
  });

  it('协议清单为 protocol version 2（ADR-0003 中性命名纪元）', () => {
    const protocol = JSON.parse(
      readFileSync(join(pkgRoot, 'schemas', 'message-protocol.json'), 'utf8'),
    ) as { protocolVersion?: number; title?: string; $comment?: string };
    expect(protocol.protocolVersion).toBeUndefined(); // 顶层仅标准 JSON Schema 关键字（ajv strict 可编译）
    expect(protocol.$comment).toContain('Protocol version: 2');
    expect(protocol.title).not.toMatch(/brands/i);
  });
});
