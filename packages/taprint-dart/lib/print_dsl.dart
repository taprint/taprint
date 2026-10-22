// SPDX-License-Identifier: Apache-2.0
// print_dsl — 多语言实现共享内核 Dart 端（与 TS/C#/Java 同构）。
// 规范：docs/printer/designer/PRINT-DSL-DART-API-SPEC.md（v1.0）。
//
// 已落地：DslParser（parse/stringify/hash/parseResult）、DslValidator + FieldRegistry
//（JSON Schema draft 2020-12 + 业务规则 + DSL 2.0 cross-path）、DslMigrator
//（0.9→1.0→2.0 内置链 + 注册式扩展 + 逐步 schema 门禁）、ExpressionCompiler
//（ 表达式文法 +  沙箱）、MessageSigner（ HMAC 信任锚）。
library print_dsl;

export 'src/types.dart';
export 'src/dsl_parser.dart';
export 'src/dsl_validator.dart';
export 'src/dsl_migrator.dart';
export 'src/expression_compiler.dart';
export 'src/message_signer.dart';
