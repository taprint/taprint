#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// 构建后处理：给 dist/index.js 补回 shebang（tsc 不透传文件首行 #!），
// 使 bin 入口可被 npx / 直接执行。
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const entry = join(pkgRoot, 'dist', 'index.js');
const SHEBANG = '#!/usr/bin/env node\n';

let text = readFileSync(entry, 'utf8');
if (!text.startsWith('#!')) {
  text = SHEBANG + text;
  writeFileSync(entry, text);
  console.log('[fix-shebang] dist/index.js 已补 shebang');
} else {
  console.log('[fix-shebang] shebang 已在位，无需处理');
}
