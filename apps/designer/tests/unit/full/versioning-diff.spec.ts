// SPDX-License-Identifier: Apache-2.0
// versioning diff.ts 纯函数单测：相等短路/新增键/删除键/值变更/数组长度变化。
// 期望值来自真实运行（先构造最小 DSL 对象，断言实际输出，禁止凭空写快照）。
import { describe, expect, it } from 'vitest';
import { DslParser } from 'taprint';
import { diffDsl } from '../../../src/full/versioning/diff';

const base = {
  schemaVersion: '2.0',
  id: 'tpl-1',
  code: 'T1',
  name: '模板一',
  dataSources: [{ name: 'main', type: 'primary', schema: { billNo: 'string' } }],
  presentations: {
    doc: {
      page: { size: 'A4' },
      body: [{ type: 'text', content: '{{billNo}}' }],
    },
  },
};

describe('diffDsl（字段级版本差异纯函数）', () => {
  it('dslHash 相等 → equal=true 且 changes 为空（第一道判定短路）', () => {
    const clone = JSON.parse(JSON.stringify(base)) as typeof base;
    const result = diffDsl(base, clone);
    expect(result.equal).toBe(true);
    expect(result.changes).toEqual([]);
    // 键顺序无关：插入顺序不同但内容相同仍判相等（stringify 全深度字典序）
    const reordered = {
      presentations: base.presentations,
      name: base.name,
      schemaVersion: base.schemaVersion,
      code: base.code,
      id: base.id,
      dataSources: base.dataSources,
    };
    expect(DslParser.hash(reordered as never)).toBe(DslParser.hash(base as never));
    expect(diffDsl(base, reordered).equal).toBe(true);
  });

  it('新增顶层键 → added 且给出规范化新值', () => {
    const after = { ...base, description: '新增描述' };
    const result = diffDsl(base, after);
    expect(result.equal).toBe(false);
    expect(result.changes).toEqual([{ path: 'description', state: 'added', after: '"新增描述"' }]);
  });

  it('删除嵌套键 → removed 且给出规范化原值', () => {
    const after = JSON.parse(JSON.stringify(base)) as typeof base;
    delete (after.presentations.doc.page as Record<string, unknown>).size;
    const result = diffDsl(base, after);
    expect(result.equal).toBe(false);
    expect(result.changes).toEqual([
      { path: 'presentations.doc.page.size', state: 'removed', before: '"A4"' },
    ]);
  });

  it('标量值变更 → modified，表达式文本差异逐字展示', () => {
    const after = JSON.parse(JSON.stringify(base)) as typeof base;
    (after.presentations.doc.body[0] as { content: string }).content = "{{billNo | default:'-'}}";
    const result = diffDsl(base, after);
    expect(result.equal).toBe(false);
    const change = result.changes.find((c) => c.path === 'presentations.doc.body[0].content');
    expect(change?.state).toBe('modified');
    expect(change?.before).toBe('"{{billNo}}"');
    expect(change?.after).toBe('"{{billNo | default:\'-\'}}"');
  });

  it('数组长度变化 → 数组路径追加 modified（before/after = 长度）且公共下标逐元素对比', () => {
    const after = JSON.parse(JSON.stringify(base)) as typeof base;
    (after.presentations.doc.body as unknown[]).push({ type: 'text', content: '第二段' });
    const result = diffDsl(base, after);
    expect(result.equal).toBe(false);
    expect(result.changes).toContainEqual({
      path: 'presentations.doc.body',
      state: 'modified',
      before: '1',
      after: '2',
    });
  });

  it('数组公共下标内元素变更 → 定位到 [i] 路径', () => {
    const after = JSON.parse(JSON.stringify(base)) as typeof base;
    (after.presentations.doc.body[0] as { content: string }).content = '改过';
    const result = diffDsl(base, after);
    const change = result.changes.find((c) => c.path === 'presentations.doc.body[0].content');
    expect(change?.state).toBe('modified');
    expect(change?.after).toBe('"改过"');
  });

  it('类型不同的节点 → modified（规范化串不等）', () => {
    const a = { key: 'text' };
    const b = { key: { nested: true } };
    const result = diffDsl(a, b);
    expect(result.changes).toEqual([
      { path: 'key', state: 'modified', before: '"text"', after: '{"nested":true}' },
    ]);
  });
});
