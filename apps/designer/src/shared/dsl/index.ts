// SPDX-License-Identifier: Apache-2.0
// DSL 相关前端适配（专项步骤 4：内核接线层）。
// DSL 权威实现一律在 taprint（设计契约）。
export { schemaOfVersion, schemaV1Object, schemaV11Object, schemaV2Object } from './schema';
export { validateTemplate, errorsForPath, V2_ERROR_HINTS } from './validation';
export type { TemplateValidationResult } from './validation';
