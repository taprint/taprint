// SPDX-License-Identifier: Apache-2.0
// DSL 解析/序列化/内容 hash（与 C#/Dart/Java 同构）。
// 规范化口径（文档留白处的 Phase 1-A 决策，多语言实现须一致，fixture 锁定）：
// - stringify：全深度递归 key 字典序 + 紧凑 JSON（与 MessageSigner.canonicalize 同规则，
//   但不剥离 signature——DSL 无签名字段语义）；
// - hash：sha256:<hex>，摘要输入为 stringify 输出；
// - parseResult：四字段（hash/fieldPaths/expressionCount/valid），
//   expressionCount 仅统计 presentations（渲染面），detail 路径带 <name>[*]. 前缀。
import { expressionsOf, fieldPathsOf } from './internal/analysis.ts';
import { assertJsonSafe, sortKeysDeep } from './internal/canonical.ts';
import { sha256, toHex, utf8 } from './internal/crypto.ts';
import { DslValidator } from './validator.ts';
import type { TemplateDSL } from './types.ts';

/** parse-result 期望输出形状 */
export interface ParseResult {
  hash: string;
  fieldPaths: string[];
  expressionCount: number;
  valid: boolean;
}

export class DslParser {
  /** 解析 JSON 字符串为 DSL 对象（容忍 BOM；顶层必须为对象；schema 合法性归 DslValidator） */
  static parse(json: string): TemplateDSL {
    if (typeof json !== 'string') {
      throw new TypeError('DslParser.parse: 输入必须为 JSON 字符串');
    }
    const text = json.charCodeAt(0) === 0xfeff ? json.slice(1) : json;
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch (e) {
      throw new SyntaxError(`DslParser.parse: 非法 JSON —— ${(e as Error).message}`);
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new TypeError('DslParser.parse: 顶层必须为 JSON 对象');
    }
    return value as TemplateDSL;
  }

  /** 序列化 DSL 为 JSON 字符串（规范化：key 字典序 + 紧凑，便于 hash/比较） */
  static stringify(dsl: TemplateDSL): string {
    assertJsonSafe(dsl, '$');
    return JSON.stringify(sortKeysDeep(dsl));
  }

  /** 计算 DSL 内容 hash（用于版本检测、缓存）：sha256:<hex>(stringify 输出) */
  static hash(dsl: TemplateDSL): string {
    return `sha256:${toHex(sha256(utf8(DslParser.stringify(dsl))))}`;
  }

  /** parse-result：schema 为 JSON Schema 权威定义（schema/ 目录），供 valid 判定 */
  static parseResult(dsl: TemplateDSL, schema: object): ParseResult {
    return {
      hash: DslParser.hash(dsl),
      fieldPaths: fieldPathsOf(dsl),
      expressionCount: expressionsOf(dsl).length,
      valid: DslValidator.validate(dsl, schema).valid,
    };
  }
}
