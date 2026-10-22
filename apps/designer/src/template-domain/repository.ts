// SPDX-License-Identifier: Apache-2.0
// 模板域数据层：Repository 接口）。
// 持久化形态：内存 mock（后端 API 就绪后按 docs/printer/designer/TEMPLATE-API-CONTRACT.md 切换 HTTP 实现）。
// 方法一律 async（为未来 HTTP 实现留形态），内存实现同步返回 Promise.resolve。
// 签名冻结：消费方（版本管理 / 血缘 + 契约文档）依赖此接口；不足 → 上报编排者，不得私扩。
import type {
  CreateTemplateInput,
  DuplicateInput,
  TemplateLineage,
  TemplateMeta,
  TemplateRecord,
  TemplateVersion,
} from './types';
import type { TemplateLike } from '../canvas/store';

// 类型再导出（消费方单一入口：从 repository.ts 即可拿到接口与全部模型类型）
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
} from './types';

/**
 * 模板仓储接口）。
 *
 * 语义说明：
 * - `remove` 有后代守卫（存在 sourceTemplateId 指向本模板的模板时抛错）。
 * - `publish` 从当前草稿生成新版本（version=max+1，status=published）并移动 currentVersion 指针；
 * 草稿与 currentVersion 快照 hash 相同则拒绝（幂等防护）。
 * - `rollback` 指针式：currentVersion 指向指定历史 published 版本，不产生新版本行；仅 published 可回滚。
 * - `duplicate` 复制为新模板（sourceTemplateId=源 id、sourceVersion=源 currentVersion 或 null）。
 * - `save` 写当前草稿；不动血缘/版本字段（updatedAt 更新）。
 */
export interface TemplateRepository {
  /** 列出所有模板元数据（不含 dsl） */
  list(): Promise<TemplateMeta[]>;

  /** 取单条完整记录（含 dsl 草稿）；不存在返回 null */
  get(id: number): Promise<TemplateRecord | null>;

  /** 创建新模板（Repository 内部分配 id/时间戳/currentVersion=null/status=draft） */
  create(input: CreateTemplateInput): Promise<TemplateRecord>;

  /** 重命名（更新 name + updatedAt，其他字段不动） */
  rename(id: number, name: string): Promise<TemplateRecord>;

  /** 删除模板（含其版本历史）；存在后代模板时抛 TemplateHasDescendantsError */
  remove(id: number): Promise<void>;

  /** 另存为：复制为新模板（含血缘字段 sourceTemplateId/sourceVersion）；DSL 深拷贝 */
  duplicate(id: number, opts?: DuplicateInput): Promise<TemplateRecord>;

  /** 保存当前草稿 DSL（更新 dsl + updatedAt；不动血缘/版本字段） */
  save(id: number, dsl: TemplateLike): Promise<TemplateRecord>;

  /** 取版本历史（按 version 升序） */
  getVersions(id: number): Promise<TemplateVersion[]>;

  /**
   * 从当前草稿发布为新版本（version=max+1, status=published），并移动 currentVersion 指针。
   * 草稿与 currentVersion 快照 hash 相同时抛 TemplateNoChangesError（幂等防护）。
   * changeNote 必填非空。
   */
  publish(id: number, changeNote: string): Promise<TemplateRecord>;

  /**
   * 指针式回滚：将 currentVersion 指向指定历史 published 版本，dls 同步回滚。
   * 不产生新版本行；仅 status=published 的版本可回滚（draft/grayscale 抛错）。
   * toVersion 不存在或非 published 抛错。
   */
  rollback(id: number, toVersion: number): Promise<TemplateRecord>;

  /** 血缘查询：ancestors = sourceTemplateId 链上溯；descendants = 反向下探 */
  getLineage(id: number): Promise<TemplateLineage>;
}

/** 后代守卫错误（删除有后代的模板时抛） */
export class TemplateHasDescendantsError extends Error {
  readonly code = 'TEMPLATE_HAS_DESCENDANTS';
  constructor(
    public readonly templateId: number,
    public readonly descendantIds: number[],
  ) {
    super(
      `模板 ${templateId} 存在 ${descendantIds.length} 个后代（${descendantIds.join(', ')}），禁止删除`,
    );
    this.name = 'TemplateHasDescendantsError';
  }
}

/** 模板未找到错误 */
export class TemplateNotFoundError extends Error {
  readonly code = 'TEMPLATE_NOT_FOUND';
  constructor(public readonly templateId: number) {
    super(`模板 ${templateId} 不存在`);
    this.name = 'TemplateNotFoundError';
  }
}

/** 发布幂等防护错误（草稿与当前已发布版本 hash 相同） */
export class TemplateNoChangesError extends Error {
  readonly code = 'TEMPLATE_NO_CHANGES';
  constructor(
    public readonly templateId: number,
    public readonly currentVersion: number,
  ) {
    super(`模板 ${templateId} 草稿与当前已发布版本 ${currentVersion} 内容相同，无变更可发布`);
    this.name = 'TemplateNoChangesError';
  }
}

/** 回滚非法错误（版本不存在或非 published） */
export class RollbackTargetInvalidError extends Error {
  readonly code = 'ROLLBACK_TARGET_INVALID';
  constructor(
    public readonly templateId: number,
    public readonly toVersion: number,
    public readonly reason: string,
  ) {
    super(`模板 ${templateId} 无法回滚到版本 ${toVersion}：${reason}`);
    this.name = 'RollbackTargetInvalidError';
  }
}

/**
 * 模板 API HTTP/业务通用错误（fetch Repository：未被类型化映射覆盖的错误兜底）。
 * `status` = HTTP 状态（网络失败为 undefined）；`errorCode` = 后端结构化错误码
 * （如 0600003 DSL 校验失败 / 0600008 重命名非法 / 1500001 未登录，模板 API 契约）。
 */
export class TemplateApiError extends Error {
  readonly code = 'TEMPLATE_API_ERROR';
  constructor(
    message: string,
    public readonly status?: number,
    public readonly errorCode?: string,
  ) {
    super(message);
    this.name = 'TemplateApiError';
  }
}

/** 版本冲突错误（HTTP 409 / 后端 0600005 TEMPLATE_VERSION_CONFLICT，模板 API 契约） */
export class TemplateVersionConflictError extends Error {
  readonly code = 'TEMPLATE_VERSION_CONFLICT';
  constructor(
    public readonly templateId: number,
    public readonly reason: string,
  ) {
    super(`模板 ${templateId} 版本冲突：${reason}`);
    this.name = 'TemplateVersionConflictError';
  }
}

/**
 * DSL 内容不可用错误（fetch Repository 专属）。
 * 后端 GET /{id}/versions 将 dslContent 置 null、且无版本 DSL 内容回读端点
 * （契约 ），会话内本地缓存缺失时读取方无法还原 DSL——显式抛错而非编造内容
 * （防画布加载空骨架后保存覆盖真实数据）。真实联调挂账：后端补内容回读端点。
 */
export class TemplateDslUnavailableError extends Error {
  readonly code = 'TEMPLATE_DSL_UNAVAILABLE';
  constructor(public readonly templateId: number) {
    super(
      `模板 ${templateId} DSL 内容不可用：后端无版本 DSL 回读端点（GET /versions 置空 dslContent），且本会话无本地缓存`,
    );
    this.name = 'TemplateDslUnavailableError';
  }
}
