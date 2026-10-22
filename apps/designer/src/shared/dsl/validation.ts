// SPDX-License-Identifier: Apache-2.0
// 模板校验接线（专项步骤 4：DSL 内核进设计器加载/保存链路）。
// 内核 taprint 为权威实现；本层只做注入与聚合。
import {
  CURRENT_VERSION,
  DslMigrator,
  DslValidator,
  type TemplateDSL,
  type ValidationError,
} from 'taprint';
import { schemaOfVersion } from './schema';

export interface TemplateValidationResult {
  valid: boolean;
  /** schema 错误在前，业务规则错误在后 */
  errors: ValidationError[];
}

/** 按模板自身版本选 schema，跑 JSON Schema + 业务规则（含 v2 cross-path）校验 */
export function validateTemplate(dsl: TemplateDSL): TemplateValidationResult {
  let version: string;
  try {
    version = DslMigrator.detectVersion(dsl);
  } catch {
    version = CURRENT_VERSION;
  }
  const schemaResult = DslValidator.validate(dsl, schemaOfVersion(version));
  const businessResult = DslValidator.validateBusiness(dsl);
  const errors = [...schemaResult.errors, ...businessResult.errors];
  return { valid: errors.length === 0, errors };
}

/** 校验错误操作指引（属性面板/状态条就近展示；设计契约 步骤 4） */
export const V2_ERROR_HINTS: Record<string, string> = {
  'header-cell-span-mismatch':
    '表头网格 colspan/rowspan 越界、重叠或未填满——在「多级表头」编辑器调整跨度，使每行恰好填满列数',
  'subtotal-values-length': '分组小计 values 必须与列数等长（null 留空）——用「对齐到列数」一键修复',
  'static-row-span-mismatch':
    '自由合并行 colspan 合计必须等于列数、rowspan 不得超出 staticRows 行数——调整单元格跨度',
  'loop-each-not-detail': 'loop.each 必须引用 type=detail 的数据源（行集合语义）——改选明细数据源',
  'subtable-source-not-detail':
    'subtable.source 若指定必须引用 type=detail 数据源——改选明细数据源或留空（取列 field 指向的行内子数组）',
  'table-source-unknown': 'table.source 拼写与 dataSources 不匹配——在「数据源」下拉重选',
};

/** 按 JSON path 前缀过滤错误（编辑分区就近展示用；边界感知，body[1] 不误匹配 body[10+]） */
export function errorsForPath(errors: ValidationError[], pathPrefix: string): ValidationError[] {
  const prefix = pathPrefix.endsWith('.') ? pathPrefix.slice(0, -1) : pathPrefix;
  return errors.filter((e) => e.path === prefix || e.path.startsWith(`${prefix}.`));
}
