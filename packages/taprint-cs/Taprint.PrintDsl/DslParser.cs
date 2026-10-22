// SPDX-License-Identifier: Apache-2.0
using System;
using System.Collections.Generic;
using System.Text.Json;
using Taprint.PrintDsl.Internal;

// DSL 解析/序列化/内容 hash C# 端（print-dsl-ts parser.ts 同构移植；）。
// 规范化口径（Phase 1-A 决策，多语言实现一致，fixture 锁定）：
// - Stringify：全深度递归 key Ordinal 字典序 + 紧凑 JSON（与 MessageSigner.Canonicalize
//   同规则，但不剥离 signature——DSL 无签名字段语义，excludeSignature:false）；
// - Hash：sha256:<hex>，摘要输入为 Stringify 输出。
// parseResult 依赖 DslValidator，归轮 3（）。
namespace Taprint.PrintDsl
{
    /// <summary>DSL 解析/序列化/内容 hash（C#/TS/Dart 同构；数字归一 double 镜像 JS JSON.parse）。</summary>
    public static class DslParser
    {
        /// <summary>解析 JSON 字符串为 DSL 对象树（容忍 BOM；顶层必须为对象；schema 合法性归 DslValidator）。</summary>
        public static IDictionary<string, object?> Parse(string json)
        {
            if (json is null) throw new ArgumentNullException(nameof(json), "DslParser.parse: 输入必须为 JSON 字符串");
            var text = json.Length > 0 && json[0] == '\uFEFF' ? json.Substring(1) : json;
            JsonDocument doc;
            try
            {
                doc = JsonDocument.Parse(text);
            }
            catch (JsonException e)
            {
                throw new FormatException($"DslParser.parse: 非法 JSON —— {e.Message}", e);
            }
            using (doc)
            {
                if (doc.RootElement.ValueKind != JsonValueKind.Object)
                {
                    throw new ArgumentException("DslParser.parse: 顶层必须为 JSON 对象", nameof(json));
                }
                return (IDictionary<string, object?>)JsonTree.ToTree(doc.RootElement)!;
            }
        }

        /// <summary>序列化 DSL 为 JSON 字符串（规范化：key Ordinal 字典序 + 紧凑，便于 hash/比较）。</summary>
        public static string Stringify(object dsl)
        {
            if (dsl is null) throw new ArgumentNullException(nameof(dsl));
            return Canonical.CanonicalizeTree(dsl, excludeSignature: false);
        }

        /// <summary>计算 DSL 内容 hash（用于版本检测、缓存）：sha256:&lt;hex&gt;(Stringify 输出)。</summary>
        public static string Hash(object dsl)
        {
            return $"sha256:{Crypto.ToHex(Crypto.Sha256(Crypto.Utf8(Stringify(dsl))))}";
        }

        /// <summary> parse-result 期望输出形状（hash/fieldPaths/expressionCount/valid）。</summary>
        public sealed class ParseResult
        {
            /// <summary>内容 hash：sha256:&lt;hex&gt;(Stringify 输出)。</summary>
            public string Hash { get; }
            /// <summary>字段路径集合（detail 源带 [*] 前缀，Ordinal 字典序）。</summary>
            public IReadOnlyList<string> FieldPaths { get; }
            /// <summary>表达式数量（仅 presentations 内的 {{...}}）。</summary>
            public int ExpressionCount { get; }
            /// <summary>JSON Schema 校验结果。</summary>
            public bool Valid { get; }

            /// <summary>构造。</summary>
            public ParseResult(string hash, IReadOnlyList<string> fieldPaths, int expressionCount, bool valid)
            {
                Hash = hash;
                FieldPaths = fieldPaths;
                ExpressionCount = expressionCount;
                Valid = valid;
            }
        }

        /// <summary>
        ///  parse-result：hash/fieldPaths/expressionCount/valid 四字段。
        /// schema 由宿主注入（与 Validate 同口径）；3 锚点（sales-note/inventory-report/coupon-sheet）
        /// 逐字一致——hash=sha256 为最硬跨端断言。
        /// </summary>
        /// <param name="dsl">DSL 对象树。</param>
        /// <param name="schema">JsonSchema 对象。</param>
        public static ParseResult GetParseResult(object dsl, object schema)
        {
            return new ParseResult(
                Hash(dsl),
                Analysis.FieldPathsOf(dsl),
                Analysis.ExpressionsOf(dsl).Count,
                DslValidator.Validate(dsl, schema).Valid);
        }
    }
}
