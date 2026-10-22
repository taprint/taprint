// SPDX-License-Identifier: Apache-2.0
// 模板域数据层：模型类型定义。
// 持久化形态：内存 mock（后端 API 就绪后切换 HTTP 实现，端点常量见 shared/session-api.ts）。
// 字段集冻结），只增字段须经维护者批准。字段名与后端
// `feature/print-render` 既有表/列对齐：currentVersion↔current_version、
// dslHash↔dsl_hash、changeNote↔change_note；sourceTemplateId/sourceVersion 为前端独立
// 血缘字段，不占用后端 parent_id（后者语义为门店覆盖链，属另一概念）。
import type { TemplateLike } from '../canvas/store';

/** 设备类（与 store.Device 同口径；后端映射 category/biz_type 见契约文档） */
export type DeviceClass = 'doc' | 'receipt' | 'label';

/** 模板状态（对齐后端 ss_sys_print_template.status） */
export type TemplateStatus = 'draft' | 'published' | 'archived';

/** 版本状态（对齐后端 ss_sys_print_template_version.status） */
export type VersionStatus = 'draft' | 'published' | 'grayscale';

/**
 * 模板元数据（列表层；不含 dsl，对齐后端 GET /list）。
 * 字段集冻结。
 *
 * `dslSchemaVersion` 为派生展示字段（list/get 时从 dsl.schemaVersion 派生），
 * 非业务字段——列表展示「schema 版本」列所需；
 * 该字段不映射后端独立列（后端 ss_sys_print_template 无 schema_version 列，
 * DSL schemaVersion 自描述于 dsl_content 内），契约文档登记为前端派生。
 */
export interface TemplateMeta {
  /** 数字主键（Long 形态对齐后端主键） */
  id: number;
  name: string;
  description?: string;
  deviceClass: DeviceClass;
  /** 另存为血缘——本模板由哪个模板复制而来（null = 无血缘/原始模板） */
  sourceTemplateId: number | null;
  /** 另存为时源模板的 currentVersion 快照（null = 无血缘或源模板当时未发布） */
  sourceVersion: number | null;
  /** 当前指向的已发布版本号（null = 从未发布；草稿态独立持有 dsl 不进版本行） */
  currentVersion: number | null;
  /** 模板生命周期状态 */
  status: TemplateStatus;
  /** 派生展示字段：DSL schemaVersion（如 '1.0' / '2.0'），跟随 dsl 更新（save 时自动） */
  dslSchemaVersion: string;
  /** 创建时间（整数毫秒，TZ=UTC） */
  createdAt: number;
  /** 最后更新时间（整数毫秒，TZ=UTC） */
  updatedAt: number;
}

/**
 * 完整模板记录（含 dsl 草稿，对齐后端 GET /info/{id}）。
 * dsl = 当前草稿（mock 内存独立持有；后端现无草稿列——契约文档登记映射口径）。
 */
export interface TemplateRecord extends TemplateMeta {
  dsl: TemplateLike;
}

/**
 * 版本快照（每次发布生成一条；版本号从 1 单调递增；版本历史只增不删不改）。
 * 字段集冻结。
 */
export interface TemplateVersion {
  /** 版本号（从 1 单调递增） */
  version: number;
  /** 发布时的 DSL 深拷贝快照（不可变） */
  dsl: TemplateLike;
  /** DSL 内容指纹（DslParser.hash 逐字，对齐后端 dsl_hash=sha256） */
  dslHash: string;
  /** 变更备注（发布必填，draft 可空字符串） */
  changeNote: string;
  /** 版本状态（对齐后端 ss_sys_print_template_version.status） */
  status: VersionStatus;
  /** 发布时间（整数毫秒；draft 版本为 null） */
  publishedAt: number | null;
  /** 发布人 userId（mock 期固定 0；后端 Long userId 映射见契约文档） */
  publishedBy: number | null;
}

/** 血缘查询结果（ancestors = sourceTemplateId 链上溯；descendants = 反向下探） */
export interface TemplateLineage {
  /** 祖先链（按近 → 远排序；焦点模板自身不含） */
  ancestors: TemplateMeta[];
  /** 后代树（所有反向后代，含多级；按 updatedAt 倒序） */
  descendants: TemplateMeta[];
}

/** 创建模板入参（id/时间戳/currentVersion/status 由 Repository 内部分配） */
export interface CreateTemplateInput {
  name: string;
  deviceClass: DeviceClass;
  description?: string;
  /** 初始 dsl（缺省时由 Repository 生成最小空模板） */
  dsl?: TemplateLike;
}

/** 另存为入参（name 缺省时由 Repository 生成「原名-副本」） */
export interface DuplicateInput {
  name?: string;
}
