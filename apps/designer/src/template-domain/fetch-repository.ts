// SPDX-License-Identifier: Apache-2.0
// 模板域数据层（真实接线 + 回读）：fetch Repository 实现。
// 端点/body/错误码严格按契约 模板 API 契约（映射表 + 鉴权）：
// GET /admin/print/template/list | info/{id} | {id}/versions | {id}/lineage
// GET /admin/print/template/version/dsl?templateId=&version=（v1.6 回读）
// POST /admin/print/template/save | rename | duplicate | delete-check | delete
// POST /admin/print/template/version/save | publish | rollback
// （/admin 前缀 = 后端 context-path；模板 API 契约 锁定值。）
//
// 响应口径（后端统一 R 信封）：成功 {code:0, message, result}（Long 序列化为
// String、日期 "yyyy-MM-dd HH:mm:ss" TZ=Asia/Shanghai，JacksonConfig 实测）；
// 失败为结构化错误体 {code, httpStatus, errorCode, message, traceId}，映射：
// 404/0600001 → TemplateNotFoundError（get 接口转 null）
// 409/0600005 → TemplateVersionConflictError（409 = 版本冲突）
// 0600007 → TemplateHasDescendantsError（删除守卫）
// 0600002 → Rollback TargetInvalidError
// 其他 → TemplateApiError（status + errorCode 兜底）
//
// ✅ DSL 内容回读（销账，模板 API 契约）：后端 GET /admin/print/template/version/dsl
// ?templateId=&version= 回读单版本 dsl_content（解析后 JSON）。读路径优先会话内本地
// 缓存（写路径过手即缓存，省请求），缺失走回读端点；端点 0600002（版本不存在/内容空）
// 或网络失败时：
// - get（画布加载路径）→ 抛 TemplateDslUnavailableError（绝不编造内容，防覆盖）；
// - rename/列表类返回值的 dsl 字段 → 最小骨架占位（调用方只消费 meta，不入画布）。
import { DslParser } from 'taprint';
import { getSessionToken } from '../shared/session-api';
import type { TemplateLike } from '../canvas/store';
import type { CreateTemplateInput, DuplicateInput } from './types';
import {
  RollbackTargetInvalidError,
  TemplateApiError,
  TemplateDslUnavailableError,
  TemplateHasDescendantsError,
  TemplateNotFoundError,
  TemplateNoChangesError,
  TemplateVersionConflictError,
  type TemplateLineage,
  type TemplateMeta,
  type TemplateRecord,
  type TemplateRepository,
  type TemplateVersion,
  type VersionStatus,
} from './repository';
import { deepCloneDsl, emptyDsl, schemaVersionOf } from './memory-repository';

// ── 契约端点常量（v1.4 ；禁平行路径）─────────────────────────────
const P = '/admin/print/template';
const EP = {
  list: `${P}/list`,
  info: (id: number) => `${P}/info/${id}`,
  save: `${P}/save`,
  rename: `${P}/rename`,
  duplicate: `${P}/duplicate`,
  deleteCheck: `${P}/delete-check`,
  del: `${P}/delete`,
  lineage: (id: number) => `${P}/${id}/lineage`,
  versions: (id: number) => `${P}/${id}/versions`,
  versionSave: `${P}/version/save`,
  versionDsl: (id: number, version: number) =>
    `${P}/version/dsl?templateId=${id}&version=${version}`,
  versionPublish: `${P}/version/publish`,
  versionRollback: `${P}/version/rollback`,
} as const;

// ── 后端结构化错误码（PrintErrorCode）─────────────────────
const BE_NOT_FOUND = '0600001';
const BE_VERSION_NOT_FOUND = '0600002';
const BE_VERSION_CONFLICT = '0600005';
const BE_HAS_DESCENDANTS = '0600007';

export interface FetchTemplateRepositoryOptions {
  /** 后端 origin（如 http://localhost:8866；不带 /admin 后缀——前缀属端点常量） */
  baseUrl: string;
  fetchImpl?: typeof fetch;
  /** 设计器会话 token 供给（Shiro 权限端点需 Bearer）；缺省读 session-api 内存 token */
  getToken?: () => string | null;
}

/**
 * fetch 仓储实现（真实后端）。构造注入 fetch/token 便于单测；不真连后端。
 * DSL 回读与本地缓存口径见文件头「DSL 内容回读（销账）」说明。
 */
export class FetchTemplateRepository implements TemplateRepository {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly getToken: () => string | null;
  /** 模板当前草稿 DSL（写路径过手即缓存；滚动草稿同模板唯一） */
  private readonly drafts = new Map<number, TemplateLike>();
  /** 已发布版本快照 DSL（`${id}@${version}` → dsl；publish 时写入） */
  private readonly snapshots = new Map<string, TemplateLike>();

  constructor(opts: FetchTemplateRepositoryOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    // 闭包裸调用包装（生产级必修）：原生 window.fetch 有 brand check，
    // 若直接 `this.fetchImpl(...)` 方法式调用（this=repo 实例）会在 Chromium 抛
    // "Illegal invocation"，且发生在请求进网络栈之前——表现为"网络请求失败"
    // 但抓包/CDP 无任何请求记录。session transport 闭包裸调用无此问题。
    // 包装后以裸函数形态调用（this=undefined），单测注入的 fetchImpl 不受影响。
    const rawFetch = opts.fetchImpl ?? fetch;
    this.fetchImpl = (...args: Parameters<typeof fetch>) => rawFetch(...args);
    this.getToken = opts.getToken ?? getSessionToken;
  }

  // ── TemplateRepository 接口实现 ─────────────────────────────────────

  async list(): Promise<TemplateMeta[]> {
    const rows = await this.call(EP.list, 'GET');
    return (Array.isArray(rows) ? rows : []).map((r) => entityToMeta(r as Record<string, unknown>));
  }

  async get(id: number): Promise<TemplateRecord | null> {
    let meta: TemplateMeta;
    try {
      meta = await this.loadMeta(id);
    } catch (e) {
      if (e instanceof TemplateNotFoundError) return null; // 接口契约：不存在返回 null
      throw e;
    }
    // 画布加载路径（严格口径）：本地缓存优先，缺失走 回读端点；仍不可得 → 显式抛错
    let dsl = this.bestKnownDsl(id, meta.currentVersion);
    if (!dsl) {
      const target = meta.currentVersion ?? 1; // 未发布 → 滚动草稿恒为 v1（契约缺口候选方案）
      const remote = await this.fetchRemoteDsl(id, target);
      if (remote) {
        if (meta.currentVersion !== null) {
          this.snapshots.set(snapshotKey(id, meta.currentVersion), deepCloneDsl(remote));
        } else {
          this.drafts.set(id, deepCloneDsl(remote));
        }
        dsl = remote;
      }
    }
    if (!dsl) throw new TemplateDslUnavailableError(id);
    return { ...meta, dslSchemaVersion: schemaVersionOf(dsl), dsl: deepCloneDsl(dsl) };
  }

  async create(input: CreateTemplateInput): Promise<TemplateRecord> {
    const dsl = input.dsl ? deepCloneDsl(input.dsl) : emptyDsl(input.name, input.deviceClass);
    const newIdRaw = await this.call(EP.save, 'POST', {
      name: input.name,
      description: input.description ?? null,
      deviceClass: input.deviceClass,
    });
    const newId = Number(newIdRaw);
    // 初始 DSL 落为 draft v1（既定偏差口径：设计器打开即可编辑）
    await this.call(EP.versionSave, 'POST', { templateId: newId, dsl, changeNote: '' });
    this.drafts.set(newId, deepCloneDsl(dsl));
    const meta = await this.loadMeta(newId);
    return { ...meta, dslSchemaVersion: schemaVersionOf(dsl), dsl: deepCloneDsl(dsl) };
  }

  async rename(id: number, name: string): Promise<TemplateRecord> {
    try {
      await this.call(EP.rename, 'POST', { id, name });
    } catch (e) {
      this.rethrowNotFound(e, id);
      throw e;
    }
    return this.loadRecordLenient(id);
  }

  async remove(id: number): Promise<void> {
    // 契约 ：remove = delete-check（前端二次确认数据源）+ delete（后端守卫兜底）
    let check: { hasDescendants?: unknown; descendants?: unknown };
    try {
      check = (await this.call(EP.deleteCheck, 'POST', { id })) as typeof check;
    } catch (e) {
      this.rethrowNotFound(e, id);
      throw e;
    }
    const descendants = Array.isArray(check?.descendants)
      ? (check.descendants as Array<{ id?: unknown }>)
      : [];
    if (check?.hasDescendants || descendants.length > 0) {
      throw new TemplateHasDescendantsError(
        id,
        descendants.map((d) => Number(d?.id)).filter(Number.isFinite),
      );
    }
    try {
      await this.call(EP.del, 'POST', { id });
    } catch (e) {
      this.rethrowNotFound(e, id);
      if (e instanceof TemplateApiError && e.errorCode === BE_HAS_DESCENDANTS) {
        // 并发竞态：check 后新增后代——后端守卫拒绝（message 内嵌后代 JSON 清单）
        throw new TemplateHasDescendantsError(id, parseDescendantIds(e.message));
      }
      throw e;
    }
    // 本地会话缓存清理
    this.drafts.delete(id);
    for (const key of Array.from(this.snapshots.keys())) {
      if (key.startsWith(`${id}@`)) this.snapshots.delete(key);
    }
  }

  async duplicate(id: number, opts: DuplicateInput = {}): Promise<TemplateRecord> {
    const sourceMeta = await this.loadMeta(id); // 不存在 → TemplateNotFoundError
    let newIdRaw: unknown;
    try {
      // sourceVersion 缺省：后端取源 current_version（契约 ）
      newIdRaw = await this.call(EP.duplicate, 'POST', { sourceId: id, name: opts.name ?? null });
    } catch (e) {
      this.rethrowNotFound(e, id);
      throw e;
    }
    const newId = Number(newIdRaw);
    // 本地草稿缓存：后端把源 currentVersion 快照 DSL 复制为新模板 draft v1（既定口径）
    const snap =
      sourceMeta.currentVersion !== null
        ? this.snapshots.get(snapshotKey(id, sourceMeta.currentVersion))
        : undefined;
    if (snap) this.drafts.set(newId, deepCloneDsl(snap));
    return this.loadRecordLenient(newId);
  }

  async save(id: number, dsl: TemplateLike): Promise<TemplateRecord> {
    try {
      // 滚动草稿（契约缺口候选方案）：后端同模板唯一 draft 行覆盖更新
      await this.call(EP.versionSave, 'POST', { templateId: id, dsl, changeNote: '' });
    } catch (e) {
      this.rethrowNotFound(e, id);
      throw e;
    }
    this.drafts.set(id, deepCloneDsl(dsl));
    const meta = await this.loadMeta(id);
    return { ...meta, dslSchemaVersion: schemaVersionOf(dsl), dsl: deepCloneDsl(dsl) };
  }

  async getVersions(id: number): Promise<TemplateVersion[]> {
    await this.loadMeta(id); // 接口契约：模板不存在 → TemplateNotFoundError
    const rows = await this.call(EP.versions(id), 'GET');
    const mapped: TemplateVersion[] = [];
    for (const row of Array.isArray(rows) ? (rows as Array<Record<string, unknown>>) : []) {
      const version = Number(row.version);
      // 后端置空 dslContent（契约 ）：DSL 取本地缓存，缺失走 回读端点
      let known =
        row.status === 'draft' ? this.drafts.get(id) : this.snapshots.get(snapshotKey(id, version));
      if (!known) {
        const remote = await this.fetchRemoteDsl(id, version);
        if (remote) {
          if (row.status === 'draft') this.drafts.set(id, deepCloneDsl(remote));
          else this.snapshots.set(snapshotKey(id, version), deepCloneDsl(remote));
          known = remote;
        }
      }
      if (!known) throw new TemplateDslUnavailableError(id);
      mapped.push(versionFromRow(row, known));
    }
    return mapped.sort((a, b) => a.version - b.version); // 接口升序（后端倒序）
  }

  async publish(id: number, changeNote: string): Promise<TemplateRecord> {
    if (!changeNote.trim()) {
      throw new Error('publish: changeNote 必填且不能为空白');
    }
    const meta = await this.loadMeta(id);
    const draft = this.drafts.get(id);
    let version: number;
    if (draft) {
      // 幂等防护（接口契约）：草稿与 currentVersion 快照 hash 相同则拒绝
      if (meta.currentVersion !== null) {
        const snap = this.snapshots.get(snapshotKey(id, meta.currentVersion));
        if (
          snap &&
          DslParser.hash(snap as Parameters<typeof DslParser.hash>[0]) ===
            DslParser.hash(draft as Parameters<typeof DslParser.hash>[0])
        ) {
          throw new TemplateNoChangesError(id, meta.currentVersion);
        }
      }
      // 拼装两步（契约 ）：version/save（滚动草稿）→ version/publish（指针移动）
      try {
        version = Number(
          await this.call(EP.versionSave, 'POST', { templateId: id, dsl: draft, changeNote }),
        );
      } catch (e) {
        this.rethrowNotFound(e, id);
        this.rethrowConflict(e, id);
        throw e;
      }
    } else {
      // 无本地草稿：依赖后端既有滚动 draft 行（内容在后端，无法回读仅取版本号）
      const rows = await this.call(EP.versions(id), 'GET');
      const draftRow = (Array.isArray(rows) ? (rows as Array<Record<string, unknown>>) : []).find(
        (r) => r.status === 'draft',
      );
      if (!draftRow) throw new TemplateDslUnavailableError(id);
      version = Number(draftRow.version);
    }
    try {
      await this.call(EP.versionPublish, 'POST', { templateId: id, version });
    } catch (e) {
      this.rethrowNotFound(e, id);
      this.rethrowConflict(e, id, version);
      throw e;
    }
    if (draft) {
      this.snapshots.set(snapshotKey(id, version), deepCloneDsl(draft));
      this.drafts.delete(id); // draft 行已晋升 published；下次 save 新开 draft
    }
    return this.loadRecordLenient(id);
  }

  async rollback(id: number, toVersion: number): Promise<TemplateRecord> {
    try {
      await this.call(EP.versionRollback, 'POST', { templateId: id, version: toVersion });
    } catch (e) {
      this.rethrowNotFound(e, id);
      if (e instanceof TemplateApiError && e.errorCode === BE_VERSION_NOT_FOUND) {
        throw new RollbackTargetInvalidError(id, toVersion, '版本不存在');
      }
      if (
        e instanceof TemplateApiError &&
        (e.status === 409 || e.errorCode === BE_VERSION_CONFLICT)
      ) {
        // 后端口径：目标行非 published（「只能回滚到已发布版本」）
        throw new RollbackTargetInvalidError(id, toVersion, '仅 published 版本可回滚');
      }
      throw e;
    }
    // 指针式回滚：不产生新版本行；本地草稿同步回滚到目标快照
    const snap = this.snapshots.get(snapshotKey(id, toVersion));
    if (snap) this.drafts.set(id, deepCloneDsl(snap));
    return this.loadRecordLenient(id);
  }

  async getLineage(id: number): Promise<TemplateLineage> {
    let result: unknown;
    try {
      result = await this.call(EP.lineage(id), 'GET');
    } catch (e) {
      this.rethrowNotFound(e, id);
      throw e;
    }
    // 后端 lineage 节点仅 {id,name,currentVersion,updatedAt,depth}：join list 全量 meta
    const metas = new Map<number, TemplateMeta>();
    try {
      for (const m of await this.list()) metas.set(m.id, m);
    } catch {
      // list 失败降级：节点派生 meta（仅展示层受损，血缘结构不丢）
    }
    const mapNode = (n: unknown): TemplateMeta => {
      const node = n as Record<string, unknown>;
      const nid = Number(node?.id);
      const joined = metas.get(nid);
      if (joined) return joined;
      return {
        id: nid,
        name: typeof node?.name === 'string' ? node.name : '',
        deviceClass: 'doc',
        sourceTemplateId: null,
        sourceVersion: null,
        currentVersion: toNullableNumber(node?.currentVersion),
        status: 'draft',
        dslSchemaVersion: 'unknown',
        createdAt: 0,
        updatedAt: parseBackendDateTime(node?.updatedAt),
      };
    };
    const r = (result ?? {}) as { ancestors?: unknown; descendants?: unknown };
    const ancestors = (Array.isArray(r.ancestors) ? r.ancestors : []).map(mapNode);
    const descendants = (Array.isArray(r.descendants) ? r.descendants : [])
      .map(mapNode)
      .sort((a, b) => b.updatedAt - a.updatedAt); // 接口口径：updatedAt 倒序
    return { ancestors, descendants };
  }

  // ── 内部：HTTP 层 + 错误映射 ────────────────────────────────────────

  /** 统一请求：R 信封解包（result）+ 结构化错误 → TemplateApiError */
  private async call(
    path: string,
    method: 'GET' | 'POST',
    body?: Record<string, unknown>,
  ): Promise<unknown> {
    const headers: Record<string, string> = {};
    if (method === 'POST') headers['Content-Type'] = 'application/json';
    const token = this.getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    let resp: Response;
    try {
      resp = await this.fetchImpl(this.baseUrl + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new TemplateApiError(`网络请求失败：${path}`);
    }
    let data: Record<string, unknown> = {};
    try {
      data = (await resp.json()) as Record<string, unknown>;
    } catch {
      // 非 JSON 响应体：按 HTTP 状态报错
    }
    if (!resp.ok) this.fail(resp.status, data, path);
    // 老式 R.error：200 + {code:500, message}（无 result，如参数校验直接返回）
    if (typeof data.code === 'number' && data.code !== 0 && data.result === undefined) {
      this.fail(data.code, data, path);
    }
    return data.result ?? null;
  }

  private fail(status: number, data: Record<string, unknown>, path: string): never {
    const errorCode = typeof data.errorCode === 'string' ? data.errorCode : undefined;
    const message =
      typeof data.message === 'string' && data.message.trim() ? data.message : `HTTP ${status}`;
    throw new TemplateApiError(`${message}（${path}）`, status, errorCode);
  }

  private isNotFound(e: unknown): boolean {
    return e instanceof TemplateApiError && (e.status === 404 || e.errorCode === BE_NOT_FOUND);
  }

  private rethrowNotFound(e: unknown, id: number): void {
    if (this.isNotFound(e)) throw new TemplateNotFoundError(id);
  }

  private rethrowConflict(e: unknown, id: number, version?: number): void {
    if (
      e instanceof TemplateApiError &&
      (e.status === 409 || e.errorCode === BE_VERSION_CONFLICT)
    ) {
      throw new TemplateVersionConflictError(
        id,
        version !== undefined ? `版本 ${version}：${e.message}` : e.message,
      );
    }
  }

  /** GET info → TemplateMeta（不存在 → TemplateNotFoundError） */
  private async loadMeta(id: number): Promise<TemplateMeta> {
    let entity: unknown;
    try {
      entity = await this.call(EP.info(id), 'GET');
    } catch (e) {
      this.rethrowNotFound(e, id);
      throw e;
    }
    return entityToMeta(entity as Record<string, unknown>);
  }

  /**
   * 回读：GET version/dsl → 单版本 DSL。
   * 404/0600001 → TemplateNotFoundError；0600002（版本不存在/内容空）→ null（调用方决策）；
   * 其他错误原样上抛；非对象 result → null。
   */
  private async fetchRemoteDsl(id: number, version: number): Promise<TemplateLike | null> {
    let result: unknown;
    try {
      result = await this.call(EP.versionDsl(id, version), 'GET');
    } catch (e) {
      this.rethrowNotFound(e, id);
      if (e instanceof TemplateApiError && e.errorCode === BE_VERSION_NOT_FOUND) return null;
      throw e;
    }
    if (result === null || typeof result !== 'object') return null;
    return result as TemplateLike;
  }

  /** 草稿优先，其次 currentVersion 快照缓存；皆无 → undefined */
  private bestKnownDsl(id: number, currentVersion: number | null): TemplateLike | undefined {
    return (
      this.drafts.get(id) ??
      (currentVersion !== null ? this.snapshots.get(snapshotKey(id, currentVersion)) : undefined)
    );
  }

  /**
   * 宽松记录装载（rename/duplicate/rollback/publish 返回值用）：调用方只消费 meta，
   * DSL 未知时以最小骨架占位——该占位绝不进入画布加载路径（画布走 get 严格口径）。
   */
  private async loadRecordLenient(id: number): Promise<TemplateRecord> {
    const meta = await this.loadMeta(id);
    const dsl = this.bestKnownDsl(id, meta.currentVersion) ?? emptyDsl(meta.name, meta.deviceClass);
    return { ...meta, dslSchemaVersion: schemaVersionOf(dsl), dsl: deepCloneDsl(dsl) };
  }
}

// ── DTO 映射 helpers ─────────────────────────────────────────────────

function snapshotKey(id: number, version: number): string {
  return `${id}@${version}`;
}

/** Long → String 序列化兼容（renren R + JacksonConfig ToStringSerializer） */
function toNullableNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function normalizeDeviceClass(v: unknown): 'doc' | 'receipt' | 'label' {
  return v === 'receipt' || v === 'label' || v === 'doc' ? v : 'doc';
}

/**
 * 后端 DATETIME → 整数毫秒。Jackson 输出 "yyyy-MM-dd HH:mm:ss"（TZ=Asia/Shanghai，
 * JacksonConfig 实测）；兼容数字毫秒与 ISO 字符串兜底。
 */
function parseBackendDateTime(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === 'string') {
    const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(v);
    if (m) {
      // Asia/Shanghai = UTC+8（无夏令时）：本地墙钟 → UTC epoch
      return (
        Date.UTC(
          Number(m[1]),
          Number(m[2]) - 1,
          Number(m[3]),
          Number(m[4]),
          Number(m[5]),
          Number(m[6]),
        ) -
        8 * 3_600_000
      );
    }
    const t = Date.parse(v);
    if (!Number.isNaN(t)) return t;
  }
  return 0;
}

/** 后端 PrintTemplateEntity（camelCase）→ 前端 TemplateMeta（契约 映射） */
function entityToMeta(e: Record<string, unknown>): TemplateMeta {
  const currentVersion = toNullableNumber(e.currentVersion);
  return {
    id: Number(e.id),
    name: typeof e.name === 'string' ? e.name : '',
    description: typeof e.description === 'string' ? e.description : undefined,
    deviceClass: normalizeDeviceClass(e.deviceClass),
    sourceTemplateId: toNullableNumber(e.sourceTemplateId),
    sourceVersion: toNullableNumber(e.sourceVersion),
    // 后端 current_version 默认 0 = 从未发布 → 前端 null（接口口径）
    currentVersion: currentVersion !== null && currentVersion > 0 ? currentVersion : null,
    status: e.status === 'published' || e.status === 'archived' ? e.status : 'draft',
    // 派生展示字段：list/info 不带 DSL，无从派生（契约 登记前端派生）
    dslSchemaVersion: 'unknown',
    createdAt: parseBackendDateTime(e.createDate),
    updatedAt: parseBackendDateTime(e.updateDate),
  };
}

/** 后端 PrintTemplateVersionEntity → 前端 TemplateVersion（dsl 由本地缓存供给） */
function versionFromRow(row: Record<string, unknown>, dsl: TemplateLike): TemplateVersion {
  const status: VersionStatus =
    row.status === 'draft' ? 'draft' : row.status === 'grayscale' ? 'grayscale' : 'published';
  const publishedAt = row.publishedAt == null ? null : parseBackendDateTime(row.publishedAt);
  return {
    version: Number(row.version),
    dsl: deepCloneDsl(dsl),
    dslHash: typeof row.dslHash === 'string' ? row.dslHash : '',
    changeNote: typeof row.changeNote === 'string' ? row.changeNote : '',
    status,
    publishedAt,
    publishedBy: toNullableNumber(row.publishedBy),
  };
}

/** 后端 delete 0600007 错误 message 内嵌后代 JSON 清单 → id 列表（尽力解析） */
function parseDescendantIds(message: string): number[] {
  const m = /\[[\s\S]*\]/.exec(message);
  if (!m) return [];
  try {
    const arr = JSON.parse(m[0]) as Array<{ id?: unknown }>;
    if (!Array.isArray(arr)) return [];
    return arr.map((x) => Number(x?.id)).filter(Number.isFinite);
  } catch {
    return [];
  }
}
