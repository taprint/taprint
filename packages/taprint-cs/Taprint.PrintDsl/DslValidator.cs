// SPDX-License-Identifier: Apache-2.0
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Nodes;
using Json.Schema;
using Taprint.PrintDsl.Internal;

// DSL 校验与字段字典。
// JSON Schema 校验：JsonSchema.Net（draft 2020-12，netstandard2.0 资产），schema 由宿主
// 注入（不内嵌资源，与 TS 同口径）。
// ValidateBusiness：表达式文法（ExpressionCompiler）+ 字段绑定（Analysis.ClassifyRef，
// 数据源 → parameters → FieldRegistry 兜底）+ DSL 2.0 cross-path 规则（V1）。
// 错误码与 TS 逐字对齐：bad-expression / unknown-field / ambiguous-field /
// header-cell-span-mismatch / subtotal-values-length / static-row-span-mismatch /
// loop-each-not-detail / subtable-source-not-detail / table-source-unknown（共 9 类）。
namespace Taprint.PrintDsl
{
    /// <summary>
    /// DSL 校验内核。
    /// Validate：JSON Schema 校验（draft 2020-12，schema 宿主注入，JsonSchema.Net）。
    /// ValidateBusiness：表达式文法 + 字段绑定 + V2 cross-path 规则（9 错误码）。
    /// </summary>
    public static class DslValidator
    {
        /// <summary>JSON Schema 校验结果（与 TS ValidationResult 同构）。</summary>
        public sealed class ValidationResult
        {
            /// <summary>是否通过（errors 空时为 true）。</summary>
            public bool Valid { get; }
            /// <summary>错误集合（Valid=true 时为空）。</summary>
            public IReadOnlyList<ValidationError> Errors { get; }
            /// <summary>构造。</summary>
            public ValidationResult(bool valid, IReadOnlyList<ValidationError> errors)
            {
                Valid = valid;
                Errors = errors;
            }
        }

        /// <summary>校验错误（path + code + message 三元组，与 TS ValidationError 同构）。</summary>
        public sealed class ValidationError
        {
            /// <summary>错误位置（JSON path，根为 $）。</summary>
            public string Path { get; }
            /// <summary>错误码（JSON Schema 关键字或 ValidateBusiness 业务码，共 9 类）。</summary>
            public string Code { get; }
            /// <summary>错误描述（含 path + 详情）。</summary>
            public string Message { get; }
            /// <summary>构造。</summary>
            public ValidationError(string path, string code, string message)
            {
                Path = path;
                Code = code;
                Message = message;
            }
        }

        /// <summary>
        /// JSON Schema 校验（draft 2020-12，schema 由宿主注入）。
        /// 入参 schema 为 schema/v1.0.json 或 v2.0.json 反序列化后的 JsonSchema 对象；
        /// 不内嵌资源，与 TS 同口径。dsl 序列化为 JsonElement（JsonSchema.Net 9.x 入参形态）。
        /// </summary>
        public static ValidationResult Validate(object dsl, object schema)
        {
            if (!(schema is JsonSchema js))
            {
                throw new ArgumentException("DslValidator.Validate: schema 必须为 JsonSchema 对象（JsonSchema.Net）");
            }
            // dsl → JsonElement（接受 IDictionary<string,object?> 树 / JsonElement / JsonNode）
            JsonElement instance;
            if (dsl is JsonElement el) instance = el;
            else if (dsl is JsonNode node)
            {
                using var doc = JsonDocument.Parse(node.ToJsonString());
                instance = doc.RootElement.Clone();
            }
            else
            {
                using var doc = JsonDocument.Parse(JsonSerializer.Serialize(dsl));
                instance = doc.RootElement.Clone();
            }

            var options = new EvaluationOptions
            {
                OutputFormat = OutputFormat.List,
                RequireFormatValidation = false,
            };
            var results = js.Evaluate(instance, options);
            if (results.IsValid)
            {
                return new ValidationResult(true, Array.Empty<ValidationError>());
            }
            var errors = new List<ValidationError>();
            foreach (var detail in Flatten(results))
            {
                if (detail.Errors == null) continue;
                foreach (var kv in detail.Errors)
                {
                    var path = detail.InstanceLocation.ToString();
                    if (string.IsNullOrEmpty(path)) path = "$";
                    errors.Add(new ValidationError(path, kv.Key, $"{path} {kv.Value}".Trim()));
                }
            }
            return new ValidationResult(false, errors);
        }

        private static IEnumerable<EvaluationResults> Flatten(EvaluationResults results)
        {
            yield return results;
            foreach (var d in results.Details ?? Enumerable.Empty<EvaluationResults>())
            {
                foreach (var nested in Flatten(d)) yield return nested;
            }
        }

        /// <summary>
        /// 业务规则校验：表达式文法（ExpressionCompiler）+ 字段绑定存在性
        /// （数据源 → parameters → FieldRegistry 兜底）+ V2 cross-path 规则。
        /// </summary>
        public static ValidationResult ValidateBusiness(object dsl, FieldRegistry? fieldRegistry = null)
        {
            var registry = fieldRegistry ?? FieldRegistry.Default;
            var sources = Analysis.DataSourcesOf(dsl);
            var paramNames = Analysis.ParamNamesOf(dsl);

            string bizType = "";
            if (dsl is IDictionary<string, object?> rootDict && rootDict.TryGetValue("code", out var codeObj) && codeObj is string c)
            {
                bizType = c;
            }
            var registered = new HashSet<string>(registry.Lookup(bizType).Select(f => f.Code), StringComparer.Ordinal);

            var errors = new List<ValidationError>();
            foreach (var occ in Analysis.ExpressionsOf(dsl))
            {
                ExpressionAst ast;
                try
                {
                    ast = ExpressionCompiler.Compile(occ.Ref);
                }
                catch (Exception e)
                {
                    errors.Add(new ValidationError(occ.Path, "bad-expression", $"表达式不合法：{occ.Raw}（{e.Message}）"));
                    continue;
                }
                foreach (var reference in ExpressionCompiler.ExtractFields(ast))
                {
                    var verdict = Analysis.ClassifyRef(reference, sources, paramNames);
                    if (verdict == Analysis.RefAmbiguous)
                    {
                        errors.Add(new ValidationError(occ.Path, "ambiguous-field", $"字段引用 {reference} 在多个数据源中存在，须加源前缀消歧"));
                        continue;
                    }
                    if (verdict == Analysis.RefUnknown && !registered.Contains(reference))
                    {
                        errors.Add(new ValidationError(occ.Path, "unknown-field", $"表达式引用了未定义字段：{reference}"));
                    }
                }
            }
            ValidateV2Shapes(dsl, sources, errors);
            return new ValidationResult(errors.Count == 0, errors);
        }

        // ---------- DSL 2.0 cross-path 规则 ----------

        private static void ValidateV2Shapes(object dsl, IReadOnlyList<DataSourceInfo> sources, List<ValidationError> errors)
        {
            if (!(dsl is IDictionary<string, object?> root) ||
                !(root.TryGetValue("presentations", out var presObj) && presObj is IDictionary<string, object?> pres) ||
                !(pres.TryGetValue("doc", out var docObj) && docObj is IDictionary<string, object?> doc))
            {
                return;
            }
            foreach (var section in new[] { "header", "body", "footer" })
            {
                if (doc.TryGetValue(section, out var elemsObj) && elemsObj is IList<object?> elems)
                {
                    WalkFlowElements(elems, $"presentations.doc.{section}", sources, errors);
                }
            }
        }

        private static void WalkFlowElements(IList<object?> elems, string basePath, IReadOnlyList<DataSourceInfo> sources, List<ValidationError> errors)
        {
            for (var i = 0; i < elems.Count; i++)
            {
                if (!(elems[i] is IDictionary<string, object?> el)) continue;
                var path = $"{basePath}[{i}]";
                if (el.TryGetValue("type", out var typeObj) && typeObj is string type)
                {
                    if (type == "table") { ValidateTableShape(el, path, sources, errors); continue; }
                    if (type == "loop")
                    {
                        if (el.TryGetValue("each", out var eachObj) && eachObj is string each)
                        {
                            var src = sources.FirstOrDefault(s => s.Name == each);
                            if (src == null || src.Type != "detail")
                            {
                                errors.Add(new ValidationError($"{path}.each", "loop-each-not-detail", $"loop.each \"{each}\" 必须引用 type=detail 的数据源（行集合语义）"));
                            }
                        }
                        if (el.TryGetValue("body", out var bodyObj) && bodyObj is IList<object?> body)
                        {
                            WalkFlowElements(body, $"{path}.body", sources, errors);
                        }
                        continue;
                    }
                    if (type == "conditional")
                    {
                        if (el.TryGetValue("body", out var bodyObj) && bodyObj is IList<object?> body)
                        {
                            WalkFlowElements(body, $"{path}.body", sources, errors);
                        }
                        if (el.TryGetValue("elseBody", out var elseObj) && elseObj is IList<object?> elseBody)
                        {
                            WalkFlowElements(elseBody, $"{path}.elseBody", sources, errors);
                        }
                    }
                }
            }
        }

        private static void ValidateTableShape(IDictionary<string, object?> el, string path, IReadOnlyList<DataSourceInfo> sources, List<ValidationError> errors)
        {
            // 引用完整性（二轮）：table.source 拼错不得拖到渲染期才暴露
            if (el.TryGetValue("source", out var srcObj) && srcObj is string source && !sources.Any(s => s.Name == source))
            {
                errors.Add(new ValidationError($"{path}.source", "table-source-unknown", $"table.source \"{source}\" 未定义于 dataSources"));
            }

            var columns = el.TryGetValue("columns", out var colsObj) && colsObj is IList<object?> colsList
                ? colsList.Cast<IDictionary<string, object?>>().ToList()
                : null;
            var headerRows = el.TryGetValue("headerRows", out var hrObj) && hrObj is IList<object?> hrList
                ? hrList.Cast<IList<object?>>().ToList()
                : null;

            int? width = columns?.Count;
            if (width == null && headerRows != null && headerRows.Count > 0)
            {
                width = SpanSum(headerRows[0]);
            }

            if (headerRows != null && width.HasValue && width.Value > 0)
            {
                var w = width.Value;
                var occupied = new bool[headerRows.Count][];
                for (var i = 0; i < occupied.Length; i++) occupied[i] = new bool[w];

                for (var r = 0; r < headerRows.Count; r++)
                {
                    var row = headerRows[r];
                    var c = 0;
                    foreach (var cellRaw in row)
                    {
                        while (c < w && occupied[r][c]) c++;
                        var cell = (cellRaw as IDictionary<string, object?>) ?? new Dictionary<string, object?>();
                        var colspan = PositiveInt(cell, "colspan");
                        var rowspan = PositiveInt(cell, "rowspan");
                        var overflow = c + colspan > w || r + rowspan > headerRows.Count;
                        var collide = false;
                        if (!overflow)
                        {
                            for (var rr = r; rr < r + rowspan && !collide; rr++)
                            {
                                for (var cc = c; cc < c + colspan; cc++)
                                {
                                    if (occupied[rr][cc]) { collide = true; break; }
                                }
                            }
                        }
                        if (overflow || collide)
                        {
                            errors.Add(new ValidationError($"{path}.headerRows[{r}]", "header-cell-span-mismatch",
                                $"表头单元格（colspan={colspan}, rowspan={rowspan}）{(overflow ? "超出表格边界" : "与其他单元格重叠")}（表头网格宽 {w} 列 × {headerRows.Count} 行）"));
                        }
                        else
                        {
                            for (var rr = r; rr < r + rowspan; rr++)
                            {
                                for (var cc = c; cc < c + colspan; cc++) occupied[rr][cc] = true;
                            }
                        }
                        c += colspan;
                    }
                    if (!occupied[r].All(b => b))
                    {
                        errors.Add(new ValidationError($"{path}.headerRows[{r}]", "header-cell-span-mismatch",
                            $"表头第 {r + 1} 行未填满 {w} 列（含上方 rowspan 占位）"));
                    }
                }
            }

            if (el.TryGetValue("groups", out var groupsObj) && groupsObj is IList<object?> groupsList)
            {
                for (var gi = 0; gi < groupsList.Count; gi++)
                {
                    if (!(groupsList[gi] is IDictionary<string, object?> g)) continue;
                    if (g.TryGetValue("subtotal", out var subObj) && subObj is IDictionary<string, object?> subtotal &&
                        subtotal.TryGetValue("values", out var valsObj) && valsObj is IList<object?> values &&
                        width.HasValue && values.Count != width.Value)
                    {
                        errors.Add(new ValidationError($"{path}.groups[{gi}].subtotal.values", "subtotal-values-length",
                            $"分组小计 values 长度 {values.Count} ≠ 表格列数 {width.Value}（须逐列对齐，null 留空）"));
                    }
                }
            }

            if (el.TryGetValue("staticRows", out var srObj) && srObj is IDictionary<string, object?> staticRows &&
                staticRows.TryGetValue("rows", out var srowsObj) && srowsObj is IList<object?> rows)
            {
                var rowsList = rows.Cast<IList<object?>>().ToList();
                for (var ri = 0; ri < rowsList.Count; ri++)
                {
                    var row = rowsList[ri];
                    var span = SpanSum(row);
                    if (width.HasValue && span != width.Value)
                    {
                        errors.Add(new ValidationError($"{path}.staticRows.rows[{ri}]", "static-row-span-mismatch",
                            $"staticRows 第 {ri + 1} 行 colspan 合计 {span} ≠ 表格列数 {width.Value}"));
                    }
                    foreach (var cellRaw in row)
                    {
                        var rowspan = PositiveInt(cellRaw as IDictionary<string, object?>, "rowspan");
                        if (ri + rowspan > rowsList.Count)
                        {
                            errors.Add(new ValidationError($"{path}.staticRows.rows[{ri}]", "static-row-span-mismatch",
                                $"staticRows 第 {ri + 1} 行 rowspan={rowspan} 超出 staticRows 行数 {rowsList.Count}"));
                            break;
                        }
                    }
                }
            }

            if (columns != null)
            {
                for (var ci = 0; ci < columns.Count; ci++)
                {
                    ValidateSubtableSource(columns[ci], $"{path}.columns[{ci}]", sources, errors);
                }
            }
        }

        private static void ValidateSubtableSource(IDictionary<string, object?>? col, string path, IReadOnlyList<DataSourceInfo> sources, List<ValidationError> errors)
        {
            if (col == null) return;
            if (col.TryGetValue("subtable", out var stObj) && stObj is IDictionary<string, object?> subtable)
            {
                if (subtable.TryGetValue("source", out var sObj) && sObj is string s)
                {
                    var src = sources.FirstOrDefault(ds => ds.Name == s);
                    if (src == null || src.Type != "detail")
                    {
                        errors.Add(new ValidationError($"{path}.subtable.source", "subtable-source-not-detail",
                            $"subtable.source \"{s}\" 必须引用 type=detail 的数据源（主从行展开语义）"));
                    }
                }
                if (subtable.TryGetValue("columns", out var colsObj) && colsObj is IList<object?> cols)
                {
                    for (var ci = 0; ci < cols.Count; ci++)
                    {
                        ValidateSubtableSource(cols[ci] as IDictionary<string, object?>, $"{path}.subtable.columns[{ci}]", sources, errors);
                    }
                }
            }
        }

        /// <summary>单元格占位跨度（默认 1；非正整数视为 1，schema 层已校 ≥1）。</summary>
        private static int PositiveInt(IDictionary<string, object?>? cell, string field)
        {
            if (cell != null && cell.TryGetValue(field, out var v) && v is int i && i > 0) return i;
            if (cell != null && cell.TryGetValue(field, out var v2) && v2 is long l && l > 0 && l <= int.MaxValue) return (int)l;
            if (cell != null && cell.TryGetValue(field, out var v3) && v3 is double d && Math.Truncate(d) == d && d > 0 && d <= int.MaxValue) return (int)d;
            return 1;
        }

        /// <summary>一行单元格 colspan 合计。</summary>
        private static int SpanSum(IList<object?> row)
        {
            var sum = 0;
            foreach (var cellRaw in row)
            {
                sum += PositiveInt(cellRaw as IDictionary<string, object?>, "colspan");
            }
            return sum;
        }
    }

    /// <summary>字段定义。</summary>
    public sealed class FieldDef
    {
        /// <summary>字段代码（表达式引用键）。</summary>
        public string Code { get; }
        /// <summary>显示名（字段面板用）。</summary>
        public string Name { get; }
        /// <summary>数据类型（string/number/integer/boolean/date/datetime/enum）。</summary>
        public string DataType { get; }
        /// <summary>可选：派生表达式（如服务端预算字段）。</summary>
        public string? Expression { get; }

        /// <summary>构造。</summary>
        public FieldDef(string code, string name, string dataType, string? expression = null)
        {
            Code = code;
            Name = name;
            DataType = dataType;
            Expression = expression;
        }
    }

    /// <summary>
    /// 字段注册表。
    /// Register 覆写该 bizType 的字段集；Lookup 返回防御性拷贝。Default 单例供 ValidateBusiness 默认参数。
    /// </summary>
    public class FieldRegistry
    {
        private static readonly Lazy<FieldRegistry> _default = new Lazy<FieldRegistry>(() => new FieldRegistry());
        /// <summary>默认单例（ValidateBusiness 不传 registry 时用）。</summary>
        public static FieldRegistry Default => _default.Value;

        private readonly ConcurrentDictionary<string, List<FieldDef>> _store = new ConcurrentDictionary<string, List<FieldDef>>();

        /// <summary>注册字段（业务模块启动时调用；重复注册覆写）。</summary>
        public void Register(string bizType, IEnumerable<FieldDef> fields)
        {
            if (string.IsNullOrEmpty(bizType)) throw new ArgumentException("FieldRegistry.Register: bizType 不能为空");
            if (fields == null) throw new ArgumentException("FieldRegistry.Register: fields 不能为 null");
            _store[bizType] = fields.Select(f => new FieldDef(f.Code, f.Name, f.DataType, f.Expression)).ToList();
        }

        /// <summary>查询字段（未注册的 bizType 返回空数组；返回防御性拷贝）。</summary>
        public IReadOnlyList<FieldDef> Lookup(string bizType)
        {
            return _store.TryGetValue(bizType, out var list)
                ? list.Select(f => new FieldDef(f.Code, f.Name, f.DataType, f.Expression)).ToList()
                : Array.Empty<FieldDef>();
        }

        /// <summary>清空全部注册（测试隔离 / 宿主生命周期用）。</summary>
        public void Clear() => _store.Clear();
    }
}
