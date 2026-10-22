// SPDX-License-Identifier: Apache-2.0
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { DslValidator, FieldRegistry, type TemplateDSL } from '../src/index';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const fixturesDir = resolve(repoRoot, 'fixtures/templates');
const negativesDir = resolve(repoRoot, 'fixtures/negative');
const readJson = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8')) as unknown;

const schema = readJson(resolve(repoRoot, 'schema/v1.0.json')) as object;
const schemaV11 = readJson(resolve(repoRoot, 'schema/v1.1.json')) as object;
const schemaV2 = readJson(resolve(repoRoot, 'schema/v2.0.json')) as object;
const bizFiles = readdirSync(fixturesDir).filter((f: string) => f.endsWith('-v1.0.json'));
const bizFilesV11 = readdirSync(fixturesDir).filter((f: string) => f.endsWith('-v1.1.json'));
const bizFilesV2 = readdirSync(fixturesDir).filter((f: string) => f.endsWith('-v2.0.json'));
const allBizFiles = [...bizFiles, ...bizFilesV11, ...bizFilesV2];

// canonical sha256（与 tools/fixture-codegen.ts 同口径——T5：manifest.sha256 校验）
const sortKeysDeep = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(sortKeysDeep);
  if (v !== null && typeof v === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      sorted[k] = sortKeysDeep((v as Record<string, unknown>)[k]);
    }
    return sorted;
  }
  return v;
};
const canonicalSha256 = (v: unknown): string =>
  createHash('sha256').update(JSON.stringify(sortKeysDeep(v)), 'utf8').digest('hex');
const negativeFiles = readdirSync(negativesDir).filter((f: string) => f.endsWith('.invalid.json'));

const cloneSalesNote = (): TemplateDSL =>
  JSON.parse(readFileSync(resolve(fixturesDir, 'sales-note-v1.0.json'), 'utf8')) as TemplateDSL;

/** 替换 doc 呈现 body 首个元素的 content（注入测试表达式） */
function patchFirstBodyContent(dsl: TemplateDSL, content: string): string {
  const doc = (dsl.presentations as Record<string, { body: Array<Record<string, unknown>> }>).doc;
  doc.body[0].content = content;
  return 'presentations.doc.body[0].content';
}

describe('DslValidator.validate（JSON Schema draft 2020-12）', () => {
  it(`12 个业务 fixture 全部通过（当前 ${bizFiles.length} 个）`, () => {
    expect(bizFiles.length).toBeGreaterThanOrEqual(10);
    for (const file of bizFiles) {
      const result = DslValidator.validate(
        readJson(resolve(fixturesDir, file)) as TemplateDSL,
        schema,
      );
      expect(result.errors, file).toEqual([]);
      expect(result.valid, file).toBe(true);
    }
  });

  it(`v2.0 中国式报表 fixture 全部通过 schema（，当前 ${bizFilesV2.length} 个）`, () => {
    expect(bizFilesV2.length).toBeGreaterThanOrEqual(2);
    for (const file of bizFilesV2) {
      const result = DslValidator.validate(
        readJson(resolve(fixturesDir, file)) as TemplateDSL,
        schemaV2,
      );
      expect(result.errors, file).toEqual([]);
      expect(result.valid, file).toBe(true);
    }
  });

  it(`v1.1 label fixture 过 v1.1 schema（T1 收窄落稿；当前 ${bizFilesV11.length} 个）`, () => {
    expect(bizFilesV11.length).toBeGreaterThanOrEqual(1);
    for (const file of bizFilesV11) {
      const result = DslValidator.validate(
        readJson(resolve(fixturesDir, file)) as TemplateDSL,
        schemaV11,
      );
      expect(result.errors, file).toEqual([]);
    }
  });

  it('T5：manifest.sha256 与 fixture 本体 canonical hash 逐字一致（版本+hash 锚定）', () => {
    const manifest = readJson(
      resolve(dirname(fileURLToPath(import.meta.url)), 'generated/fixture-manifest.json'),
    ) as { bizFixtures: Array<{ file: string; sha256: string }> };
    expect(manifest.bizFixtures.length).toBeGreaterThan(0);
    for (const entry of manifest.bizFixtures) {
      const actual = canonicalSha256(readJson(resolve(fixturesDir, entry.file)));
      expect(actual, entry.file).toBe(entry.sha256);
    }
  });

  it('v2.0 fixture 不允许被 v1.0 schema 误收（schemaVersion pattern 分轨）', () => {
    for (const file of bizFilesV2) {
      const result = DslValidator.validate(
        readJson(resolve(fixturesDir, file)) as TemplateDSL,
        schema,
      );
      expect(result.valid, file).toBe(false);
    }
  });

  it(`全部负例被拒绝且错误带 path/code（当前 ${negativeFiles.length} 个）`, () => {
    expect(negativeFiles.length).toBeGreaterThanOrEqual(13);
    for (const file of negativeFiles) {
      // v2 负例按文件名路由到 v2.0 schema（与 tools/schema-lint 同口径）
      const targetSchema = file.includes('-v2') ? schemaV2 : schema;
      const result = DslValidator.validate(
        readJson(resolve(negativesDir, file)) as TemplateDSL,
        targetSchema,
      );
      expect(result.valid, file).toBe(false);
      expect(result.errors.length, file).toBeGreaterThan(0);
      for (const e of result.errors) {
        expect(e.path, file).toBeTruthy();
        expect(e.code, file).toBeTruthy();
        expect(e.message, file).toBeTruthy();
      }
    }
  });
});

describe('DslValidator.validateBusiness（字段绑定存在性 + 表达式文法）', () => {
  afterEach(() => FieldRegistry.clear());

  it('sales-note 全部表达式可解析（裸主源路径/源前缀/detail 聚合）', () => {
    expect(DslValidator.validateBusiness(cloneSalesNote()).valid).toBe(true);
  });

  // 全 fixture 业务校验门禁（v1.41 ExpressionCompiler 落地后债务清零）。
  // 历史债务锚点：payslip 应发合计算术式 {{baseSalary + bonus + overtime | currency:CNY}}
  // （presentations.doc.body[1].rows[0][3][1]）——四则运算承诺，
  // Phase 1 文法曾拒收、以 PHASE2_EXPRESSION_DEBT 台账锁定；编译器落地即解锁。
  // 台账保留为空清单：今后任何 fixture 出现新的业务校验失败必须显式入台账，防静默扩大。
  const EXPRESSION_DEBT_LEDGER: Array<{ file: string; path: string; code: string }> = [];

  it('全 fixture validateBusiness 门禁：全部表达式可编译且字段可解析（债务台账为空）', () => {
    const actual: Array<{ file: string; path: string; code: string }> = [];
    for (const file of allBizFiles) {
      const result = DslValidator.validateBusiness(
        readJson(resolve(fixturesDir, file)) as TemplateDSL,
      );
      for (const e of result.errors) {
        actual.push({ file, path: e.path, code: e.code });
      }
    }
    expect(actual).toEqual(EXPRESSION_DEBT_LEDGER);
  });

  it('parameters 运行时参数可被表达式引用（{{copies}}）', () => {
    const dsl = cloneSalesNote();
    patchFirstBodyContent(dsl, '打印份数：{{copies}} / 打印机：{{printer}}');
    expect(DslValidator.validateBusiness(dsl).valid).toBe(true);
  });

  it('未定义字段引用报 unknown-field 且定位到 JSON path', () => {
    const dsl = cloneSalesNote();
    const at = patchFirstBodyContent(dsl, '前缀 {{noSuchField}} 后缀');
    const result = DslValidator.validateBusiness(dsl);
    expect(result.valid).toBe(false);
    const err = result.errors.find((e) => e.code === 'unknown-field');
    expect(err).toBeDefined();
    expect(err?.path).toBe(at);
    expect(err?.message).toContain('noSuchField');
  });

  it('非法字段引用文法报 bad-expression', () => {
    const dsl = cloneSalesNote();
    patchFirstBodyContent(dsl, '{{1abc}}');
    const result = DslValidator.validateBusiness(dsl);
    expect(result.errors.map((e) => e.code)).toContain('bad-expression');
  });

  it('数组索引引用合法（v1.41 文法扩展，items[0].sku）；通配符 [*] 仍拒绝', () => {
    const dsl = cloneSalesNote();
    patchFirstBodyContent(dsl, '{{items[0].sku}}');
    expect(DslValidator.validateBusiness(dsl).valid).toBe(true);
    const wildcard = cloneSalesNote();
    patchFirstBodyContent(wildcard, '{{items[*].sku}}');
    const result = DslValidator.validateBusiness(wildcard);
    expect(result.errors.map((e) => e.code)).toContain('bad-expression');
  });

  it('A3：多数据源同名裸路径报 ambiguous-field，源前缀可消歧', () => {
    const dsl = {
      schemaVersion: '1.0',
      id: 'test_ambiguous',
      code: 'TEST_AMBIGUOUS',
      name: '多源歧义',
      dataSources: [
        { name: 'customer', type: 'primary', schema: { name: 'string' } },
        { name: 'store', type: 'primary', schema: { name: 'string' } },
      ],
      presentations: { doc: { body: [{ type: 'text', content: '{{name}}' }] } },
    } as unknown as TemplateDSL;
    const result = DslValidator.validateBusiness(dsl);
    expect(result.valid).toBe(false);
    expect(result.errors[0].code).toBe('ambiguous-field');
    const doc = (dsl.presentations as Record<string, { body: Array<Record<string, unknown>> }>).doc;
    doc.body[0].content = '{{customer.name}}';
    expect(DslValidator.validateBusiness(dsl).valid).toBe(true);
  });

  it('FieldRegistry 注册的 bizType 字段可作为兜底字典（bizType = dsl.code）', () => {
    const dsl = cloneSalesNote();
    patchFirstBodyContent(dsl, '{{extField}}');
    expect(DslValidator.validateBusiness(dsl).valid).toBe(false);
    FieldRegistry.register('SALES_NOTE', [
      { code: 'extField', name: '扩展字段', dataType: 'string' },
    ]);
    expect(DslValidator.validateBusiness(dsl).valid).toBe(true);
  });
});

describe('DSL 2.0 cross-path 业务规则', () => {
  const v2Dsl = (table: Record<string, unknown>): TemplateDSL =>
    ({
      schemaVersion: '2.0',
      id: 'v2_shape_test',
      code: 'TEST_V2_SHAPE',
      name: 'v2 结构校验',
      dataSources: [
        { name: 'main', type: 'primary', schema: { billNo: 'string' } },
        { name: 'items', type: 'detail', schema: { sku: 'string', qty: 'number' } },
      ],
      presentations: { doc: { body: [table] } },
    }) as unknown as TemplateDSL;

  const codesOf = (dsl: TemplateDSL): string[] =>
    DslValidator.validateBusiness(dsl).errors.map((e) => e.code);

  it('表头网格 colspan 越界报 header-cell-span-mismatch（含 JSON path）', () => {
    const dsl = v2Dsl({
      type: 'table',
      source: 'items',
      columns: [
        { header: 'A', field: 'sku' },
        { header: 'B', field: 'qty' },
      ],
      headerRows: [[{ text: 'A', colspan: 99 }]],
    });
    const result = DslValidator.validateBusiness(dsl);
    expect(result.errors.map((e) => e.code)).toContain('header-cell-span-mismatch');
    expect(result.errors[0].path).toBe('presentations.doc.body[0].headerRows[0]');
  });

  it('表头 rowspan 越界/行未填满同样拒绝；合法网格（含 rowspan 占位）通过', () => {
    const overflow = v2Dsl({
      type: 'table',
      columns: [
        { header: 'A', field: 'sku' },
        { header: 'B', field: 'qty' },
      ],
      headerRows: [[{ text: 'A', rowspan: 2 }, { text: 'B' }]],
    });
    expect(codesOf(overflow)).toContain('header-cell-span-mismatch');

    const underfilled = v2Dsl({
      type: 'table',
      columns: [
        { header: 'A', field: 'sku' },
        { header: 'B', field: 'qty' },
      ],
      headerRows: [[{ text: 'A' }]],
    });
    expect(codesOf(underfilled)).toContain('header-cell-span-mismatch');

    const ok = v2Dsl({
      type: 'table',
      columns: [
        { header: 'A', field: 'sku' },
        { header: 'B', field: 'qty' },
        { header: 'C', field: 'qty' },
      ],
      headerRows: [
        [
          { text: '左', rowspan: 2 },
          { text: '右组', colspan: 2 },
        ],
        [{ text: 'B' }, { text: 'C' }],
      ],
    });
    expect(codesOf(ok)).toEqual([]);
  });

  it('分组小计 values 长度 ≠ 列数报 subtotal-values-length', () => {
    const dsl = v2Dsl({
      type: 'table',
      columns: [
        { header: 'A', field: 'sku' },
        { header: 'B', field: 'qty' },
      ],
      groups: [{ field: 'sku', subtotal: { values: [null] } }],
    });
    const result = DslValidator.validateBusiness(dsl);
    expect(result.errors.map((e) => e.code)).toContain('subtotal-values-length');
    expect(result.errors[0].path).toBe('presentations.doc.body[0].groups[0].subtotal.values');
  });

  it('staticRows 行 colspan 合计 ≠ 列数报 static-row-span-mismatch', () => {
    const dsl = v2Dsl({
      type: 'table',
      columns: [
        { header: 'A', field: 'sku' },
        { header: 'B', field: 'qty' },
      ],
      staticRows: { position: 'after', rows: [[{ value: '签栏', colspan: 3 }]] },
    });
    expect(codesOf(dsl)).toContain('static-row-span-mismatch');
  });

  it('staticRows rowspan 超出行数报 static-row-span-mismatch', () => {
    const dsl = v2Dsl({
      type: 'table',
      columns: [
        { header: 'A', field: 'sku' },
        { header: 'B', field: 'qty' },
      ],
      staticRows: {
        position: 'after',
        rows: [[{ value: '纵向合并溢出', colspan: 2, rowspan: 2 }]],
      },
    });
    const result = DslValidator.validateBusiness(dsl);
    expect(result.errors.map((e) => e.code)).toContain('static-row-span-mismatch');
    expect(result.errors[0].path).toBe('presentations.doc.body[0].staticRows.rows[0]');
  });

  it('table.source 未定义于 dataSources 报 table-source-unknown', () => {
    expect(
      codesOf(v2Dsl({ type: 'table', source: 'ghost', columns: [{ header: 'A', field: 'sku' }] })),
    ).toContain('table-source-unknown');
    expect(
      codesOf(v2Dsl({ type: 'table', source: 'items', columns: [{ header: 'A', field: 'sku' }] })),
    ).toEqual([]);
  });

  it('loop.each 必须引用 detail 源（primary/未定义均拒）', () => {
    expect(codesOf(v2Dsl({ type: 'loop', each: 'main', body: [] }))).toContain(
      'loop-each-not-detail',
    );
    expect(codesOf(v2Dsl({ type: 'loop', each: 'ghost', body: [] }))).toContain(
      'loop-each-not-detail',
    );
    expect(codesOf(v2Dsl({ type: 'loop', each: 'items', body: [] }))).toEqual([]);
  });

  it('subtable.source 必须引用 detail 源（嵌套子表递归同校）', () => {
    const dsl = v2Dsl({
      type: 'table',
      columns: [
        {
          header: '嵌套',
          subtable: {
            source: 'items',
            columns: [{ header: '错', subtable: { source: 'main', columns: [] } }],
          },
        },
      ],
    });
    const result = DslValidator.validateBusiness(dsl);
    expect(result.errors.map((e) => e.code)).toContain('subtable-source-not-detail');
    expect(result.errors[0].path).toBe(
      'presentations.doc.body[0].columns[0].subtable.columns[0].subtable.source',
    );
  });

  it('v1 单据（无 v2 元素）不受 cross-path 规则影响', () => {
    expect(DslValidator.validateBusiness(cloneSalesNote()).valid).toBe(true);
  });
});

describe('FieldRegistry（register/lookup 语义）', () => {
  afterEach(() => FieldRegistry.clear());

  it('lookup 未注册 bizType 返回空数组；注册后可查', () => {
    expect(FieldRegistry.lookup('NOPE')).toEqual([]);
    FieldRegistry.register('SALES_NOTE', [{ code: 'billNo', name: '单号', dataType: 'string' }]);
    expect(FieldRegistry.lookup('SALES_NOTE')).toEqual([
      { code: 'billNo', name: '单号', dataType: 'string' },
    ]);
  });

  it('注册/查询均为防御性拷贝，外部篡改不影响字典', () => {
    const fields = [{ code: 'a', name: 'A', dataType: 'string' }];
    FieldRegistry.register('BIZ', fields);
    fields[0].code = 'hacked';
    FieldRegistry.lookup('BIZ')[0].name = 'hacked';
    expect(FieldRegistry.lookup('BIZ')).toEqual([{ code: 'a', name: 'A', dataType: 'string' }]);
  });

  it('重复注册覆写；非法入参显式抛错', () => {
    FieldRegistry.register('BIZ', [{ code: 'a', name: 'A', dataType: 'string' }]);
    FieldRegistry.register('BIZ', [{ code: 'b', name: 'B', dataType: 'number' }]);
    expect(FieldRegistry.lookup('BIZ').map((f) => f.code)).toEqual(['b']);
    expect(() => FieldRegistry.register('', [])).toThrow(TypeError);
    expect(() => FieldRegistry.register('BIZ', 'x' as never)).toThrow(TypeError);
  });
});
