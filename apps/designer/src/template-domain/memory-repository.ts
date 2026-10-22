// SPDX-License-Identifier: Apache-2.0
// 模板域数据层：内存 Repository 实现。
// 持久化形态：内存 mock（页面刷新重置——禁止 localStorage/IndexedDB）。
// 后端 API 就绪后切换 HTTP 实现，调用方代码零改动（接口同形）。
import { DslParser } from 'taprint';
import type { TemplateLike } from '../canvas/store';
import type { CreateTemplateInput, DuplicateInput } from './types';
import {
  RollbackTargetInvalidError,
  TemplateHasDescendantsError,
  TemplateNotFoundError,
  TemplateNoChangesError,
  type TemplateLineage,
  type TemplateMeta,
  type TemplateRecord,
  type TemplateRepository,
  type TemplateVersion,
} from './repository';

/**
 * 极简空模板（新建模板向导缺省 dsl；含 deviceClass 对应呈现的最小骨架）。
 * 导出供 fetch Repository 复用（create 缺省 dsl 同形，避免两处漂移）。
 *
 * 2026-10-12 生产实测三连修（后端 /template/version/save 的 TemplateDslValidator 拒收）：
 *① id `tpl-<ts>` 连字符非法（须 ^[a-zA-Z][a-zA-Z0-9_]{0,63}$）→ `tpl_<ts>`；
 *② code 直接用名称（中文/小写/超长全非法，须 ^[A-Z][A-Z0-9_]{1,31}$）→ `TPL<ts>`；
 *③ body 空数组被拒（「缺少必填字段 body 或 body 为空」）→ 各设备类骨架 body
 * 至少含一行占位 text（content 纯字面量不引变量，空数据渲染也安全；
 * label 元素须带 x/y——validator 对 label 元素强制坐标）。
 */
/** 骨架 id/code 单调序号（同毫秒连建防撞——守卫单测钉） */
let emptyDslSeq = 0;

export function emptyDsl(name: string, deviceClass: 'doc' | 'receipt' | 'label'): TemplateLike {
  // 毫秒 + 进程序号：同毫秒连建两模板不撞 id/code（守卫单测钉）
  const seq = ++emptyDslSeq;
  const ts = Date.now();
  const placeholder = { type: 'text', content: name || '空白模板' };
  const base = {
    schemaVersion: '2.0',
    id: `tpl_${ts}_${seq}`,
    code: `TPL${ts}_${seq}`,
    name,
    dataSources: [],
  };
  if (deviceClass === 'doc') {
    return {
      ...base,
      presentations: { doc: { page: { size: 'A4' }, body: [placeholder] } },
    } as TemplateLike;
  }
  if (deviceClass === 'receipt') {
    return {
      ...base,
      presentations: { receipt: { width: '80mm', body: [placeholder] } },
    } as TemplateLike;
  }
  return {
    ...base,
    presentations: {
      label: {
        size: { width: '40mm', height: '30mm' },
        body: [{ ...placeholder, x: '0mm', y: '0mm' }],
      },
    },
  } as TemplateLike;
}

/**
 * 内存仓储实现。线程安全由 JS 单线程事件循环保证；原子性通过整方法同步执行达成
 * （无 await 中断点，调用方 await 期间不会被并发改写）。
 */
export class MemoryTemplateRepository implements TemplateRepository {
  private nextId = 1;
  private readonly templates = new Map<number, TemplateRecord>();
  private readonly versions = new Map<number, TemplateVersion[]>();

  /**
   * @param seedItems 启动期注入的种子模板（含字段：name/deviceClass/dsl/sourceTemplateId 等）
   * @param seedVersions 启动期注入的种子版本历史（按 templateId 分组）
   */
  constructor(
    seedItems: TemplateRecord[] = [],
    seedVersions: ReadonlyArray<{ templateId: number; versions: TemplateVersion[] }> = [],
  ) {
    for (const item of seedItems) {
      this.templates.set(item.id, deepCloneRecord(item));
      if (item.id >= this.nextId) this.nextId = item.id + 1;
    }
    for (const group of seedVersions) {
      this.versions.set(
        group.templateId,
        group.versions.map((v) => deepCloneVersion(v)),
      );
    }
  }

  async list(): Promise<TemplateMeta[]> {
    const items = Array.from(this.templates.values()).map(toMeta);
    return items.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async get(id: number): Promise<TemplateRecord | null> {
    const found = this.templates.get(id);
    return found ? deepCloneRecord(found) : null;
  }

  async create(input: CreateTemplateInput): Promise<TemplateRecord> {
    const now = Date.now();
    const id = this.nextId++;
    const dsl = input.dsl ? deepCloneDsl(input.dsl) : emptyDsl(input.name, input.deviceClass);
    const record: TemplateRecord = {
      id,
      name: input.name,
      description: input.description,
      deviceClass: input.deviceClass,
      sourceTemplateId: null,
      sourceVersion: null,
      currentVersion: null,
      status: 'draft',
      dslSchemaVersion: schemaVersionOf(dsl),
      createdAt: now,
      updatedAt: now,
      dsl,
    };
    this.templates.set(id, record);
    return deepCloneRecord(record);
  }

  async rename(id: number, name: string): Promise<TemplateRecord> {
    const found = this.requireTemplate(id);
    found.name = name;
    found.updatedAt = Date.now();
    return deepCloneRecord(found);
  }

  async remove(id: number): Promise<void> {
    this.requireTemplate(id);
    const descendants = this.findDescendants(id);
    if (descendants.length > 0) {
      throw new TemplateHasDescendantsError(
        id,
        descendants.map((d) => d.id),
      );
    }
    this.templates.delete(id);
    this.versions.delete(id);
  }

  async duplicate(id: number, opts: DuplicateInput = {}): Promise<TemplateRecord> {
    const source = this.requireTemplate(id);
    const now = Date.now();
    const newId = this.nextId++;
    const dsl = deepCloneDsl(source.dsl);
    const newRecord: TemplateRecord = {
      id: newId,
      name: opts.name ?? `${source.name}-副本`,
      description: source.description,
      deviceClass: source.deviceClass,
      // 血缘字段：记录来源模板 + 来时的 currentVersion（未发布则 null）
      sourceTemplateId: source.id,
      sourceVersion: source.currentVersion,
      currentVersion: null, // 副本独立演化，初始未发布
      status: 'draft',
      dslSchemaVersion: schemaVersionOf(dsl),
      createdAt: now,
      updatedAt: now,
      dsl,
    };
    this.templates.set(newId, newRecord);
    return deepCloneRecord(newRecord);
  }

  async save(id: number, dsl: TemplateLike): Promise<TemplateRecord> {
    const found = this.requireTemplate(id);
    found.dsl = deepCloneDsl(dsl);
    found.dslSchemaVersion = schemaVersionOf(found.dsl);
    found.updatedAt = Date.now();
    // 不动血缘/版本字段：仅草稿写回 + updatedAt 更新 + dslSchemaVersion 派生
    return deepCloneRecord(found);
  }

  async getVersions(id: number): Promise<TemplateVersion[]> {
    this.requireTemplate(id);
    const list = this.versions.get(id) ?? [];
    return list.map((v) => deepCloneVersion(v));
  }

  async publish(id: number, changeNote: string): Promise<TemplateRecord> {
    if (!changeNote.trim()) {
      throw new Error('publish: changeNote 必填且不能为空白');
    }
    const found = this.requireTemplate(id);
    const list = this.versions.get(id) ?? [];
    const nextVersion = list.length === 0 ? 1 : Math.max(...list.map((v) => v.version)) + 1;
    const draftHash = DslParser.hash(found.dsl as Parameters<typeof DslParser.hash>[0]);
    // 幂等防护：草稿与 currentVersion 快照 hash 相同时拒绝
    if (found.currentVersion !== null) {
      const currentSnapshot = list.find((v) => v.version === found.currentVersion);
      if (currentSnapshot && currentSnapshot.dslHash === draftHash) {
        throw new TemplateNoChangesError(id, found.currentVersion);
      }
    }
    const now = Date.now();
    const snapshot: TemplateVersion = {
      version: nextVersion,
      dsl: deepCloneDsl(found.dsl),
      dslHash: draftHash,
      changeNote,
      status: 'published',
      publishedAt: now,
      publishedBy: 0, // mock 期固定 0；后端 Long userId 映射见契约文档
    };
    list.push(snapshot);
    this.versions.set(id, list);
    found.currentVersion = nextVersion;
    found.status = 'published';
    found.updatedAt = now;
    return deepCloneRecord(found);
  }

  async rollback(id: number, toVersion: number): Promise<TemplateRecord> {
    const found = this.requireTemplate(id);
    const list = this.versions.get(id) ?? [];
    const target = list.find((v) => v.version === toVersion);
    if (!target) {
      throw new RollbackTargetInvalidError(id, toVersion, '版本不存在');
    }
    if (target.status !== 'published') {
      throw new RollbackTargetInvalidError(
        id,
        toVersion,
        `版本状态为 ${target.status}，仅 published 版本可回滚`,
      );
    }
    // 指针式：currentVersion 移到目标版本；草稿同步回滚为目标版本快照；不产生新版本行
    found.currentVersion = target.version;
    found.dsl = deepCloneDsl(target.dsl);
    found.status = 'published';
    found.updatedAt = Date.now();
    return deepCloneRecord(found);
  }

  async getLineage(id: number): Promise<TemplateLineage> {
    this.requireTemplate(id);
    const ancestors: TemplateMeta[] = [];
    let cursor: number | null = id;
    const visited = new Set<number>();
    while (cursor !== null) {
      if (visited.has(cursor)) break; // 防御环（理论上不应出现）
      visited.add(cursor);
      const cur = this.templates.get(cursor);
      if (!cur) break;
      if (cursor !== id) ancestors.push(toMeta(cur));
      cursor = cur.sourceTemplateId;
    }
    // ancestors 已按近 → 远（直接父在前），与 push 顺序一致
    const descendants = this.findDescendants(id)
      .map(toMeta)
      .sort((a, b) => b.updatedAt - a.updatedAt);
    return { ancestors, descendants };
  }

  /** 内部：模板必须存在，否则抛 TemplateNotFoundError */
  private requireTemplate(id: number): TemplateRecord {
    const found = this.templates.get(id);
    if (!found) throw new TemplateNotFoundError(id);
    return found;
  }

  /** 内部：递归查找所有后代（sourceTemplateId 指向 id 的模板，多级） */
  private findDescendants(id: number): TemplateRecord[] {
    const direct = Array.from(this.templates.values()).filter((t) => t.sourceTemplateId === id);
    const all = [...direct];
    for (const child of direct) {
      all.push(...this.findDescendants(child.id));
    }
    return all;
  }
}

// ── helpers（deepCloneDsl/schemaVersionOf 导出供 fetch Repository 复用）──

export function deepCloneDsl(dsl: TemplateLike): TemplateLike {
  return JSON.parse(JSON.stringify(dsl)) as TemplateLike;
}

/** 从 dsl.schemaVersion 读（DSL 自描述），缺省 'unknown' */
export function schemaVersionOf(dsl: TemplateLike): string {
  return typeof dsl?.schemaVersion === 'string' ? dsl.schemaVersion : 'unknown';
}

function deepCloneRecord(r: TemplateRecord): TemplateRecord {
  return {
    ...r,
    description: r.description,
    dslSchemaVersion: r.dslSchemaVersion,
    dsl: deepCloneDsl(r.dsl),
  };
}

function deepCloneVersion(v: TemplateVersion): TemplateVersion {
  return {
    ...v,
    dsl: deepCloneDsl(v.dsl),
  };
}

function toMeta(r: TemplateRecord): TemplateMeta {
  // 显式列出 meta 字段，避免 dsl 泄漏到列表层
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    deviceClass: r.deviceClass,
    sourceTemplateId: r.sourceTemplateId,
    sourceVersion: r.sourceVersion,
    currentVersion: r.currentVersion,
    status: r.status,
    dslSchemaVersion: r.dslSchemaVersion,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}
