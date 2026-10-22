// SPDX-License-Identifier: Apache-2.0
// MemoryTemplateRepository 完整方法单测。
// smoke 7 例已覆盖基础语义，本 spec 补全边界与契约细节：
// - CRUD 边界（rename/get 不存在/create 自分配 id/save 不动版本字段）
// - 删除守卫（有后代禁删 + 无后代可删）
// - duplicate 血缘（sourceTemplateId/sourceVersion 锚定、name 缺省、深拷贝独立演化）
// - publish 单调版本号（多次发布版本递增）+ changeNote 必填 + 幂等防护
// - rollback 指针式（仅 published、不产生新版本行、草稿/draft 拒绝、不存在版本拒绝、回滚后草稿与目标版本一致）
// - lineage 多级祖先 + 多级后代
// - getSharedRepository 单例 + resetSharedRepository 测试隔离
import { beforeEach, describe, expect, it } from 'vitest';
import {
  MemoryTemplateRepository,
  RollbackTargetInvalidError,
  TemplateHasDescendantsError,
  TemplateNotFoundError,
  TemplateNoChangesError,
  buildSeedTemplates,
  buildSeedVersions,
  getSharedRepository,
  resetSharedRepository,
  setSharedRepository,
  type TemplateRepository,
} from '../../src/template-domain';

describe('MemoryTemplateRepository CRUD 边界', () => {
  let repo: MemoryTemplateRepository;
  beforeEach(() => {
    repo = new MemoryTemplateRepository(buildSeedTemplates(), buildSeedVersions());
  });

  it('rename/get/save 不存在 id 抛 TemplateNotFoundError', async () => {
    await expect(repo.rename(999, 'x')).rejects.toBeInstanceOf(TemplateNotFoundError);
    await expect(repo.save(999, { schemaVersion: '2.0' } as never)).rejects.toBeInstanceOf(
      TemplateNotFoundError,
    );
    await expect(repo.get(999)).resolves.toBeNull();
    await expect(repo.getVersions(999)).rejects.toBeInstanceOf(TemplateNotFoundError);
    await expect(repo.duplicate(999)).rejects.toBeInstanceOf(TemplateNotFoundError);
    await expect(repo.publish(999, 'x')).rejects.toBeInstanceOf(TemplateNotFoundError);
    await expect(repo.rollback(999, 1)).rejects.toBeInstanceOf(TemplateNotFoundError);
    await expect(repo.getLineage(999)).rejects.toBeInstanceOf(TemplateNotFoundError);
  });

  it('create 多次：id 单调递增 + 状态/时间戳/currentVersion 初始值正确', async () => {
    const a = await repo.create({ name: 'A', deviceClass: 'receipt' });
    const b = await repo.create({ name: 'B', deviceClass: 'label' });
    expect(b.id).toBeGreaterThan(a.id);
    expect(a.status).toBe('draft');
    expect(a.currentVersion).toBeNull();
    expect(a.sourceTemplateId).toBeNull();
    expect(a.sourceVersion).toBeNull();
    expect(a.createdAt).toBeGreaterThan(0);
    expect(a.updatedAt).toBe(a.createdAt);
  });

  it('create 不传 dsl 时生成空骨架（按 deviceClass 含对应呈现；body 至少一行占位 text，空数组会被 validator 拒绝）', async () => {
    const receipt = await repo.create({ name: 'r', deviceClass: 'receipt' });
    expect(receipt.dsl.presentations?.receipt).toBeDefined();
    expect(receipt.dsl.presentations?.receipt?.body).toEqual([{ type: 'text', content: 'r' }]);
    const label = await repo.create({ name: 'l', deviceClass: 'label' });
    expect(label.dsl.presentations?.label).toBeDefined();
    expect(label.dsl.presentations?.label?.body).toEqual([
      { type: 'text', content: 'l', x: '0mm', y: '0mm' },
    ]);
    const doc = await repo.create({ name: 'd', deviceClass: 'doc' });
    expect(doc.dsl.presentations?.doc).toBeDefined();
    expect(doc.dsl.presentations?.doc?.body).toEqual([{ type: 'text', content: 'd' }]);
  });

  it('rename 仅更新 name + updatedAt，其他字段不动（血缘/版本/dsl）', async () => {
    const before = (await repo.get(1))!;
    const renamed = await repo.rename(1, '销售单-改名');
    expect(renamed.name).toBe('销售单-改名');
    expect(renamed.updatedAt).toBeGreaterThanOrEqual(before.updatedAt);
    expect(renamed.currentVersion).toBe(before.currentVersion);
    expect(renamed.sourceTemplateId).toBe(before.sourceTemplateId);
    expect(renamed.dsl).toEqual(before.dsl);
  });

  it('save 写当前草稿 + updatedAt 更新 + 不动版本字段（currentVersion/sourceTemplateId）', async () => {
    const before = (await repo.get(1))!;
    const newDsl = { ...before.dsl, name: '销售单-改' };
    const saved = await repo.save(1, newDsl);
    expect(saved.dsl.name).toBe('销售单-改');
    expect(saved.updatedAt).toBeGreaterThanOrEqual(before.updatedAt);
    expect(saved.currentVersion).toBe(before.currentVersion);
    expect(saved.sourceTemplateId).toBe(before.sourceTemplateId);
  });
});

describe('MemoryTemplateRepository 删除守卫', () => {
  let repo: MemoryTemplateRepository;
  beforeEach(() => {
    repo = new MemoryTemplateRepository(buildSeedTemplates(), buildSeedVersions());
  });

  it('有后代的模板禁删（错误携带后代 id 清单）', async () => {
    try {
      await repo.remove(1);
      throw new Error('should not reach');
    } catch (e) {
      expect(e).toBeInstanceOf(TemplateHasDescendantsError);
      expect((e as TemplateHasDescendantsError).descendantIds).toContain(3);
    }
  });

  it('删除后代后，祖先变为可删', async () => {
    // 先删 coupon-sheet (id=3，是 sales-note 后代) → sales-note (id=1) 变为无后代
    await repo.remove(3);
    await repo.remove(1); // 不再抛错
    await expect(repo.get(1)).resolves.toBeNull();
  });

  it('删除模板同时清空其版本历史', async () => {
    await repo.remove(3); // 先清后代
    await repo.remove(1);
    // 重新抛 TemplateNotFoundError 而非返回空数组（说明数据已清）
    await expect(repo.getVersions(1)).rejects.toBeInstanceOf(TemplateNotFoundError);
  });

  it('多级后代也守卫：A → B → C，删 A 被 B/C 守卫', async () => {
    // id=3 是 id=1 的后代；duplicate id=3 生成 id=4（后代是 3）
    await repo.duplicate(3, { name: '衍生' });
    // 此时 id=1 的后代 = [3, 4]，删 1 应被守卫
    await expect(repo.remove(1)).rejects.toBeInstanceOf(TemplateHasDescendantsError);
    // 删除 id=3 也被守卫（id=4 是其后代）
    await expect(repo.remove(3)).rejects.toBeInstanceOf(TemplateHasDescendantsError);
  });
});

describe('MemoryTemplateRepository duplicate 血缘字段', () => {
  let repo: MemoryTemplateRepository;
  beforeEach(() => {
    repo = new MemoryTemplateRepository(buildSeedTemplates(), buildSeedVersions());
  });

  it('duplicate 默认名称 = 原名-副本', async () => {
    const dup = await repo.duplicate(1);
    expect(dup.name).toBe('销售单-副本');
  });

  it('duplicate 自定义名称生效', async () => {
    const dup = await repo.duplicate(1, { name: '实验副本' });
    expect(dup.name).toBe('实验副本');
  });

  it('duplicate 深拷贝 dsl：副本改动不传播回源', async () => {
    const sourceBefore = (await repo.get(1))!;
    const dup = await repo.duplicate(1);
    await repo.save(dup.id, { ...dup.dsl, name: '副本改' });
    const sourceAfter = await repo.get(1);
    expect(sourceAfter?.dsl.name).toBe(sourceBefore.dsl.name);
    expect(sourceAfter?.dsl.name).not.toBe('副本改');
  });

  it('duplicate sourceVersion 跟随源 currentVersion（已发布则取版本号，未发布则 null）', async () => {
    // sales-note (id=1) currentVersion=1
    const dup1 = await repo.duplicate(1);
    expect(dup1.sourceTemplateId).toBe(1);
    expect(dup1.sourceVersion).toBe(1);
    // inventory-report (id=2) currentVersion=null
    const dup2 = await repo.duplicate(2);
    expect(dup2.sourceTemplateId).toBe(2);
    expect(dup2.sourceVersion).toBeNull();
  });

  it('副本初始未发布：currentVersion=null + status=draft', async () => {
    const dup = await repo.duplicate(1);
    expect(dup.currentVersion).toBeNull();
    expect(dup.status).toBe('draft');
  });
});

describe('MemoryTemplateRepository publish 单调版本号', () => {
  let repo: MemoryTemplateRepository;
  beforeEach(() => {
    repo = new MemoryTemplateRepository(buildSeedTemplates(), buildSeedVersions());
  });

  it('changeNote 必填非空（空白字符串拒绝）', async () => {
    await expect(repo.publish(2, '')).rejects.toThrow(/changeNote/);
    await expect(repo.publish(2, ' ')).rejects.toThrow(/changeNote/);
  });

  it('草稿与 currentVersion 快照 hash 相同时拒绝（幂等防护）', async () => {
    // sales-note 草稿 = seed dsl = v1 快照 → 同 hash
    await expect(repo.publish(1, '重复发布')).rejects.toBeInstanceOf(TemplateNoChangesError);
  });

  it('从未发布的模板首次发布：v1 + currentVersion=1 + status=published', async () => {
    // inventory-report (id=2) 从未发布，currentVersion=null
    const published = await repo.publish(2, '首次发布');
    expect(published.currentVersion).toBe(1);
    expect(published.status).toBe('published');
    const versions = await repo.getVersions(2);
    expect(versions).toHaveLength(1);
    expect(versions[0].version).toBe(1);
    expect(versions[0].status).toBe('published');
    expect(versions[0].publishedBy).toBe(0); // mock 期固定 0
  });

  it('多次发布：版本号单调递增，每次 hash 反映当时草稿', async () => {
    let record = await repo.publish(2, 'v1');
    expect(record.currentVersion).toBe(1);
    // 改草稿后发布
    const afterV1 = (await repo.get(2))!;
    await repo.save(2, { ...afterV1.dsl, name: '盘点-v2' });
    record = await repo.publish(2, 'v2');
    expect(record.currentVersion).toBe(2);
    const afterV2 = (await repo.get(2))!;
    await repo.save(2, { ...afterV2.dsl, name: '盘点-v3' });
    record = await repo.publish(2, 'v3');
    expect(record.currentVersion).toBe(3);
    const versions = await repo.getVersions(2);
    expect(versions.map((v) => v.version)).toEqual([1, 2, 3]);
    // 三次发布的 dslHash 不同（hash 反映当时草稿）
    const hashes = versions.map((v) => v.dslHash);
    expect(new Set(hashes).size).toBe(3);
  });

  it('发布后 dslSchemaVersion 派生字段跟随草稿同步', async () => {
    const before = (await repo.get(2))!;
    await repo.save(2, { ...before.dsl, schemaVersion: '2.0' });
    await repo.publish(2, 'v1');
    const after = await repo.get(2);
    expect(after?.dslSchemaVersion).toBe('2.0');
  });
});

describe('MemoryTemplateRepository rollback 指针式', () => {
  let repo: MemoryTemplateRepository;

  beforeEach(async () => {
    repo = new MemoryTemplateRepository(buildSeedTemplates(), buildSeedVersions());
    // id=2 多次发布制造多个 published 版本
    await repo.publish(2, 'v1');
    const afterV1 = (await repo.get(2))!;
    await repo.save(2, { ...afterV1.dsl, name: 'v2' });
    await repo.publish(2, 'v2');
    const afterV2 = (await repo.get(2))!;
    await repo.save(2, { ...afterV2.dsl, name: 'v3' });
    await repo.publish(2, 'v3');
    // 现在 currentVersion=3
  });

  it('指针式：currentVersion 移到目标版本，不产生新版本行', async () => {
    const versionsBefore = await repo.getVersions(2);
    expect(versionsBefore.map((v) => v.version)).toEqual([1, 2, 3]);
    const rolled = await repo.rollback(2, 1);
    expect(rolled.currentVersion).toBe(1);
    const versionsAfter = await repo.getVersions(2);
    expect(versionsAfter.map((v) => v.version)).toEqual([1, 2, 3]); // 未新增
    expect(versionsAfter).toHaveLength(3);
  });

  it('回滚后草稿与目标版本快照一致（hash 相等）', async () => {
    await repo.rollback(2, 2);
    const record = await repo.get(2);
    const versions = await repo.getVersions(2);
    const v2Snapshot = versions.find((v) => v.version === 2)!;
    // 草稿 hash 与 v2 快照 hash 应相同
    const { DslParser } = await import('taprint');
    const draftHash = DslParser.hash(record!.dsl as Parameters<typeof DslParser.hash>[0]);
    expect(draftHash).toBe(v2Snapshot.dslHash);
  });

  it('回滚到不存在版本抛 RollbackTargetInvalidError', async () => {
    await expect(repo.rollback(2, 999)).rejects.toBeInstanceOf(RollbackTargetInvalidError);
  });

  it('草稿版本（status=draft）不可回滚', async () => {
    // 制造一条 draft 版本：直接修改内部状态——通过 save+publish+rollback 测试不太干净；
    // 改为构造新 repo 注入 draft 版本
    const draftRepo = new MemoryTemplateRepository(buildSeedTemplates(), [
      {
        templateId: 1,
        versions: [
          {
            version: 1,
            dsl: (await repo.get(1))!.dsl,
            dslHash: 'sha256:fake',
            changeNote: 'draft 测试',
            status: 'draft',
            publishedAt: null,
            publishedBy: null,
          },
        ],
      },
    ]);
    await expect(draftRepo.rollback(1, 1)).rejects.toBeInstanceOf(RollbackTargetInvalidError);
    const err = (await draftRepo.rollback(1, 1).catch((e) => e)) as RollbackTargetInvalidError;
    expect(err.reason).toContain('draft');
  });

  it('指针式连续回滚：v3→v1→v2，每次版本条目不变', async () => {
    await repo.rollback(2, 1);
    let record = await repo.get(2);
    expect(record?.currentVersion).toBe(1);
    await repo.rollback(2, 2);
    record = await repo.get(2);
    expect(record?.currentVersion).toBe(2);
    const versions = await repo.getVersions(2);
    expect(versions.map((v) => v.version)).toEqual([1, 2, 3]);
  });
});

describe('MemoryTemplateRepository lineage 多级链', () => {
  let repo: MemoryTemplateRepository;

  beforeEach(async () => {
    repo = new MemoryTemplateRepository(buildSeedTemplates(), buildSeedVersions());
    // 构造多级链：1 → 3 → 新 dup（新 id=4，sourceTemplateId=3）
    await repo.duplicate(3, { name: '级联副本' });
  });

  it('getLineage.ancestors 多级上溯（直接父在前）', async () => {
    const list = await repo.list();
    const dup = list.find((t) => t.name === '级联副本')!;
    const lineage = await repo.getLineage(dup.id);
    // 祖先链：3 (直接父), 1 (祖父)
    expect(lineage.ancestors.map((a) => a.id)).toEqual([3, 1]);
  });

  it('getLineage.descendants 包含所有后代（多级）', async () => {
    const lineage = await repo.getLineage(1);
    // 1 的后代：3 + dup（按 updatedAt 倒序）
    const ids = lineage.descendants.map((d) => d.id).sort();
    expect(ids).toContain(3);
    expect(ids.length).toBeGreaterThanOrEqual(2);
  });

  it('焦点模板自身不在 ancestors 也不在 descendants', async () => {
    const lineage = await repo.getLineage(3);
    expect(lineage.ancestors.map((a) => a.id)).not.toContain(3);
    expect(lineage.descendants.map((d) => d.id)).not.toContain(3);
  });

  it('原始模板（无祖先）ancestors 为空数组', async () => {
    const lineage = await repo.getLineage(1);
    expect(lineage.ancestors).toEqual([]);
  });
});

describe('getSharedRepository 单例 + 测试隔离', () => {
  beforeEach(() => {
    resetSharedRepository();
  });

  it('单例：多次调用返回同一实例', () => {
    const a = getSharedRepository();
    const b = getSharedRepository();
    expect(a).toBe(b);
  });

  it('默认 seed：3 模板 + sales-note v1 版本历史', async () => {
    const repo = getSharedRepository();
    const list = await repo.list();
    expect(list).toHaveLength(3);
    const versions = await repo.getVersions(1);
    expect(versions).toHaveLength(1);
  });

  it('setSharedRepository 替身注入 + resetSharedRepository 复位', async () => {
    const fake: TemplateRepository = {
      list: async () => [],
      get: async () => null,
      create: async () => ({}) as never,
      rename: async () => ({}) as never,
      remove: async () => undefined,
      duplicate: async () => ({}) as never,
      save: async () => ({}) as never,
      getVersions: async () => [],
      publish: async () => ({}) as never,
      rollback: async () => ({}) as never,
      getLineage: async () => ({ ancestors: [], descendants: [] }),
    };
    setSharedRepository(fake);
    expect(getSharedRepository()).toBe(fake);
    expect(await getSharedRepository().list()).toEqual([]);
    resetSharedRepository();
    // 复位后回到默认 seed
    const list = await getSharedRepository().list();
    expect(list).toHaveLength(3);
  });
});
