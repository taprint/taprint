#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// 资产同步脚本：把仓库权威 schema（schema/v*.json）与精选模板 fixtures
// （fixtures/templates/*.json）复制进包内 schemas/ 与 examples/ 目录，
// 并写 assets-manifest.json（每个文件一条 sha256）。
//
//   node scripts/sync-assets.mjs          # 复制 + 写 manifest
//   node scripts/sync-assets.mjs --check  # 只比对不落盘；漂移则退出码 1（build 前置门）
//
// 防漂双保险：本脚本 + tests/assets.spec.ts 的逐字节/哈希断言。
const { createHash } = await import('node:crypto');
const { readFileSync, writeFileSync, mkdirSync } = await import('node:fs');
const { dirname, join, relative } = await import('node:path');
const { fileURLToPath } = await import('node:url');

const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = dirname(dirname(pkgRoot));

/** 与 src/lib/assets.ts 的 SCHEMA_VERSIONS 保持一致（tests 断言两边同值）。 */
const SCHEMA_VERSIONS = ["1.0","1.1","2.0"];

/** 精选示例 6 个：收据×2 / 价签×2 / A4×2（与 src/lib/assets.ts EXAMPLE_FILES 同源）。 */
const EXAMPLE_FILES = [
  'esc-pos-receipt-v1.0.json',
  'goods-barcode-label-v1.0.json',
  'shelf-label-v1.0.json',
  'goods-label-v1.1.json',
  'sales-note-v1.0.json',
  'payment-receipt-v1.0.json',
];

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

const plan = [
  ...SCHEMA_VERSIONS.map((v) => ({
    src: join(repoRoot, 'schema', `v${v}.json`),
    dest: join(pkgRoot, 'schemas', `v${v}.json`),
  })),
  ...EXAMPLE_FILES.map((f) => ({
    src: join(repoRoot, 'fixtures', 'templates', f),
    dest: join(pkgRoot, 'examples', f),
  })),
];

const checkOnly = process.argv.includes('--check');
const entries = [];
let drift = 0;

for (const { src, dest } of plan) {
  const buf = readFileSync(src);
  entries.push({
    file: relative(pkgRoot, dest).replaceAll('\\', '/'),
    sha256: sha256(buf),
    bytes: buf.length,
  });
  if (checkOnly) {
    let current = null;
    try {
      current = readFileSync(dest);
    } catch {
      /* 缺文件按漂移处理 */
    }
    if (!current || !current.equals(buf)) {
      console.error(`[sync-assets] 漂移：${relative(pkgRoot, dest)} != ${relative(repoRoot, src)}（重跑 npm run sync:assets）`);
      drift += 1;
    }
    continue;
  }
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, buf);
}

if (!checkOnly) {
  const manifest = { generatedBy: 'scripts/sync-assets.mjs', assets: entries };
  writeFileSync(
    join(pkgRoot, 'assets-manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  console.log(`[sync-assets] 已复制 ${entries.length} 个资产并刷新 assets-manifest.json`);
} else if (drift > 0) {
  console.error(`[sync-assets] --check 失败：${drift} 处漂移`);
  process.exit(1);
} else {
  console.log(`[sync-assets] --check 通过：${entries.length} 个资产与仓内权威文件一致`);
}
