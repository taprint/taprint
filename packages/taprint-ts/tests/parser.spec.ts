// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DslParser, type TemplateDSL } from '../src/index';

// parse-result 锚点：fixture → parseResult 与 expected-output 逐字一致
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const readJson = (rel: string): unknown =>
  JSON.parse(readFileSync(resolve(repoRoot, rel), 'utf8')) as unknown;

const salesNote = () => readJson('fixtures/templates/sales-note-v1.0.json') as TemplateDSL;
const schema = () => readJson('schema/v1.0.json') as object;

describe('DslParser.parse（Phase 1-A）', () => {
  it('解析业务 fixture 且保留全部顶层字段', () => {
    const dsl = DslParser.parse(
      readFileSync(resolve(repoRoot, 'fixtures/templates/sales-note-v1.0.json'), 'utf8'),
    );
    expect(dsl.code).toBe('SALES_NOTE');
    expect(dsl.schemaVersion).toBe('1.0');
    expect(Array.isArray(dsl.dataSources)).toBe(true);
  });

  it('容忍 BOM 前缀', () => {
    const dsl = DslParser.parse('\uFEFF{"schemaVersion":"1.0"}');
    expect(dsl.schemaVersion).toBe('1.0');
  });

  it('非法 JSON 抛 SyntaxError，非对象顶层抛 TypeError', () => {
    expect(() => DslParser.parse('{oops')).toThrow(SyntaxError);
    expect(() => DslParser.parse('[1,2]')).toThrow(TypeError);
    expect(() => DslParser.parse('null')).toThrow(TypeError);
    expect(() => DslParser.parse('"str"')).toThrow(TypeError);
    expect(() => DslParser.parse(42 as unknown as string)).toThrow(TypeError);
  });
});

describe('DslParser.stringify / hash（规范化口径锁定）', () => {
  it('stringify 与 key 插入顺序无关（全深度 key 字典序）', () => {
    const a = { b: 1, a: { d: 2, c: [{ f: 4, e: 5 }] } } as unknown as TemplateDSL;
    const b = { a: { c: [{ e: 5, f: 4 }], d: 2 }, b: 1 } as unknown as TemplateDSL;
    expect(DslParser.stringify(a)).toBe(DslParser.stringify(b));
    expect(DslParser.stringify(a)).toBe('{"a":{"c":[{"e":5,"f":4}],"d":2},"b":1}');
  });

  it('stringify 拒绝循环引用（TypeError 而非栈溢出）', () => {
    const cyclic = {} as Record<string, unknown>;
    cyclic.self = cyclic;
    expect(() => DslParser.stringify(cyclic as TemplateDSL)).toThrow('循环引用');
  });

  it('hash 形如 sha256:<64 hex>，确定性且与 node:crypto 独立复算一致', () => {
    const dsl = salesNote();
    const hash = DslParser.hash(dsl);
    expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(DslParser.hash(dsl)).toBe(hash);
    const independent = `sha256:${createHash('sha256')
      .update(DslParser.stringify(dsl), 'utf8')
      .digest('hex')}`;
    expect(hash).toBe(independent);
  });

  it('内容不同 hash 必不同', () => {
    const dsl = salesNote();
    const altered = JSON.parse(JSON.stringify(dsl)) as TemplateDSL;
    altered.name = `${String(altered.name)}-改`;
    expect(DslParser.hash(altered)).not.toBe(DslParser.hash(dsl));
  });
});

describe('DslParser.parseResult（expected-output 锁定）', () => {
  it('sales-note 与 expected-output 逐字一致', () => {
    const expected = readJson('fixtures/expected/parse-results/sales-note-parse-result.json');
    expect(DslParser.parseResult(salesNote(), schema())).toEqual(expected);
  });

  it('fieldPaths 覆盖主源裸路径与 detail 行路径（items[*].*）', () => {
    const { fieldPaths } = DslParser.parseResult(salesNote(), schema());
    expect(fieldPaths).toContain('billNo');
    expect(fieldPaths).toContain('customer.name');
    expect(fieldPaths).toContain('items[*].sku');
    expect([...fieldPaths].sort()).toEqual(fieldPaths); // 字典序锁定
  });

  it('schema 违反时 valid=false 且其余字段仍产出', () => {
    const broken = salesNote();
    delete (broken as Record<string, unknown>).id;
    const result = DslParser.parseResult(broken, schema());
    expect(result.valid).toBe(false);
    expect(result.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(result.expressionCount).toBeGreaterThan(0);
  });
});

// 专项步骤 4：parse-result 锚点从 v1.0 扩到 DSL 2.0 全能力（同模式，
// schema-lint 独立复算 hash 逐字比对）
describe('DslParser.parseResult（v2.0 expected-output 锁定，专项步骤 4）', () => {
  const schemaV2 = () => readJson('schema/v2.0.json') as object;

  it.each([
    ['inventory-report-v2.0.json', 'inventory-report-parse-result.json'],
    ['coupon-sheet-v2.0.json', 'coupon-sheet-parse-result.json'],
  ])('%s 与 expected-output 逐字一致', (fixtureFile, expectedFile) => {
    const dsl = readJson(`fixtures/templates/${fixtureFile}`) as TemplateDSL;
    const expected = readJson(`fixtures/expected/parse-results/${expectedFile}`);
    expect(DslParser.parseResult(dsl, schemaV2())).toEqual(expected);
  });
});
