// SPDX-License-Identifier: Apache-2.0
// 模板域地基 smoke 测试（首个基础 commit 配套，Acceptance）。
// 目的：验证 MemoryTemplateRepository 关键方法可调通、签名匹配模板 API 契约，让 /拉分支时
// 有绿测兜底。详细用例（删除守卫/单调版本/指针式 rollback/duplicate 血缘/lineage 链）由
// 完整单测覆盖；本 smoke 只锚定基础语义，避免重复维护。
import { beforeEach, describe, expect, it } from 'vitest';
import {
  MemoryTemplateRepository,
  RollbackTargetInvalidError,
  TemplateHasDescendantsError,
  TemplateNotFoundError,
  TemplateNoChangesError,
  buildSeedTemplates,
  buildSeedVersions,
} from '../../src/template-domain';

describe('template-domain 地基 smoke（首 commit）', () => {
  let repo: MemoryTemplateRepository;

  beforeEach(() => {
    repo = new MemoryTemplateRepository(buildSeedTemplates(), buildSeedVersions());
  });

  it('seed 注入 3 模板 + sales-note 预置 v1 版本历史', async () => {
    const list = await repo.list();
    expect(list).toHaveLength(3);
    expect(list.map((t) => t.id).sort()).toEqual([1, 2, 3]);
    const salesNote = await repo.get(1);
    expect(salesNote?.currentVersion).toBe(1);
    const versions = await repo.getVersions(1);
    expect(versions).toHaveLength(1);
    expect(versions[0].version).toBe(1);
    expect(versions[0].status).toBe('published');
  });

  it('CRUD 基础链路：create → get → rename → save → list 排序', async () => {
    const created = await repo.create({ name: '新模板', deviceClass: 'receipt' });
    expect(created.id).toBeGreaterThanOrEqual(4);
    expect(created.status).toBe('draft');
    expect(created.currentVersion).toBeNull();

    const got = await repo.get(created.id);
    expect(got?.name).toBe('新模板');

    const renamed = await repo.rename(created.id, '改名后');
    expect(renamed.name).toBe('改名后');

    const saved = await repo.save(created.id, {
      ...created.dsl,
      name: '改名后',
    });
    expect(saved.updatedAt).toBeGreaterThanOrEqual(created.updatedAt);

    const list = await repo.list();
    // updatedAt 倒序：刚操作的模板在前
    expect(list[0].id).toBe(created.id);
  });

  it('duplicate 生成血缘副本：sourceTemplateId/sourceVersion 字段锚定', async () => {
    const dup = await repo.duplicate(1, { name: '销售单-实验副本' });
    expect(dup.sourceTemplateId).toBe(1);
    expect(dup.sourceVersion).toBe(1); // 销售单当前 currentVersion=1
    expect(dup.currentVersion).toBeNull(); // 副本独立，初始未发布
    expect(dup.name).toBe('销售单-实验副本');
  });

  it('publish 单调版本号 + currentVersion 移动；rollback 指针式不新增版本行', async () => {
    // 第一条 publish 应幂等防护（草稿与 v1 hash 相同）
    await expect(repo.publish(1, '重复发布')).rejects.toBeInstanceOf(TemplateNoChangesError);
    // 改草稿后发布 → 新版本 v2
    const t1 = (await repo.get(1))!;
    t1.dsl.name = '销售单-改';
    await repo.save(1, t1.dsl);
    const published = await repo.publish(1, '第二次发布');
    expect(published.currentVersion).toBe(2);
    const versions = await repo.getVersions(1);
    expect(versions.map((v) => v.version)).toEqual([1, 2]);

    // rollback 指针式：移回 v1，版本条目不变（不新增）
    const rolled = await repo.rollback(1, 1);
    expect(rolled.currentVersion).toBe(1);
    const versionsAfter = await repo.getVersions(1);
    expect(versionsAfter.map((v) => v.version)).toEqual([1, 2]); // 仍 [1,2]，未新增
    expect(versionsAfter).toHaveLength(2);
  });

  it('rollback 仅 published 可回滚；草稿/不存在版本抛错', async () => {
    // 不存在版本
    await expect(repo.rollback(1, 999)).rejects.toBeInstanceOf(RollbackTargetInvalidError);
  });

  it('删除守卫：有后代的模板禁删（coupon-sheet 是 sales-note 的后代）', async () => {
    await expect(repo.remove(1)).rejects.toBeInstanceOf(TemplateHasDescendantsError);
    // 无后代的模板可删
    await repo.remove(2);
    await expect(repo.get(2)).resolves.toBeNull();
    // 删除不存在的模板
    await expect(repo.remove(999)).rejects.toBeInstanceOf(TemplateNotFoundError);
  });

  it('getLineage：ancestors 链上溯 + descendants 下探', async () => {
    const lineage = await repo.getLineage(3);
    // coupon-sheet 的祖先是 sales-note (id=1)
    expect(lineage.ancestors.map((a) => a.id)).toEqual([1]);
    // sales-note 的后代包含 coupon-sheet
    const salesLineage = await repo.getLineage(1);
    expect(salesLineage.descendants.map((d) => d.id)).toContain(3);
  });
});
