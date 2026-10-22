// SPDX-License-Identifier: Apache-2.0
// 模板域数据层（地基 + 真实接线）：barrel 导出。
// 持久化形态双轨（契约 模板 API 契约）：
// - 内存 mock（MemoryTemplateRepository）：测试/离线缺省，语义不变；
// - fetch 实现（FetchTemplateRepository）：真实后端，VITE_SESSION_API_BASE 有值时启用。
//
// 单例 Repository：full 模式页面共享同一实例（页面刷新即重置，mock 不持久化是刻意决策）。
// full 模式入口（main.ts full 分支）由 routes.ts/DesignerPage/TemplateListPage 消费 getSharedRepository()。
export { MemoryTemplateRepository } from './memory-repository';
export { FetchTemplateRepository } from './fetch-repository';

export {
  RollbackTargetInvalidError,
  TemplateApiError,
  TemplateDslUnavailableError,
  TemplateHasDescendantsError,
  TemplateNotFoundError,
  TemplateNoChangesError,
  TemplateVersionConflictError,
  type TemplateRepository,
} from './repository';

export type {
  CreateTemplateInput,
  DeviceClass,
  DuplicateInput,
  TemplateLineage,
  TemplateMeta,
  TemplateRecord,
  TemplateStatus,
  TemplateVersion,
  VersionStatus,
} from './repository';

export { buildSeedTemplates, buildSeedVersions } from './seed';

// 模块级单例（页面生命周期内共享；测试 resetSharedRepository 可复位）
import { MemoryTemplateRepository } from './memory-repository';
import { FetchTemplateRepository } from './fetch-repository';
import { buildSeedTemplates, buildSeedVersions } from './seed';
import type { TemplateRepository } from './repository';
import { resolveApiBase } from '../shared/env';

let shared: TemplateRepository | null = null;

/**
 * 仓库工厂：apiBase 有值 → fetch 实现（真实后端）；
 * 否则内存 mock + 默认 seed（既有全部单测/e2e 语义不变）。纯函数便于单测。
 */
export function resolveTemplateRepository(apiBase: string | null): TemplateRepository {
  if (apiBase) {
    return new FetchTemplateRepository({ baseUrl: apiBase });
  }
  return new MemoryTemplateRepository(buildSeedTemplates(), buildSeedVersions());
}

/**
 * 取共享 Repository 单例（首次调用按环境变量 VITE_SESSION_API_BASE 决定形态；
 * 测试可先 setSharedRepository 替换）。
 */
export function getSharedRepository(): TemplateRepository {
  if (!shared) {
    shared = resolveTemplateRepository(resolveApiBase());
  }
  return shared;
}

/** 测试注入替身（生产代码勿调用） */
export function setSharedRepository(repo: TemplateRepository): void {
  shared = repo;
}

/** 测试复位为环境决定形态（生产代码勿调用） */
export function resetSharedRepository(): void {
  shared = null;
}
