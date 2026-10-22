// SPDX-License-Identifier: Apache-2.0
using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.RegularExpressions;

// DSL 静态分析 C# 端（print-dsl-ts internal/analysis.ts 同构移植）：
// 数据源字段路径展平 + 表达式收集 + 字段引用可解析性判定。
// DslParser.ParseResult（轮 3）与 DslValidator.ValidateBusiness（轮 3）共用。
namespace Taprint.PrintDsl.Internal
{
    /// <summary>数据源信息（name/type/schema；schema 为字段字典：叶子为类型名，嵌套对象为子结构）。</summary>
    internal sealed class DataSourceInfo
    {
        public string Name { get; }
        public string Type { get; }
        /// <summary>TS filter 对数组 schema 亦放行（typeof [] === 'object'），故此处为 object。</summary>
        public object Schema { get; }

        public DataSourceInfo(string name, string type, object schema)
        {
            Name = name;
            Type = type;
            Schema = schema;
        }
    }

    /// <summary>表达式出现位置：Path 为 JSON path，Raw 为完整 {{...}}，Ref 为 {{}} 内表达式全文（trim 后）。</summary>
    internal sealed class ExpressionOccurrence
    {
        public string Path { get; }
        public string Raw { get; }
        public string Ref { get; }

        public ExpressionOccurrence(string path, string raw, string reference)
        {
            Path = path;
            Raw = raw;
            Ref = reference;
        }
    }

    /// <summary>DSL 静态分析（与 TS internal/analysis.ts 逐行同构）。</summary>
    internal static class Analysis
    {
        private static readonly Regex ExprRe = new Regex(@"\{\{([^{}]+)\}\}", RegexOptions.Compiled);
        private static readonly Regex DigitSegRe = new Regex(@"^\d+$", RegexOptions.Compiled);

        public static IReadOnlyList<DataSourceInfo> DataSourcesOf(object dsl)
        {
            if (!(dsl is IDictionary<string, object?> root) ||
                !(root.TryGetValue("dataSources", out var raw) && raw is IList<object?> list))
            {
                return Array.Empty<DataSourceInfo>();
            }
            var result = new List<DataSourceInfo>();
            foreach (var item in list)
            {
                if (item is IDictionary<string, object?> ds &&
                    ds.TryGetValue("name", out var nameObj) && nameObj is string name &&
                    ds.TryGetValue("schema", out var schemaObj) &&
                    (schemaObj is IDictionary<string, object?> || schemaObj is IList<object?>))
                {
                    var type = ds.TryGetValue("type", out var typeObj) && typeObj is string t ? t : "";
                    result.Add(new DataSourceInfo(name, type, schemaObj!));
                }
            }
            return result;
        }

        /// <summary>
        /// 展平字段字典为点路径。
        /// detail 源的路径带 `&lt;name&gt;[*].` 前缀（行集合语义，与  parse-result 示例一致）。
        /// </summary>
        public static IReadOnlyList<string> FieldPathsOf(object dsl)
        {
            var outList = new List<string>();
            foreach (var ds in DataSourcesOf(dsl))
            {
                var prefix = ds.Type == "detail" ? $"{ds.Name}[*]." : "";
                FlattenSchema(ds.Schema, prefix, outList);
            }
            return outList.Distinct().OrderBy(p => p, StringComparer.Ordinal).ToList();
        }

        private static void FlattenSchema(object node, string prefix, List<string> outList)
        {
            // TS Object.entries 语义：字典按键、数组按索引串展开；
            // 仅嵌套字典递归（TS：!Array.isArray 才递归），数组值按叶子处理。
            IEnumerable<KeyValuePair<string, object?>> entries;
            if (node is IDictionary<string, object?> dict)
            {
                entries = dict;
            }
            else if (node is IList<object?> arr)
            {
                entries = Enumerable.Range(0, arr.Count)
                    .Select(i => new KeyValuePair<string, object?>(i.ToString(System.Globalization.CultureInfo.InvariantCulture), arr[i]));
            }
            else
            {
                return;
            }
            foreach (var kv in entries)
            {
                if (kv.Value is IDictionary<string, object?> nested)
                {
                    FlattenSchema(nested, $"{prefix}{kv.Key}.", outList);
                }
                else
                {
                    outList.Add($"{prefix}{kv.Key}");
                }
            }
        }

        /// <summary>收集 presentations 内全部 {{...}} 表达式（parameters/dataSources 不在渲染面，不计）。</summary>
        public static IReadOnlyList<ExpressionOccurrence> ExpressionsOf(object dsl)
        {
            var outList = new List<ExpressionOccurrence>();
            if (dsl is IDictionary<string, object?> root && root.TryGetValue("presentations", out var presentations))
            {
                Walk(presentations, "presentations", outList);
            }
            return outList;
        }

        private static void Walk(object? v, string path, List<ExpressionOccurrence> outList)
        {
            if (v is string s)
            {
                foreach (Match m in ExprRe.Matches(s))
                {
                    outList.Add(new ExpressionOccurrence(path, m.Value, m.Groups[1].Value.Trim()));
                }
                return;
            }
            if (v is IList<object?> list)
            {
                for (var i = 0; i < list.Count; i++) Walk(list[i], $"{path}[{i}]", outList);
                return;
            }
            if (v is IDictionary<string, object?> dict)
            {
                foreach (var kv in dict) Walk(kv.Value, $"{path}.{kv.Key}", outList);
            }
        }

        /// <summary>顶层 parameters 名称集（主文档 ：运行时参数可被表达式引用，如 {{copies}}）。</summary>
        public static HashSet<string> ParamNamesOf(object dsl)
        {
            var set = new HashSet<string>(StringComparer.Ordinal);
            if (!(dsl is IDictionary<string, object?> root) ||
                !(root.TryGetValue("parameters", out var raw) && raw is IList<object?> list))
            {
                return set;
            }
            foreach (var item in list)
            {
                if (item is IDictionary<string, object?> p &&
                    p.TryGetValue("name", out var nameObj) && nameObj is string name)
                {
                    set.Add(name);
                }
            }
            return set;
        }

        /// <summary>字段引用解析结论：ok=可解析；unknown=无处可解析；ambiguous=裸路径命中多个数据源。</summary>
        public const string RefOk = "ok";
        public const string RefUnknown = "unknown";
        public const string RefAmbiguous = "ambiguous";

        /// <summary>
        /// 字段引用可解析性（十轮多源同名裸路径不再静默放行）：
        /// 1) 首段为数据源名 → 余下路径须存在于该源 schema（单段即整源聚合引用）；
        /// 2) 否则裸路径恰命中一个数据源 schema → ok（fixture 惯例：主源字段免前缀）；
        /// 3) 裸路径命中 ≥2 个源 → ambiguous（要求写源前缀消歧）；
        /// 4) 数据源均未命中 → 查 parameters 名称（运行时参数，如 copies/printer）。
        /// 数组索引段（items.0.sku ⇔ items[0].sku，ExtractFields 输出形态）在校验前剥离。
        /// </summary>
        public static string ClassifyRef(
            string reference,
            IReadOnlyList<DataSourceInfo> sources,
            ISet<string>? paramNames = null)
        {
            var normalized = string.Join(".", reference
                .Split('.')
                .Where(seg => !DigitSegRe.IsMatch(seg)));
            if (normalized.Length == 0) return RefUnknown;
            var segments = normalized.Split('.');
            var byName = sources.FirstOrDefault(ds => ds.Name == segments[0]);
            if (byName != null)
            {
                if (segments.Length == 1) return RefOk;
                var rest = string.Join(".", segments.Skip(1));
                return BarePathsOf(byName.Schema).Contains(rest) ? RefOk : RefUnknown;
            }
            var matches = sources.Count(ds => BarePathsOf(ds.Schema).Contains(normalized));
            if (matches == 1) return RefOk;
            if (matches > 1) return RefAmbiguous;
            return paramNames != null && paramNames.Contains(normalized) ? RefOk : RefUnknown;
        }

        private static HashSet<string> BarePathsOf(object schema)
        {
            var outList = new List<string>();
            FlattenSchema(schema, "", outList);
            return new HashSet<string>(outList, StringComparer.Ordinal);
        }
    }
}
