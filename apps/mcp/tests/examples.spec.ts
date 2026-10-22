// SPDX-License-Identifier: Apache-2.0
// list_examples 工具测试 + 包内资产防漂断言（与 scripts/sync-assets.mjs 的
// 复制清单/哈希逐项对拍：schema 与示例必须与仓内权威文件逐字节一致）。
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { EXAMPLE_CATEGORIES, EXAMPLE_FILES, SCHEMA_VERSIONS } from '../src/lib/assets.ts';
import { listExamples } from '../src/tools/examples.ts';

const pkgRoot = fileURLToPath(new URL('..', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

describe('list_examples', () => {
  it('返回恰好 6 个示例：收据/价签/A4 各二', () => {
    const out = listExamples();
    expect(out.count).toBe(6);
    expect(out.examples).toHaveLength(6);
    const byCat = new Map<string, number>();
    for (const e of out.examples) byCat.set(e.category, (byCat.get(e.category) ?? 0) + 1);
    expect(byCat.get('receipt')).toBe(2);
    expect(byCat.get('label')).toBe(2);
    expect(byCat.get('a4')).toBe(2);
  });

  it('每个示例含 name/code/schemaVersion/template 且模板非空对象', () => {
    for (const e of listExamples().examples) {
      expect(e.name.length).toBeGreaterThan(0);
      expect(e.code.length).toBeGreaterThan(0);
      expect(['1.0', '1.1', '2.0']).toContain(e.schemaVersion);
      expect(e.template).toBeTruthy();
      expect(Object.keys(e.template).length).toBeGreaterThan(0);
      expect(e.template.presentations).toBeTruthy();
    }
  });

  it('示例模板可直接通过 validate_template（精选=自洽可用）', async () => {
    const { validateTemplate } = await import('../src/tools/validate.ts');
    for (const e of listExamples().examples) {
      const out = validateTemplate({ template: e.template });
      expect(out.valid, `${e.file}: ${JSON.stringify(out.errors.slice(0, 3))}`).toBe(true);
    }
  });
});

describe('包内资产防漂（ADR-0008：schema/示例随包分发，须与仓内权威一致）', () => {
  it('examples/ 目录与 EXAMPLE_FILES 清单一一对应，且逐字节等于仓内 fixtures', () => {
    for (const file of EXAMPLE_FILES) {
      const inPkg = readFileSync(`${pkgRoot}/examples/${file}`);
      const inRepo = readFileSync(`${repoRoot}/fixtures/templates/${file}`);
      expect(inPkg.equals(inRepo), `examples/${file} 与仓内 fixture 漂移`).toBe(true);
    }
  });

  it('schemas/ 三份 schema 逐字节等于仓内 schema/ 权威文件', () => {
    for (const v of SCHEMA_VERSIONS) {
      const inPkg = readFileSync(`${pkgRoot}/schemas/v${v}.json`);
      const inRepo = readFileSync(`${repoRoot}/schema/v${v}.json`);
      expect(inPkg.equals(inRepo), `schemas/v${v}.json 与仓内 schema 漂移`).toBe(true);
    }
  });

  it('assets-manifest.json 哈希与资产实文件一致（复制脚本产物不落谎）', () => {
    const manifest = JSON.parse(readFileSync(`${pkgRoot}/assets-manifest.json`, 'utf8')) as {
      assets: Array<{ file: string; sha256: string; bytes: number }>;
    };
    expect(manifest.assets).toHaveLength(SCHEMA_VERSIONS.length + EXAMPLE_FILES.length);
    for (const a of manifest.assets) {
      const buf = readFileSync(`${pkgRoot}/${a.file}`);
      expect(buf.length).toBe(a.bytes);
      expect(createHash('sha256').update(buf).digest('hex')).toBe(a.sha256);
    }
  });

  it('同步脚本清单与运行时常量同源（SCHEMA_VERSIONS/EXAMPLE_FILES 两侧同值）', async () => {
    const script = readFileSync(`${pkgRoot}/scripts/sync-assets.mjs`, 'utf8');
    expect(script).toContain(`const SCHEMA_VERSIONS = ${JSON.stringify([...SCHEMA_VERSIONS])}`);
    for (const f of EXAMPLE_FILES) expect(script).toContain(`'${f}'`);
    for (const f of Object.keys(EXAMPLE_CATEGORIES)) expect(EXAMPLE_FILES).toContain(f);
  });
});
