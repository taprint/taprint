// SPDX-License-Identifier: Apache-2.0
// 包内资产（schemas/ 与 examples/）定位与读取。
// 资产固定放在包根：src/lib/assets.ts 与 dist/lib/assets.js 都恰好上溯两级
// （../../）即包根，发布件由 package.json files 字段携带（ADR-0008：schema json
// 与示例模板随 npm 包分发，宿主零仓库依赖）。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

/** 支持的 schema 版本（与 scripts/sync-assets.mjs 同源，tests 断言两侧一致）。 */
export const SCHEMA_VERSIONS = ['1.0', '1.1', '2.0'] as const;

export type SchemaVersion = (typeof SCHEMA_VERSIONS)[number];

/**
 * 精选示例 6 个：收据×2（80mm 小票 / 价签收据孪生）、价签×2、A4 单据×2
 * （与 scripts/sync-assets.mjs 同源，tests 断言两侧一致）。
 */
export const EXAMPLE_FILES = [
  'esc-pos-receipt-v1.0.json',
  'goods-barcode-label-v1.0.json',
  'shelf-label-v1.0.json',
  'goods-label-v1.1.json',
  'sales-note-v1.0.json',
  'payment-receipt-v1.0.json',
] as const;

/** 示例的呈现分类（list_examples 输出用；label=价签/标签，receipt=收据，a4=A4 单据）。 */
export const EXAMPLE_CATEGORIES: Readonly<Record<string, 'receipt' | 'label' | 'a4'>> = {
  'esc-pos-receipt-v1.0.json': 'receipt',
  'goods-barcode-label-v1.0.json': 'receipt',
  'shelf-label-v1.0.json': 'label',
  'goods-label-v1.1.json': 'label',
  'sales-note-v1.0.json': 'a4',
  'payment-receipt-v1.0.json': 'a4',
};

const pkgRoot = fileURLToPath(new URL('../../', import.meta.url))
  .replaceAll('\\', '/')
  .replace(/\/$/, '');

/** 读取指定版本的 JSON Schema（包内资产，随包分发）。 */
export function loadSchema(version: string): object {
  if (!(SCHEMA_VERSIONS as readonly string[]).includes(version)) {
    throw new Error(
      `不支持的 schemaVersion "${version}"（支持：${SCHEMA_VERSIONS.join(' / ')}；旧版模板请先用内核 DslMigrator 迁移）`,
    );
  }
  return JSON.parse(
    readFileSync(join(pkgRoot, 'schemas', `v${version}.json`), 'utf8'),
  ) as object;
}

/** 读取全部精选示例模板。 */
export function loadExamples(): Array<{
  file: string;
  category: 'receipt' | 'label' | 'a4';
  template: Record<string, unknown>;
}> {
  return EXAMPLE_FILES.map((file) => ({
    file,
    category: EXAMPLE_CATEGORIES[file],
    template: JSON.parse(readFileSync(join(pkgRoot, 'examples', file), 'utf8')),
  }));
}
