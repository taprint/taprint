// SPDX-License-Identifier: Apache-2.0
// taprint — print template DSL kernel (TypeScript); API mirrors the C#/Dart/Java implementations
export type {
  TemplateDSL,
  FieldDef,
  ExpressionAST,
  ExpressionNode,
  ValidationResult,
  ValidationError,
} from './types.ts';
export type { ParseResult } from './parser.ts';
export type { MigrationSchemaGate, MigrationStep } from './migrator.ts';
// Phase 1-A 已落地：MessageSigner、DslParser（parse/stringify/
// hash/parseResult，sales-note-parse-result 锁定）、DslValidator + FieldRegistry。
// Phase 1-B 已落地：DslMigrator（0.9→1.0 内置迁移链 + 注册式步骤扩展 + 可选逐步
// schema 门禁；无 schemaVersion 的定稿前模板归 0.9，migration fixture 锁定）。
// v1.41 已落地：ExpressionCompiler。
export { DslParser } from './parser.ts';
export { DslValidator, FieldRegistry } from './validator.ts';
export { DslMigrator, CURRENT_VERSION, LEGACY_VERSION } from './migrator.ts';
export { ExpressionCompiler, ExpressionSyntaxError } from './expression-compiler.ts';
export { MessageSigner } from './message-signer.ts';
