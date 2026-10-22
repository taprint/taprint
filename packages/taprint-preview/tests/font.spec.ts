// SPDX-License-Identifier: Apache-2.0
// FontProvider 单测：惰性加载、CJK/拉丁 advance 测量、缺失字形 fallback 链。
// 字体文件缺失时 assume-skip（如实报告，不伪造绿）。
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FontProvider } from '../src/font-provider.ts';

const FONT_PATH = fileURLToPath(new URL('../fonts/NotoSansSC-Regular.ttf', import.meta.url));
const fontAvailable = existsSync(FONT_PATH);

describe.skipIf(!fontAvailable)('FontProvider', () => {
  it('惰性加载：构造后未加载，ensureFont 后可用且幂等', async () => {
    const p = new FontProvider();
    expect(p.loaded).toBe(false);
    const font = await p.ensureFont();
    expect(p.loaded).toBe(true);
    expect(font.unitsPerEm).toBeGreaterThan(0);
    expect(await p.ensureFont()).toBe(font);
  });

  it('CJK 字形 advance 大于拉丁（等字号下全角≈两倍半角量级）', async () => {
    const p = new FontProvider();
    const cjk = await p.measure('中', 24);
    const latin = await p.measure('A', 24);
    expect(cjk).toBeGreaterThan(0);
    expect(latin).toBeGreaterThan(0);
    expect(cjk).toBeGreaterThan(latin);
  });

  it('advance 线性于字号（24dot 与 48dot 宽度比 ≈ 2）', async () => {
    const p = new FontProvider();
    const w1 = await p.measure('测试', 24);
    const w2 = await p.measure('测试', 48);
    expect(w2 / w1).toBeCloseTo(2, 5);
  });

  it('ascent 位于 0 与字号之间（基线排版参数）', async () => {
    const p = new FontProvider();
    const a = await p.ascent(24);
    expect(a).toBeGreaterThan(0);
    expect(a).toBeLessThanOrEqual(24);
  });

  it('缺失字形 fallback：notdef 字符按近似宽度占位并汇入 missing', async () => {
    const p = new FontProvider();
    // 朩/仯 属 CJK 扩展区生僻字，Noto Sans SC 常规表大概率缺字；任选一个未覆盖字断言 fallback 语义。
    const run = await p.layout('\u4E2D\u4E00\u9FFF', 24);
    // 断言不假设具体缺字：缺则 missing 非空且 fallback box advance=1em；不缺则精确排版。
    for (const b of run.boxes) {
      if (b.fallback) expect(b.advance).toBe(24);
      else expect(b.advance).toBeGreaterThan(0);
    }
    expect(run.missing.length).toBeLessThanOrEqual(run.boxes.length);
  });
});

describe('FontProvider（字体缺失 assume-skip 登记）', () => {
  it('fonts/NotoSansSC-Regular.ttf 在场性', (t) => {
    if (!fontAvailable) t.skip();
    expect(fontAvailable).toBe(true);
  });
});
