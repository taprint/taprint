// SPDX-License-Identifier: Apache-2.0
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;

// 规范化 JSON（canonical JSON）C# 端：全深度递归 key Ordinal 字典序 + JSON-safe 断言，
// 与 print-dsl-ts internal/canonical.ts 同构。
// 数字一律经 EcmaNumber.Format（ECMA-262 最短十进制）——fixture v4 锁定；禁止
// JsonElement.WriteTo 直出数字（其保留原始文本 "1.0"/"1e2"，与 JS Number 往返归一不符）。
// 字符串转义走 JsonStringLiteral 手写字面量（WriteRawValue 直出，仅转义 " \ 与 U+0000-U+001F），
// 与 JS JSON.stringify 逐字一致（含 U+3000/U+2028/U+2029 原样输出）——v1.7 登记的
// 「残留差异 U+2028/U+2029」已于  轮 3 闭环销账（tree/element 双路径同口径）。
// 循环检测按「当前路径上的祖先集合」回溯：DAG 共享子对象不误报，真循环抛异常。
namespace Taprint.PrintDsl.Internal
{
    internal static class Canonical
    {
        private static readonly JsonWriterOptions WriterOptions = new JsonWriterOptions
        {
            Indented = false,
            Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        };

        /// <summary>
        /// JSON-safe 断言（.NET 对象树）：仅允许 null/string/bool/数字/字典/列表；
        /// 其余类型（DateTime/自定义 POCO 等）与循环引用显式抛 ArgumentException。
        /// </summary>
        public static void AssertJsonSafe(object? v, string path, HashSet<object>? seen = null)
        {
            if (v is null || v is string || v is bool) return;
            if (v is double || v is float || v is int || v is long || v is short || v is byte || v is decimal) return;
            if (v is IDictionary<string, object?> dict)
            {
                var visited = RequireSeen(seen, v, path);
                foreach (var kv in dict) AssertJsonSafe(kv.Value, $"{path}.{kv.Key}", visited);
                visited.Remove(v);
                return;
            }
            if (v is IList<object?> list)
            {
                var visited = RequireSeen(seen, v, path);
                for (var i = 0; i < list.Count; i++) AssertJsonSafe(list[i], $"{path}[{i}]", visited);
                visited.Remove(v);
                return;
            }
            throw new ArgumentException($"非 JSON-safe 值（{v.GetType().Name}）位于 {path}");
        }

        private static HashSet<object> RequireSeen(HashSet<object>? seen, object v, string path)
        {
            var visited = seen ?? new HashSet<object>(ReferenceEqualityComparer.Instance);
            if (!visited.Add(v)) throw new ArgumentException($"循环引用位于 {path}");
            return visited;
        }

        /// <summary>
        /// 对象树 → canonical 串（先断言后写出；excludeSignature=true 时顶层剥离 signature）。
        /// 注意「仅顶层剥离」：WriteSortedTree 递归调用刻意省略该参数（默认 false），嵌套
        /// signature 键一律保留——与 TS canonicalize 同口径；勿将参数透传进递归（回应）。
        /// </summary>
        public static string CanonicalizeTree(object msg, bool excludeSignature = true)
        {
            AssertJsonSafe(msg, "$");
            using var ms = new MemoryStream();
            using (var writer = new Utf8JsonWriter(ms, WriterOptions))
            {
                WriteSortedTree(msg, writer, excludeSignature);
            }
            return Encoding.UTF8.GetString(ms.ToArray());
        }

        /// <summary>JsonElement → canonical 串（递归 Ordinal 排序；顶层可选剥离 signature）。</summary>
        public static string CanonicalizeElement(JsonElement root, bool excludeSignature)
        {
            using var ms = new MemoryStream();
            using (var writer = new Utf8JsonWriter(ms, WriterOptions))
            {
                WriteSortedElement(root, writer, excludeSignature);
            }
            return Encoding.UTF8.GetString(ms.ToArray());
        }

        private static void WriteSortedTree(object? v, Utf8JsonWriter writer, bool excludeSignature = false)
        {
            switch (v)
            {
                case null:
                    writer.WriteNullValue();
                    break;
                case string s:
                    // JS JSON.stringify 字符串转义：仅 " \ 和控制字符；非 ASCII 原样输出（与 TS 一致）。
                    // Utf8JsonWriter.WriteStringValue 即使 UnsafeRelaxedJsonEscaping 仍转义部分 Unicode
                    // （如 U+3000 IDEOGRAPHIC SPACE），故手动转义 + WriteRawValue 绕过 Encoder。
                    writer.WriteRawValue(JsonStringLiteral(s));
                    break;
                case bool b:
                    writer.WriteBooleanValue(b);
                    break;
                case double d:
                    writer.WriteRawValue(EcmaNumber.Format(d));
                    break;
                case IDictionary<string, object?> dict:
                    writer.WriteStartObject();
                    foreach (var kv in dict
                        .Where(kv => !excludeSignature || kv.Key != "signature")
                        .OrderBy(kv => kv.Key, StringComparer.Ordinal))
                    {
                        writer.WritePropertyName(kv.Key);
                        WriteSortedTree(kv.Value, writer);
                    }
                    writer.WriteEndObject();
                    break;
                case IList<object?> list:
                    writer.WriteStartArray();
                    foreach (var item in list) WriteSortedTree(item, writer);
                    writer.WriteEndArray();
                    break;
                default:
                    // 其余数字类型归一 double（JS number 语义），保证单一数字出口
                    writer.WriteRawValue(EcmaNumber.Format(Convert.ToDouble(v)));
                    break;
            }
        }

        /// <summary>
        /// JS JSON.stringify 字符串字面量（含双引号）：仅转义 " \ 和控制字符（U+0000-U+001F），
        /// 非 ASCII 原样输出（与 TS 端 JSON.stringify 行为一致，绕过 Utf8JsonWriter 的 Unicode 转义）。
        /// </summary>
        private static string JsonStringLiteral(string s)
        {
            var sb = new StringBuilder(s.Length + 2);
            sb.Append('"');
            foreach (var c in s)
            {
                switch (c)
                {
                    case '\\': sb.Append("\\\\"); break;
                    case '"': sb.Append("\\\""); break;
                    case '\b': sb.Append("\\b"); break;
                    case '\f': sb.Append("\\f"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    default:
                        if (c < 0x20) sb.Append($"\\u{(int)c:x4}");
                        else sb.Append(c);
                        break;
                }
            }
            sb.Append('"');
            return sb.ToString();
        }

        private static void WriteSortedElement(JsonElement el, Utf8JsonWriter writer, bool excludeSignature = false)
        {
            switch (el.ValueKind)
            {
                case JsonValueKind.Object:
                    writer.WriteStartObject();
                    foreach (var prop in el.EnumerateObject()
                        .Where(p => !excludeSignature || p.Name != "signature")
                        .OrderBy(p => p.Name, StringComparer.Ordinal))
                    {
                        writer.WritePropertyName(prop.Name);
                        WriteSortedElement(prop.Value, writer);
                    }
                    writer.WriteEndObject();
                    break;
                case JsonValueKind.Array:
                    writer.WriteStartArray();
                    foreach (var item in el.EnumerateArray()) WriteSortedElement(item, writer);
                    writer.WriteEndArray();
                    break;
                case JsonValueKind.Number:
                    // 经 double 往返（与 JS JSON.parse 语义一致）再由 EcmaNumber 输出最短十进制
                    writer.WriteRawValue(EcmaNumber.Format(el.GetDouble()));
                    break;
                case JsonValueKind.String:
                    // 与 WriteSortedTree 同口径手动转义：el.WriteTo 经 Encoder 会把 U+3000/U+2028/U+2029
                    // 转成 \uXXXX（UnsafeRelaxedJsonEscaping 亦然），与 JS JSON.stringify 不符——
                    // 该分叉曾致元素路径（HmacMessageSigner.Verify(string)）canonical 与 tree 路径矛盾、
                    // 对 JS 合法签名验签失败
                    writer.WriteRawValue(JsonStringLiteral(el.GetString()!));
                    break;
                default:
                    el.WriteTo(writer);
                    break;
            }
        }

        private sealed class ReferenceEqualityComparer : IEqualityComparer<object>
        {
            public static readonly ReferenceEqualityComparer Instance = new ReferenceEqualityComparer();

            bool IEqualityComparer<object>.Equals(object? x, object? y) => ReferenceEquals(x, y);

            int IEqualityComparer<object>.GetHashCode(object obj) => System.Runtime.CompilerServices.RuntimeHelpers.GetHashCode(obj);
        }
    }
}
