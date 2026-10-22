// SPDX-License-Identifier: Apache-2.0
// ADR-0010 golden 分层 TS runner（vitest）：
// - L1 帧序：对全部用例比对 fixtures/expected/commands/<case>/java/ 的帧序列，
//   分叉只输出差异报告（docs/conformance.md 登记在案），不作断言失败；
// - L2 字节摘要：仅在 manifest l2Assert.ts === true（当前字节全等=绿格）的
//   用例上断言 sha256；身份函数用例（containsIdentityFn）只跑 L1。
// 用法与工件规格：fixtures/README.md。
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { asciiBytes, concatBytes } from '../src/protocols/bytes.ts';
import { CpclBuilder } from '../src/protocols/cpcl.ts';
import { EscPosBuilder } from '../src/protocols/escpos.ts';
import type { LabelElement, LabelSpec } from '../src/protocols/label.ts';
import { TsplBuilder } from '../src/protocols/tspl.ts';
import {
  cpclFrames,
  escapeContent,
  escposFrames,
  renderFrames,
  tsplFrames,
  type Frame,
} from './golden/frames.ts';

interface CaseElement {
  type: string;
  text?: string;
  align?: string;
  x?: string;
  y?: string;
  width?: string;
  height?: string;
  size?: number;
  symbology?: string;
  humanReadable?: boolean;
  partial?: boolean;
  style?: { fontSize?: string; bold?: boolean };
  headers?: string[];
  columns?: Array<{ width?: string; align?: string }>;
  rows?: string[][];
}

interface GoldenCase {
  schema: string;
  id: string;
  profile: string;
  protocols: string[];
  containsIdentityFn: boolean;
  special: string | null;
  input: {
    copies?: number;
    receipt?: { widthCols?: number; encoding?: string; nativeQr?: boolean };
    label?: Record<string, string | number>;
    body: CaseElement[];
  };
}

interface ManifestCase {
  case: string;
  containsIdentityFn: boolean;
  layers: { l1: boolean; l2: boolean };
  l2Assert: Record<string, boolean>;
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const fixturesDir = resolve(repoRoot, 'fixtures');

const manifest = JSON.parse(
  readFileSync(resolve(fixturesDir, 'manifest.json'), 'utf8'),
) as { cases: ManifestCase[] };
const manifestByCase = new Map(manifest.cases.map((c) => [c.case, c]));

const cases: GoldenCase[] = manifest.cases
  .map((entry) =>
    JSON.parse(readFileSync(resolve(fixturesDir, `cases/${entry.case}.json`), 'utf8')) as GoldenCase,
  )
  .filter((c) => c.protocols.includes('tspl') || c.protocols.includes('cpcl') || c.protocols.includes('escpos'));

// ---- canonical → TS 输入映射 ----

const mm = (v: string | undefined, fallback: number): number =>
  v === undefined ? fallback : Number.parseFloat(v.replace(/mm$/, '')) || fallback;

function toLabelSpec(c: GoldenCase): LabelSpec {
  const l = c.input.label ?? {};
  return {
    widthMm: mm(String(l.width ?? '60mm'), 60),
    heightMm: mm(String(l.height ?? '40mm'), 40),
    gapMm: mm(String(l.gap ?? '2mm'), 2),
    density: typeof l.density === 'number' ? l.density : 8,
    speed: typeof l.speed === 'number' ? l.speed : 4,
    copies: c.input.copies ?? 1,
    body: c.input.body
      .filter((el) => ['text', 'barcode', 'qrcode', 'line', 'rect'].includes(el.type))
      .map((el): LabelElement => {
        switch (el.type) {
          case 'text':
            return {
              type: 'text',
              xMm: mm(el.x, 0),
              yMm: mm(el.y, 0),
              content: el.text ?? '',
              textSize: el.size ?? null,
              style: el.style ? { fontSize: el.style.fontSize } : undefined,
            };
          case 'barcode':
            return {
              type: 'barcode',
              xMm: mm(el.x, 0),
              yMm: mm(el.y, 0),
              heightMm: mm(el.height, 6),
              content: el.text ?? '',
              symbology: el.symbology ?? 'CODE128',
            };
          case 'qrcode':
            return {
              type: 'qrcode',
              xMm: mm(el.x, 0),
              yMm: mm(el.y, 0),
              content: el.text ?? '',
              cellSize: el.size ?? 4,
            };
          case 'line':
            return {
              type: 'line',
              xMm: mm(el.x, 0),
              yMm: mm(el.y, 0),
              widthMm: mm(el.width, 20),
              heightMm: mm(el.height, 6),
            };
          default:
            return { type: 'rect', xMm: mm(el.x, 0), yMm: mm(el.y, 0) };
        }
      }),
  };
}

/** TS 无小票整帧引擎：按 Java 帧文法以命令级 builder 组装（结构性分叉见 conformance.md）。 */
function buildEscPosReceipt(c: GoldenCase): { bytes: Uint8Array; skipped: boolean } {
  const parts: Uint8Array[] = [EscPosBuilder.initialize(), EscPosBuilder.selectChineseEncoding()];
  let skipped = false;
  for (const el of c.input.body) {
    switch (el.type) {
      case 'text': {
        parts.push(
          EscPosBuilder.textLine(el.text ?? '', {
            align: (el.align ?? 'left') as 'left' | 'center' | 'right',
            fontSize: (el.style?.fontSize ?? 'normal') as 'normal' | 'tall' | 'wide' | 'double',
            bold: el.style?.bold === true,
          }),
        );
        break;
      }
      case 'spacer': {
        parts.push(EscPosBuilder.lineFeed());
        break;
      }
      case 'cut': {
        for (let i = 0; i < 8; i++) parts.push(EscPosBuilder.lineFeed());
        const cut = EscPosBuilder.mapCommand(el.partial === false ? 'GS V 0' : 'GS V 1');
        if (cut) parts.push(cut);
        break;
      }
      case 'qrcode': {
        const align = (el.align ?? 'center') as 'left' | 'center' | 'right';
        parts.push(EscPosBuilder.align(align));
        parts.push(EscPosBuilder.qrCode(el.text ?? '', el.size ?? 6));
        break;
      }
      default: {
        // barcode / table：TS EscPosBuilder 无对应命令面（共享子集外）
        skipped = true;
        break;
      }
    }
  }
  for (let i = 0; i < 8; i++) parts.push(EscPosBuilder.lineFeed());
  return { bytes: concatBytes(...parts), skipped };
}

function tsBytesFor(c: GoldenCase, protocol: string): { bytes: Uint8Array; skipped: boolean } {
  if (protocol === 'tspl') {
    return { bytes: TsplBuilder.buildLabel(toLabelSpec(c)), skipped: false };
  }
  if (protocol === 'cpcl') {
    return { bytes: CpclBuilder.buildLabel(toLabelSpec(c)), skipped: false };
  }
  return buildEscPosReceipt(c);
}

function framesFor(protocol: string, bytes: Uint8Array): Frame[] {
  if (protocol === 'tspl') return tsplFrames(bytes);
  if (protocol === 'cpcl') return cpclFrames(bytes);
  return escposFrames(bytes);
}

const sha256 = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');

interface Row {
  caseId: string;
  protocol: string;
  l1: 'EQUAL' | 'DIVERGE' | 'SKIP';
  l2: 'equal' | 'diff' | 'skip';
  /** manifest l2Assert.ts —— 仅绿格断言；其余只探测（报告用，不作断言失败） */
  l2Asserted: boolean;
  detail: string;
}

function runSweep(): Row[] {
  const rows: Row[] = [];
  for (const c of cases) {
    const entry = manifestByCase.get(c.id);
    if (!entry) continue;
    for (const protocol of c.protocols) {
      const { bytes, skipped } = tsBytesFor(c, protocol);
      const actual = renderFrames(framesFor(protocol, bytes));
      const expectedFrames = readFileSync(
        resolve(fixturesDir, `expected/commands/${c.id}/java/${protocol}.frames.txt`),
        'utf8',
      );
      const l1: Row['l1'] = skipped ? 'SKIP' : actual === expectedFrames ? 'EQUAL' : 'DIVERGE';
      let l2: Row['l2'] = 'skip';
      let detail = '';
      if (!entry.containsIdentityFn) {
        const expectedDigest = readFileSync(
          resolve(fixturesDir, `expected/commands/${c.id}/java/${protocol}.bytes.sha256`),
          'utf8',
        ).trim();
        l2 = sha256(bytes) === expectedDigest ? 'equal' : 'diff';
      }
      if (skipped) {
        detail = 'TS 命令面缺失（barcode/table），该协议帧跳过';
      } else if (l1 === 'DIVERGE') {
        detail = `首处帧差: ${firstDiff(expectedFrames, actual) ?? ''}`;
      }
      rows.push({ caseId: c.id, protocol, l1, l2, l2Asserted: entry.l2Assert.ts === true, detail });
    }
  }
  return rows;
}

function firstDiff(expected: string, actual: string): string | null {
  const e = expected.split('\n');
  const a = actual.split('\n');
  for (let i = 0; i < Math.max(e.length, a.length); i++) {
    if (e[i] !== a[i]) {
      return `#${i + 1} java="${e[i] ?? '␃'}" ts="${a[i] ?? '␃'}"`;
    }
  }
  return null;
}

const rows = runSweep();

describe('ADR-0010 golden commands (TS runner)', () => {
  it('fixtures 与 manifest 装载完整', () => {
    expect(cases.length).toBeGreaterThanOrEqual(40);
    for (const c of cases) {
      expect(manifestByCase.has(c.id)).toBe(true);
    }
  });

  it('身份函数用例 manifest 标记 L1-only', () => {
    for (const entry of manifest.cases) {
      if (entry.containsIdentityFn) {
        expect(entry.layers.l2).toBe(false);
      }
    }
  });

  it('L1 全量比对跑通并输出分叉报告（分叉=conformance 登记，不作断言失败）', () => {
    const lines = rows.map(
      (r) => `  [L1=${r.l1}][L2=${r.l2}${r.l2Asserted ? '*' : ''}] ${r.caseId}/${r.protocol}${r.detail ? ` — ${r.detail}` : ''}`,
    );
    const equal = rows.filter((r) => r.l1 === 'EQUAL').length;
    const diverge = rows.filter((r) => r.l1 === 'DIVERGE').length;
    const skip = rows.filter((r) => r.l1 === 'SKIP').length;
    const byteEqual = rows.filter((r) => r.l2 === 'equal' && !r.l2Asserted).map((r) => r.caseId);
    console.info(
      `[golden-ts] L1 报告: equal=${equal} diverge=${diverge} skip=${skip} total=${rows.length}\n${lines.join('\n')}` +
        `\n[golden-ts] 当前字节全等（未标绿，可经 tools/fixture-codegen --l2-green ts=... 收编）: ${byteEqual.join(',') || '无'}`,
    );
    expect(rows.length).toBeGreaterThan(0);
  });

  it('L2 仅在 manifest 绿格（l2Assert.ts）断言字节全等', () => {
    const green = rows.filter((r) => r.l2Asserted);
    for (const row of green) {
      expect(row.l2, `L2 字节分叉: ${row.caseId}/${row.protocol}`).toBe('equal');
    }
    console.info(`[golden-ts] L2 断言格数=${green.length}（绿格清单见 manifest l2Assert.ts）`);
  });

  it('帧序列化口径自检（内容字节转义与参照一致）', () => {
    // “货”=GBK BBAF；U+FFFD=EF BF BD（表外占位，ADR-0009）
    expect(escapeContent(Uint8Array.of(0xbb, 0xba, 0xef, 0xbf, 0xbd, 0x41))).toBe(
      '\\xBB\\xBA\\xEF\\xBF\\xBDA',
    );
    expect(asciiBytes('AB')).toHaveLength(2);
  });
});
