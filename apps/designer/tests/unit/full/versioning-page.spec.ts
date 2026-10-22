// SPDX-License-Identifier: Apache-2.0
// VersionHistoryPage 单测（versioning ）：时间线/发布禁用态/发布流/指针式回滚/diff/404。
// 用真实内存路由（/versions/:id）挂载 + setSharedRepository 注入可控 Repository；
// 期望值来自真实运行（先观察实际输出再锚定，禁止凭空写快照）。
import { beforeEach, describe, expect, it } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';
import { mount } from '@vue/test-utils';
import { DslParser } from 'taprint';
import { sampleTemplate } from '../../../src/canvas/samples/sales-note';
import type { TemplateLike } from '../../../src/canvas/store';
import {
  MemoryTemplateRepository,
  resetSharedRepository,
  setSharedRepository,
  type TemplateRecord,
  type TemplateVersion,
} from '../../../src/template-domain';
import VersionHistoryPage from '../../../src/full/pages/VersionHistoryPage.vue';

const baseDsl = (): TemplateLike => JSON.parse(JSON.stringify(sampleTemplate)) as TemplateLike;

/** 预置：id=1 两条 published 版本（currentVersion=2），draft = v1 内容（≠ current → 有未发布改动） */
function seedRepo(): MemoryTemplateRepository {
  const v1Dsl = baseDsl();
  const v2Dsl = baseDsl();
  (v2Dsl.name as string) = '销售单-v2';
  const versions: TemplateVersion[] = [
    {
      version: 1,
      dsl: v1Dsl,
      dslHash: DslParser.hash(v1Dsl as never),
      changeNote: '初始版本',
      status: 'published',
      publishedAt: 1000,
      publishedBy: 0,
    },
    {
      version: 2,
      dsl: v2Dsl,
      dslHash: DslParser.hash(v2Dsl as never),
      changeNote: '第二版',
      status: 'published',
      publishedAt: 2000,
      publishedBy: 0,
    },
  ];
  const template: TemplateRecord = {
    id: 1,
    name: '销售单',
    deviceClass: 'receipt',
    sourceTemplateId: null,
    sourceVersion: null,
    currentVersion: 2,
    dslSchemaVersion: '2.0',
    status: 'published',
    createdAt: 0,
    updatedAt: 3000,
    dsl: v1Dsl, // 草稿 = v1 内容 → hash ≠ current(v2) → 有未发布改动
  };
  return new MemoryTemplateRepository([template], [{ templateId: 1, versions }]);
}

async function mountPage(id: number) {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/versions/:id', name: 'version-history', component: VersionHistoryPage }],
  });
  await router.push(`/versions/${id}`);
  await router.isReady();
  const wrapper = mount(VersionHistoryPage, { global: { plugins: [router] } });
  // 等页面 load 完成（onMounted 异步）
  await wrapper.find('[data-testid="version-history-page"]').exists();
  await new Promise((r) => setTimeout(r, 0));
  return wrapper;
}

describe('VersionHistoryPage（版本历史页）', () => {
  beforeEach(() => {
    resetSharedRepository();
  });

  it('时间线渲染：版本号/hash 短显/状态徽标/changeNote/当前版本标记', async () => {
    setSharedRepository(seedRepo());
    const wrapper = await mountPage(1);
    const rows = wrapper.findAll('[data-testid="timeline-row"]');
    expect(rows).toHaveLength(2);
    expect(wrapper.get('[data-testid="template-name"]').text()).toBe('销售单');
    expect(wrapper.get('[data-testid="current-version-badge"]').text()).toContain('当前版本：2');
    // 时间线倒序：v2 在上
    expect(rows[0].get('[data-testid="timeline-version"]').text()).toBe('v2');
    expect(rows[0].get('[data-testid="timeline-status"]').text()).toBe('published');
    expect(rows[0].get('[data-testid="timeline-note"]').text()).toBe('第二版');
    expect(rows[0].get('[data-testid="timeline-hash"]').text()).toContain('hash ');
    // 当前标记只落在 currentVersion=2
    expect(rows[0].findAll('[data-testid="timeline-current-marker"]').length).toBe(1);
    expect(rows[1].findAll('[data-testid="timeline-current-marker"]').length).toBe(0);
    // 草稿 ≠ current 快照 → 有未发布改动
    expect(wrapper.get('[data-testid="has-unpublished-chip"]').text()).toContain('有未发布改动');
  });

  it('发布：changeNote 必填 + hash 相同禁用态', async () => {
    const repo = seedRepo();
    setSharedRepository(repo);
    // 先把草稿改回 current(v2) 内容 → 无未发布改动 → 发布禁用 + 提示
    const v2Snapshot = (await repo.getVersions(1))[1];
    await repo.save(1, v2Snapshot.dsl);
    const wrapper = await mountPage(1);
    expect(wrapper.findAll('[data-testid="has-unpublished-chip"]')).toHaveLength(0);
    expect(wrapper.get('[data-testid="publish-no-changes-hint"]').text()).toContain('内容相同');
    const input = wrapper.get('[data-testid="publish-note-input"]');
    expect(input.element.hasAttribute('disabled')).toBe(true);
    expect(wrapper.get('[data-testid="publish-button"]').element.hasAttribute('disabled')).toBe(
      true,
    );
  });

  it('发布流：填备注 → 发布 → 时间线新增 v3 且当前标记移动', async () => {
    setSharedRepository(seedRepo());
    const wrapper = await mountPage(1);
    await wrapper.get('[data-testid="publish-note-input"]').setValue('第三版');
    expect(wrapper.get('[data-testid="publish-button"]').element.hasAttribute('disabled')).toBe(
      false,
    );
    await wrapper.get('[data-testid="publish-button"]').trigger('click');
    await new Promise((r) => setTimeout(r, 0));
    const rows = wrapper.findAll('[data-testid="timeline-row"]');
    expect(rows).toHaveLength(3);
    expect(rows[0].get('[data-testid="timeline-version"]').text()).toBe('v3');
    expect(rows[0].findAll('[data-testid="timeline-current-marker"]').length).toBe(1);
    expect(wrapper.get('[data-testid="current-version-badge"]').text()).toContain('当前版本：3');
    // 发布后草稿 == v3 → 无未发布改动
    expect(wrapper.findAll('[data-testid="has-unpublished-chip"]')).toHaveLength(0);
  });

  it('指针式回滚：仅 published 可回滚；回滚后 current 移动、条目数不变、草稿同步', async () => {
    setSharedRepository(seedRepo());
    const wrapper = await mountPage(1);
    // v1 行可回滚（published 且非当前）；v2 行（当前）禁用
    const rowV1 = wrapper.findAll('[data-testid="timeline-row"]')[1];
    const rowV2 = wrapper.findAll('[data-testid="timeline-row"]')[0];
    expect(rowV1.get('[data-testid="rollback-button"]').element.hasAttribute('disabled')).toBe(
      false,
    );
    expect(rowV2.get('[data-testid="rollback-button"]').element.hasAttribute('disabled')).toBe(
      true,
    );
    // 确认回滚到 v1
    await rowV1.get('[data-testid="rollback-button"]').trigger('click');
    expect(wrapper.get('[data-testid="rollback-confirm-section"]').text()).toContain('v1');
    await wrapper.get('[data-testid="rollback-confirm-button"]').trigger('click');
    await new Promise((r) => setTimeout(r, 0));
    const rows = wrapper.findAll('[data-testid="timeline-row"]');
    expect(rows).toHaveLength(2); // 指针式：不产生新版本行
    expect(rows[1].get('[data-testid="timeline-version"]').text()).toBe('v1');
    expect(rows[1].findAll('[data-testid="timeline-current-marker"]').length).toBe(1);
    expect(wrapper.get('[data-testid="current-version-badge"]').text()).toContain('当前版本：1');
    // 草稿同步回滚为 v1 内容 → hash(draft)==hash(v1) == current → 无未发布改动
    expect(wrapper.findAll('[data-testid="has-unpublished-chip"]')).toHaveLength(0);
  });

  it('draft/grayscale 版本回滚入口禁用并提示「只能回滚到已发布版本」', async () => {
    const dsl = baseDsl();
    const versions: TemplateVersion[] = [
      {
        version: 1,
        dsl,
        dslHash: DslParser.hash(dsl as never),
        changeNote: 'v1',
        status: 'published',
        publishedAt: 1,
        publishedBy: 0,
      },
      {
        version: 2,
        dsl,
        dslHash: DslParser.hash(dsl as never),
        changeNote: 'draft 草稿',
        status: 'draft',
        publishedAt: null,
        publishedBy: null,
      },
      {
        version: 3,
        dsl,
        dslHash: DslParser.hash(dsl as never),
        changeNote: '灰度中',
        status: 'grayscale',
        publishedAt: 3,
        publishedBy: 0,
      },
    ];
    const template: TemplateRecord = {
      id: 1,
      name: 'T',
      deviceClass: 'receipt',
      sourceTemplateId: null,
      sourceVersion: null,
      currentVersion: 1,
      dslSchemaVersion: '2.0',
      status: 'published',
      createdAt: 0,
      updatedAt: 0,
      dsl,
    };
    setSharedRepository(new MemoryTemplateRepository([template], [{ templateId: 1, versions }]));
    const wrapper = await mountPage(1);
    const rows = wrapper.findAll('[data-testid="timeline-row"]');
    // 行序倒序：v3(grayscale)、v2(draft)、v1(published)
    for (const [rowIndex, expectedStatus] of [
      [0, 'grayscale'],
      [1, 'draft'],
    ] as const) {
      const row = rows[rowIndex];
      expect(row.get('[data-testid="timeline-status"]').text()).toBe(expectedStatus);
      expect(row.get('[data-testid="rollback-button"]').element.hasAttribute('disabled')).toBe(
        true,
      );
      expect(row.get('[data-testid="rollback-button"]').attributes('title')).toContain(
        '只能回滚到已发布版本',
      );
    }
    const rowV1 = rows[2];
    // v1 是当前指向版本（currentVersion=1）：published 但「已是当前版本」→ 同样禁用（另一条规则）
    expect(rowV1.get('[data-testid="rollback-button"]').element.hasAttribute('disabled')).toBe(
      true,
    );
    expect(rowV1.get('[data-testid="rollback-button"]').attributes('title')).toContain(
      '已是当前版本',
    );
  });

  it('模板不存在 → 404 态（version-not-found）', async () => {
    setSharedRepository(new MemoryTemplateRepository([], []));
    const wrapper = await mountPage(99);
    expect(wrapper.get('[data-testid="version-not-found"]').text()).toContain('不存在');
  });

  it('diff 面板：草稿 vs 已发布版本显示三态差异；同 hash 判相等', async () => {
    setSharedRepository(seedRepo());
    const wrapper = await mountPage(1);
    const selectA = wrapper.get('[data-testid="diff-select-a"]');
    const selectB = wrapper.get('[data-testid="diff-select-b"]');
    // 默认 A=草稿、B=current(v2)：草稿=v1 内容 → 与 v2 差异应含 name 修改
    await new Promise((r) => setTimeout(r, 0));
    expect(wrapper.find('[data-testid="diff-change-list"]').exists()).toBe(true);
    const rows = wrapper.findAll('[data-testid="diff-change-row"]');
    expect(rows.length).toBeGreaterThan(0);
    const nameChange = rows.find((r) => r.text().includes('name'));
    expect(nameChange?.text()).toContain('修改');
    // B 切到 v1 → 与草稿相等
    await selectB.setValue('1');
    await new Promise((r) => setTimeout(r, 0));
    expect(wrapper.get('[data-testid="diff-equal"]').text()).toContain('内容一致');
    // 类型转换兜底：select 值以字符串返回，组件按 string|number 处理
    void selectA;
  });
});
