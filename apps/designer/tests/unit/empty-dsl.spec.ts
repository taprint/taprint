// SPDX-License-Identifier: Apache-2.0
// 空模板骨架守卫（2026-10-12 生产实测：后端 TemplateDslValidator 拒收
// `tpl-<ts>` 连字符 id / 中文名 code / 空 body——本守卫把三格式锁死）。
import { describe, expect, it } from 'vitest';
import { emptyDsl } from '../../src/template-domain/memory-repository';

const ID_RE = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;
const CODE_RE = /^[A-Z][A-Z0-9_]{1,31}$/;

describe('emptyDsl 骨架格式（后端校验闸对齐）', () => {
  it('receipt：id/code 过后端正则，body 非空且首元素为 text', () => {
    const dsl = emptyDsl('购物清单（草稿）副本', 'receipt') as Record<string, unknown>;
    expect(String(dsl.id)).toMatch(ID_RE);
    expect(String(dsl.code)).toMatch(CODE_RE);
    const presentations = dsl.presentations as Record<string, { body: Array<{ type: string }> }>;
    expect(presentations.receipt.body.length).toBeGreaterThan(0);
    expect(presentations.receipt.body[0].type).toBe('text');
  });

  it('label：body 非空且首元素带 x/y（validator 强制坐标）', () => {
    const dsl = emptyDsl('价签', 'label') as Record<string, unknown>;
    const presentations = dsl.presentations as Record<
      string,
      { body: Array<{ type: string; x: string; y: string }> }
    >;
    expect(presentations.label.body.length).toBeGreaterThan(0);
    expect(presentations.label.body[0].x).toBeTruthy();
    expect(presentations.label.body[0].y).toBeTruthy();
  });

  it('doc：body 非空', () => {
    const dsl = emptyDsl('送货单', 'doc') as Record<string, unknown>;
    const presentations = dsl.presentations as Record<string, { body: unknown[] }>;
    expect(presentations.doc.body.length).toBeGreaterThan(0);
  });

  it('id/code 毫秒级唯一（两次生成不撞）', () => {
    const a = emptyDsl('A', 'receipt') as Record<string, unknown>;
    const b = emptyDsl('A', 'receipt') as Record<string, unknown>;
    expect(a.id).not.toBe(b.id);
    expect(a.code).not.toBe(b.code);
  });
});
