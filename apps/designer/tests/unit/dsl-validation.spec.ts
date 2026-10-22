// SPDX-License-Identifier: Apache-2.0
// 专项步骤 4（块 A）：DSL 内核校验接线——validateTemplate 聚合 schema + 业务规则，
// 6 个 v2 相关错误码逐一构造断言（code + JSON path），prepareSave 门禁拦截。
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useDesignerStore, type TemplateLike } from '../../src/canvas/store';
import { errorsForPath, validateTemplate, V2_ERROR_HINTS } from '../../src/shared/dsl';
import type { ValidationError } from 'taprint';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const readFixture = (rel: string): TemplateLike =>
  JSON.parse(readFileSync(resolve(repoRoot, rel), 'utf8')) as TemplateLike;

const inventory = (): TemplateLike => readFixture('fixtures/templates/inventory-report-v2.0.json');
const coupon = (): TemplateLike => readFixture('fixtures/templates/coupon-sheet-v2.0.json');
const salesNote = (): TemplateLike => readFixture('fixtures/templates/sales-note-v1.0.json');

/** 测试侧可变视图：仅覆盖本文件改动用到的字段 */
type MutableTable = {
  source?: string;
  headerRows: Array<Array<{ colspan?: number; rowspan?: number }>>;
  groups: Array<{ subtotal: { values: unknown[] } }>;
  staticRows: { rows: Array<Array<{ colspan?: number }>> };
  columns: Array<{ subtable: { source?: string } }>;
};

/** body[1] 为 8 列 table（范例锚点） */
const tableOf = (dsl: TemplateLike): MutableTable =>
  (dsl.presentations.doc as { body: unknown[] }).body[1] as MutableTable;

describe('validateTemplate（fixture 零错误基线）', () => {
  it('两个 v2 fixture 与 v1 fixture 均零错误', () => {
    expect(validateTemplate(inventory() as never).valid).toBe(true);
    expect(validateTemplate(coupon() as never).valid).toBe(true);
    expect(validateTemplate(salesNote() as never).valid).toBe(true);
  });
});

describe('validateTemplate（v2 cross-path 错误码逐一构造）', () => {
  it('header-cell-span-mismatch：表头 colspan 越界/重叠', () => {
    const dsl = inventory();
    tableOf(dsl).headerRows[0][1].colspan = 4; // 与相邻单元格重叠
    const { errors } = validateTemplate(dsl as never);
    expect(errors.some((e: ValidationError) => e.code === 'header-cell-span-mismatch')).toBe(true);
    expect(
      errors.find((e: ValidationError) => e.code === 'header-cell-span-mismatch')?.path,
    ).toContain('.headerRows[0]');
  });

  it('subtotal-values-length：小计 values 与列数错位', () => {
    const dsl = inventory();
    tableOf(dsl).groups[0].subtotal.values.pop();
    const { errors } = validateTemplate(dsl as never);
    expect(
      errors.some(
        (e: ValidationError) =>
          e.code === 'subtotal-values-length' && e.path.includes('.groups[0].subtotal.values'),
      ),
    ).toBe(true);
  });

  it('static-row-span-mismatch：自由行 colspan 合计 ≠ 列数', () => {
    const dsl = inventory();
    tableOf(dsl).staticRows.rows[0][0].colspan = 4; // 合计 9 ≠ 8
    const { errors } = validateTemplate(dsl as never);
    expect(
      errors.some(
        (e: ValidationError) =>
          e.code === 'static-row-span-mismatch' && e.path.includes('.staticRows.rows[0]'),
      ),
    ).toBe(true);
  });

  it('loop-each-not-detail：loop.each 指 primary 源', () => {
    const dsl = inventory();
    (dsl.presentations.doc as { body: Array<{ each?: string }> }).body[3].each = 'main';
    const { errors } = validateTemplate(dsl as never);
    expect(
      errors.some(
        (e: ValidationError) => e.code === 'loop-each-not-detail' && e.path.endsWith('.each'),
      ),
    ).toBe(true);
  });

  it('subtable-source-not-detail：subtable.source 指 primary 源', () => {
    const dsl = inventory();
    tableOf(dsl).columns[7].subtable.source = 'main';
    const { errors } = validateTemplate(dsl as never);
    expect(
      errors.some(
        (e: ValidationError) =>
          e.code === 'subtable-source-not-detail' && e.path.includes('.columns[7].subtable'),
      ),
    ).toBe(true);
  });

  it('table-source-unknown：table.source 拼错', () => {
    const dsl = inventory();
    tableOf(dsl).source = 'nope';
    const { errors } = validateTemplate(dsl as never);
    expect(
      errors.some(
        (e: ValidationError) => e.code === 'table-source-unknown' && e.path.endsWith('.source'),
      ),
    ).toBe(true);
  });

  it('errorsForPath 前缀过滤 + V2_ERROR_HINTS 覆盖 6 码', () => {
    const dsl = inventory();
    tableOf(dsl).groups[0].subtotal.values.pop();
    const { errors } = validateTemplate(dsl as never);
    const prefix = 'presentations.doc.body[1]';
    expect(errorsForPath(errors, prefix).length).toBeGreaterThan(0);
    expect(errorsForPath(errors, 'presentations.doc.body[9]')).toHaveLength(0);
    // 边界感知：body[1] 前缀不得误匹配 body[10+]
    const sibling: ValidationError = {
      code: 'x',
      message: '',
      path: 'presentations.doc.body[10].headerRows[0]',
    };
    expect(errorsForPath([sibling], prefix)).toHaveLength(0);
    for (const code of [
      'header-cell-span-mismatch',
      'subtotal-values-length',
      'static-row-span-mismatch',
      'loop-each-not-detail',
      'subtable-source-not-detail',
      'table-source-unknown',
    ]) {
      expect(V2_ERROR_HINTS[code]).toBeTruthy();
    }
  });
});

describe('prepareSave（保存门禁）', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('合法模板放行；制造 cross-path 错误后拦截', () => {
    const store = useDesignerStore();
    store.loadTemplate(inventory());
    expect(store.prepareSave().ok).toBe(true);

    store.select(1); // table 元素
    const broken = JSON.parse(JSON.stringify(store.selectedElement)) as {
      staticRows: { rows: Array<Array<{ colspan?: number }>> };
    };
    broken.staticRows.rows[0][0].colspan = 4;
    store.updateSelected(broken);
    const result = store.prepareSave();
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.code === 'static-row-span-mismatch')).toBe(true);
  });
});
