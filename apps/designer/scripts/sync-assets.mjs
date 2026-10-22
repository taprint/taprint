#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// 资产同步脚本：把仓库权威 schema（schema/v*.json 与 schema/message-protocol.json）
// 与设计器样例模板（fixtures/templates/ 精选三件）复制进包内 schemas/ 与 samples/
// 目录，并写 assets-manifest.json（每个文件一条 sha256）。
//
//   node scripts/sync-assets.mjs          # 复制 + 写 manifest
//   node scripts/sync-assets.mjs --check  # 只比对不落盘；漂移则退出码 1（build 前置门）
//
// 防漂双保险：本脚本 + tests/unit/assets.spec.ts 的哈希断言。
// 模式对齐 apps/mcp/scripts/sync-assets.mjs（同一套防漂约定）。
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = dirname(dirname(pkgRoot));

/** 与 src/shared/dsl/schema.ts 的 schemaOfVersion 分档保持一致（tests 断言两侧同值）。 */
const SCHEMA_FILES = ['v1.0.json', 'v1.1.json', 'v2.0.json', 'message-protocol.json'];

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** 设计器内置样例模板（与 fixtures/templates/ 逐字节同源，防漂由 manifest 锁定）。 */
const SAMPLE_FILES = [
  'sales-note-v1.0.json',
  'inventory-report-v2.0.json',
  'coupon-sheet-v2.0.json',
];

const plan = [
  ...SCHEMA_FILES.map((f) => ({
    src: join(repoRoot, 'schema', f),
    dest: join(pkgRoot, 'schemas', f),
  })),
  ...SAMPLE_FILES.map((f) => ({
    src: join(repoRoot, 'fixtures', 'templates', f),
    dest: join(pkgRoot, 'samples', f),
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
      console.error(
        `[sync-assets] 漂移：${relative(pkgRoot, dest)} != ${relative(repoRoot, src)}（重跑 npm run sync:assets）`,
      );
      drift += 1;
    }
    continue;
  }
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, buf);
}

if (!checkOnly) {
  const manifest = { generatedBy: 'scripts/sync-assets.mjs', assets: entries };
  writeFileSync(join(pkgRoot, 'assets-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`[sync-assets] 已复制 ${entries.length} 个资产并刷新 assets-manifest.json`);
} else if (drift > 0) {
  console.error(`[sync-assets] --check 失败：${drift} 处漂移`);
  process.exit(1);
} else {
  console.log(`[sync-assets] --check 通过：${entries.length} 个资产与仓内权威文件一致`);
}
