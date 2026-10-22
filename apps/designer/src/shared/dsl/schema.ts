// SPDX-License-Identifier: Apache-2.0
// DSL JSON Schema 注入（schemas/ 由 scripts/sync-assets.mjs 从仓库 schema/ 构建
// 时复制并生成 sha256 清单；漂移由 tests/unit/assets.spec.ts 与 build 前置
// sync:assets --check 双闸拦截）。
import schemaV1 from '../../../schemas/v1.0.json';
import schemaV11 from '../../../schemas/v1.1.json';
import schemaV2 from '../../../schemas/v2.0.json';

/**
 * 按 schemaVersion 选权威 schema（精确三档：2.x → v2.0、1.1 → v1.1、其余 1.x → v1.0）。
 * v1.0 文档按 v1.0 双读（text.size 0 合法）；v1.1 起收窄落稿（schema/changelog.md v1.1 行）。
 */
export function schemaOfVersion(version: string): object {
  if (version.startsWith('2.')) return schemaV2;
  if (version === '1.1') return schemaV11;
  return schemaV1;
}

export const schemaV1Object = schemaV1 as object;
export const schemaV11Object = schemaV11 as object;
export const schemaV2Object = schemaV2 as object;
