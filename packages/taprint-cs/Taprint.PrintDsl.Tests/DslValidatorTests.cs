// SPDX-License-Identifier: Apache-2.0
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Nodes;
using Json.Schema;
using Taprint.PrintDsl.Internal;
using Xunit;
using SCV = Taprint.PrintDsl;
using static Taprint.PrintDsl.DslValidator;

// DslValidator 测试（与 print-dsl-ts validator.spec.ts 同构移植）：
// - JSON Schema：12 业务 fixture 通过 v1.0 / v2 fixture 通过 v2.0 / 13 负例被拒
// - ValidateBusiness：表达式文法 + 字段绑定 + V2 cross-path 9 错误码 + FieldRegistry
// 仓根 schema/ + fixtures/templates + fixtures/negative 为多语言实现共享真值（RepoPaths 解析）。
namespace Taprint.PrintDsl.Tests
{
    public class DslValidatorTests
    {
        private static readonly JsonSchema SchemaV1 = TestSchemas.V1;
        private static readonly JsonSchema SchemaV2 = TestSchemas.V2;

        private static object ReadFixture(string file) =>
            RepoPaths.ReadJsonTree($"fixtures/templates/{file}") ?? throw new InvalidOperationException("fixture null");

        private static IDictionary<string, object?> CloneSalesNote()
        {
            var json = JsonSerializer.Serialize(ReadFixture("sales-note-v1.0.json"));
            using var doc = JsonDocument.Parse(json);
            return (IDictionary<string, object?>)JsonTree.ToTree(doc.RootElement)!;
        }

        private static string PatchFirstBodyContent(IDictionary<string, object?> dsl, string content)
        {
            var pres = (IDictionary<string, object?>)dsl["presentations"]!;
            var doc = (IDictionary<string, object?>)pres["doc"]!;
            var body = (IList<object?>)doc["body"]!;
            var first = (IDictionary<string, object?>)body[0]!;
            first["content"] = content;
            return "presentations.doc.body[0].content";
        }

        // ---------- JSON Schema 校验 ----------

        [Fact]
        public void Validate_12个业务fixture全部通过v1_schema()
        {
            var bizFiles = Directory.GetFiles(Path.Combine(RepoPaths.Root, "fixtures", "templates"))
                .Select(Path.GetFileName)
                .Where(f => f != null && f.EndsWith("-v1.0.json"))
                .Cast<string>()
                .OrderBy(f => f)
                .ToList();
            Assert.True(bizFiles.Count >= 10, $"业务 fixture 数 {bizFiles.Count} < 10");
            foreach (var file in bizFiles)
            {
                var result = SCV.DslValidator.Validate(ReadFixture(file), SchemaV1);
                Assert.True(result.Valid, $"{file}: {string.Join("; ", result.Errors.Select(e => e.Message))}");
                Assert.Empty(result.Errors);
            }
        }

        [Fact]
        public void Validate_v2中国式报表fixture全部通过v2_schema()
        {
            var bizFilesV2 = Directory.GetFiles(Path.Combine(RepoPaths.Root, "fixtures", "templates"))
                .Select(Path.GetFileName)
                .Where(f => f != null && f.EndsWith("-v2.0.json"))
                .Cast<string>()
                .OrderBy(f => f)
                .ToList();
            Assert.True(bizFilesV2.Count >= 2, $"v2 fixture 数 {bizFilesV2.Count} < 2");
            foreach (var file in bizFilesV2)
            {
                var result = SCV.DslValidator.Validate(ReadFixture(file), SchemaV2);
                Assert.True(result.Valid, $"{file}: {string.Join("; ", result.Errors.Select(e => e.Message))}");
            }
        }

        [Fact]
        public void Validate_v2fixture不允许被v1_schema误收_schemaVersion_pattern分轨()
        {
            var bizFilesV2 = Directory.GetFiles(Path.Combine(RepoPaths.Root, "fixtures", "templates"))
                .Select(Path.GetFileName)
                .Where(f => f != null && f.EndsWith("-v2.0.json"))
                .Cast<string>()
                .ToList();
            foreach (var file in bizFilesV2)
            {
                var result = SCV.DslValidator.Validate(ReadFixture(file), SchemaV1);
                Assert.False(result.Valid, $"{file} 应被 v1 schema 拒（schemaVersion pattern 不匹配）");
            }
        }

        [Fact]
        public void Validate_全部负例被拒且错误带path_code_message()
        {
            var negativeFiles = Directory.GetFiles(Path.Combine(RepoPaths.Root, "fixtures", "negative"))
                .Select(Path.GetFileName)
                .Where(f => f != null && f.EndsWith(".invalid.json"))
                .Cast<string>()
                .OrderBy(f => f)
                .ToList();
            Assert.True(negativeFiles.Count >= 13, $"负例数 {negativeFiles.Count} < 13");
            foreach (var file in negativeFiles)
            {
                var json = File.ReadAllText(Path.Combine(RepoPaths.Root, "fixtures", "negative", file));
                var instance = JsonNode.Parse(json);
                var targetSchema = file.Contains("-v2") ? SchemaV2 : SchemaV1;
                var result = SCV.DslValidator.Validate(instance!, targetSchema);
                Assert.False(result.Valid, $"{file} 应被拒");
                Assert.True(result.Errors.Count > 0, $"{file} 应有错误");
                foreach (var e in result.Errors)
                {
                    // path 总非空（根为 $）；message 总非空；code 可为空（JsonSchema.Net enum 等关键字
                    // 输出的 Errors 字典 key 取决于关键字实现，不强约束）
                    Assert.True(!string.IsNullOrEmpty(e.Path), $"{file}: path 空");
                    Assert.True(!string.IsNullOrEmpty(e.Message), $"{file}: message 空");
                }
            }
        }

        // ---------- ValidateBusiness ----------

        [Fact]
        public void ValidateBusiness_salesNote全部表达式可解析()
        {
            Assert.True(SCV.DslValidator.ValidateBusiness(CloneSalesNote()).Valid);
        }

        [Fact]
        public void ValidateBusiness_parameters运行时参数可被表达式引用()
        {
            var dsl = CloneSalesNote();
            PatchFirstBodyContent(dsl, "打印份数：{{copies}} / 打印机：{{printer}}");
            Assert.True(SCV.DslValidator.ValidateBusiness(dsl).Valid);
        }

        [Fact]
        public void ValidateBusiness_未定义字段引用报unknown_field且定位到JSON_path()
        {
            var dsl = CloneSalesNote();
            var at = PatchFirstBodyContent(dsl, "前缀 {{noSuchField}} 后缀");
            var result = SCV.DslValidator.ValidateBusiness(dsl);
            Assert.False(result.Valid);
            var err = result.Errors.FirstOrDefault(e => e.Code == "unknown-field");
            Assert.NotNull(err);
            Assert.Equal(at, err!.Path);
            Assert.Contains("noSuchField", err.Message);
        }

        [Fact]
        public void ValidateBusiness_非法字段引用文法报bad_expression()
        {
            var dsl = CloneSalesNote();
            PatchFirstBodyContent(dsl, "{{1abc}}");
            var result = SCV.DslValidator.ValidateBusiness(dsl);
            Assert.Contains("bad-expression", result.Errors.Select(e => e.Code));
        }

        [Fact]
        public void ValidateBusiness_数组索引引用合法_通配符仍拒绝()
        {
            var dsl = CloneSalesNote();
            PatchFirstBodyContent(dsl, "{{items[0].sku}}");
            Assert.True(SCV.DslValidator.ValidateBusiness(dsl).Valid);
            var wildcard = CloneSalesNote();
            PatchFirstBodyContent(wildcard, "{{items[*].sku}}");
            Assert.Contains("bad-expression", SCV.DslValidator.ValidateBusiness(wildcard).Errors.Select(e => e.Code));
        }

        [Fact]
        public void ValidateBusiness_A3多数据源同名裸路径报ambiguous_field()
        {
            var dsl = new Dictionary<string, object?>
            {
                ["schemaVersion"] = "1.0",
                ["id"] = "test_ambiguous",
                ["code"] = "TEST_AMBIGUOUS",
                ["name"] = "多源歧义",
                ["dataSources"] = new List<object?>
                {
                    new Dictionary<string, object?> { ["name"] = "customer", ["type"] = "primary", ["schema"] = new Dictionary<string, object?> { ["name"] = "string" } },
                    new Dictionary<string, object?> { ["name"] = "store", ["type"] = "primary", ["schema"] = new Dictionary<string, object?> { ["name"] = "string" } },
                },
                ["presentations"] = new Dictionary<string, object?>
                {
                    ["doc"] = new Dictionary<string, object?>
                    {
                        ["body"] = new List<object?>
                        {
                            new Dictionary<string, object?> { ["type"] = "text", ["content"] = "{{name}}" },
                        },
                    },
                },
            };
            var result = SCV.DslValidator.ValidateBusiness(dsl);
            Assert.False(result.Valid);
            Assert.Equal("ambiguous-field", result.Errors[0].Code);
            // 源前缀消歧后通过
            var pres2 = (IDictionary<string, object?>)dsl["presentations"]!;
            var doc2 = (IDictionary<string, object?>)pres2["doc"]!;
            var body2 = (IList<object?>)doc2["body"]!;
            var first2 = (IDictionary<string, object?>)body2[0]!;
            first2["content"] = "{{customer.name}}";
            Assert.True(SCV.DslValidator.ValidateBusiness(dsl).Valid);
        }

        [Fact]
        public void ValidateBusiness_FieldRegistry注册字段可作兜底字典()
        {
            var dsl = CloneSalesNote();
            PatchFirstBodyContent(dsl, "{{extField}}");
            Assert.False(SCV.DslValidator.ValidateBusiness(dsl).Valid);
            var registry = new SCV.FieldRegistry();
            registry.Register("SALES_NOTE", new[] { new SCV.FieldDef("extField", "扩展字段", "string") });
            Assert.True(SCV.DslValidator.ValidateBusiness(dsl, registry).Valid);
        }

        [Fact]
        public void ValidateBusiness_全fixture业务校验通过_债务台账为空()
        {
            // 与 TS EXPRESSION_DEBT_LEDGER 等价：所有业务 fixture（v1+v2）的 validateBusiness
            // 应无错误（ExpressionCompiler v1.41 落地后债务清零）。
            var allBizFiles = Directory.GetFiles(Path.Combine(RepoPaths.Root, "fixtures", "templates"))
                .Select(Path.GetFileName)
                .Where(f => f != null && (f.EndsWith("-v1.0.json") || f.EndsWith("-v2.0.json")))
                .Cast<string>()
                .OrderBy(f => f)
                .ToList();
            var actual = new List<(string file, string path, string code)>();
            foreach (var file in allBizFiles)
            {
                var result = SCV.DslValidator.ValidateBusiness(ReadFixture(file));
                foreach (var e in result.Errors)
                {
                    actual.Add((file, e.Path, e.Code));
                }
            }
            Assert.Empty(actual);
        }

        // ---------- V2 cross-path 规则 ----------

        private static IDictionary<string, object?> V2Dsl(Dictionary<string, object?> table)
        {
            return new Dictionary<string, object?>
            {
                ["schemaVersion"] = "2.0",
                ["id"] = "v2_shape_test",
                ["code"] = "TEST_V2_SHAPE",
                ["name"] = "v2 结构校验",
                ["dataSources"] = new List<object?>
                {
                    new Dictionary<string, object?> { ["name"] = "main", ["type"] = "primary", ["schema"] = new Dictionary<string, object?> { ["billNo"] = "string" } },
                    new Dictionary<string, object?> { ["name"] = "items", ["type"] = "detail", ["schema"] = new Dictionary<string, object?> { ["sku"] = "string", ["qty"] = "number" } },
                },
                ["presentations"] = new Dictionary<string, object?>
                {
                    ["doc"] = new Dictionary<string, object?>
                    {
                        ["body"] = new List<object?> { table },
                    },
                },
            };
        }

        private static List<string> CodesOf(IDictionary<string, object?> dsl) =>
            SCV.DslValidator.ValidateBusiness(dsl).Errors.Select(e => e.Code).ToList();

        [Fact]
        public void CrossPath_表头colspan越界报header_cell_span_mismatch()
        {
            var dsl = V2Dsl(new Dictionary<string, object?>
            {
                ["type"] = "table",
                ["source"] = "items",
                ["columns"] = new List<object?>
                {
                    new Dictionary<string, object?> { ["header"] = "A", ["field"] = "sku" },
                    new Dictionary<string, object?> { ["header"] = "B", ["field"] = "qty" },
                },
                ["headerRows"] = new List<object?>
                {
                    new List<object?> { new Dictionary<string, object?> { ["text"] = "A", ["colspan"] = 99 } },
                },
            });
            var result = SCV.DslValidator.ValidateBusiness(dsl);
            Assert.Contains("header-cell-span-mismatch", result.Errors.Select(e => e.Code));
            Assert.Equal("presentations.doc.body[0].headerRows[0]", result.Errors[0].Path);
        }

        [Fact]
        public void CrossPath_表头rowspan越界与未填满同样拒绝_合法网格通过()
        {
            var overflow = V2Dsl(new Dictionary<string, object?>
            {
                ["type"] = "table",
                ["columns"] = new List<object?>
                {
                    new Dictionary<string, object?> { ["header"] = "A", ["field"] = "sku" },
                    new Dictionary<string, object?> { ["header"] = "B", ["field"] = "qty" },
                },
                ["headerRows"] = new List<object?>
                {
                    new List<object?>
                    {
                        new Dictionary<string, object?> { ["text"] = "A", ["rowspan"] = 2 },
                        new Dictionary<string, object?> { ["text"] = "B" },
                    },
                },
            });
            Assert.Contains("header-cell-span-mismatch", CodesOf(overflow));

            var ok = V2Dsl(new Dictionary<string, object?>
            {
                ["type"] = "table",
                ["columns"] = new List<object?>
                {
                    new Dictionary<string, object?> { ["header"] = "A", ["field"] = "sku" },
                    new Dictionary<string, object?> { ["header"] = "B", ["field"] = "qty" },
                    new Dictionary<string, object?> { ["header"] = "C", ["field"] = "qty" },
                },
                ["headerRows"] = new List<object?>
                {
                    new List<object?>
                    {
                        new Dictionary<string, object?> { ["text"] = "左", ["rowspan"] = 2 },
                        new Dictionary<string, object?> { ["text"] = "右组", ["colspan"] = 2 },
                    },
                    new List<object?>
                    {
                        new Dictionary<string, object?> { ["text"] = "B" },
                        new Dictionary<string, object?> { ["text"] = "C" },
                    },
                },
            });
            Assert.Empty(CodesOf(ok));
        }

        [Fact]
        public void CrossPath_分组小计values长度不等于列数报subtotal_values_length()
        {
            var dsl = V2Dsl(new Dictionary<string, object?>
            {
                ["type"] = "table",
                ["columns"] = new List<object?>
                {
                    new Dictionary<string, object?> { ["header"] = "A", ["field"] = "sku" },
                    new Dictionary<string, object?> { ["header"] = "B", ["field"] = "qty" },
                },
                ["groups"] = new List<object?>
                {
                    new Dictionary<string, object?>
                    {
                        ["field"] = "sku",
                        ["subtotal"] = new Dictionary<string, object?> { ["values"] = new List<object?> { null } },
                    },
                },
            });
            var result = SCV.DslValidator.ValidateBusiness(dsl);
            Assert.Contains("subtotal-values-length", result.Errors.Select(e => e.Code));
            Assert.Equal("presentations.doc.body[0].groups[0].subtotal.values", result.Errors[0].Path);
        }

        [Fact]
        public void CrossPath_staticRows行colspan合计不等于列数报static_row_span_mismatch()
        {
            var dsl = V2Dsl(new Dictionary<string, object?>
            {
                ["type"] = "table",
                ["columns"] = new List<object?>
                {
                    new Dictionary<string, object?> { ["header"] = "A", ["field"] = "sku" },
                    new Dictionary<string, object?> { ["header"] = "B", ["field"] = "qty" },
                },
                ["staticRows"] = new Dictionary<string, object?>
                {
                    ["position"] = "after",
                    ["rows"] = new List<object?>
                    {
                        new List<object?>
                        {
                            new Dictionary<string, object?> { ["value"] = "签栏", ["colspan"] = 3 },
                        },
                    },
                },
            });
            Assert.Contains("static-row-span-mismatch", CodesOf(dsl));
        }

        [Fact]
        public void CrossPath_tableSource未定义报table_source_unknown()
        {
            Assert.Contains("table-source-unknown", CodesOf(V2Dsl(new Dictionary<string, object?>
            {
                ["type"] = "table", ["source"] = "ghost",
                ["columns"] = new List<object?> { new Dictionary<string, object?> { ["header"] = "A", ["field"] = "sku" } },
            })));
            Assert.Empty(CodesOf(V2Dsl(new Dictionary<string, object?>
            {
                ["type"] = "table", ["source"] = "items",
                ["columns"] = new List<object?> { new Dictionary<string, object?> { ["header"] = "A", ["field"] = "sku" } },
            })));
        }

        [Fact]
        public void CrossPath_loopEach必须引用detail源()
        {
            Assert.Contains("loop-each-not-detail", CodesOf(V2Dsl(new Dictionary<string, object?>
            {
                ["type"] = "loop", ["each"] = "main", ["body"] = new List<object?>(),
            })));
            Assert.Contains("loop-each-not-detail", CodesOf(V2Dsl(new Dictionary<string, object?>
            {
                ["type"] = "loop", ["each"] = "ghost", ["body"] = new List<object?>(),
            })));
            Assert.Empty(CodesOf(V2Dsl(new Dictionary<string, object?>
            {
                ["type"] = "loop", ["each"] = "items", ["body"] = new List<object?>(),
            })));
        }

        [Fact]
        public void CrossPath_subtableSource必须引用detail源_递归同校()
        {
            var dsl = V2Dsl(new Dictionary<string, object?>
            {
                ["type"] = "table",
                ["columns"] = new List<object?>
                {
                    new Dictionary<string, object?>
                    {
                        ["header"] = "嵌套",
                        ["subtable"] = new Dictionary<string, object?>
                        {
                            ["source"] = "items",
                            ["columns"] = new List<object?>
                            {
                                new Dictionary<string, object?>
                                {
                                    ["header"] = "错",
                                    ["subtable"] = new Dictionary<string, object?>
                                    {
                                        ["source"] = "main",
                                        ["columns"] = new List<object?>(),
                                    },
                                },
                            },
                        },
                    },
                },
            });
            var result = SCV.DslValidator.ValidateBusiness(dsl);
            Assert.Contains("subtable-source-not-detail", result.Errors.Select(e => e.Code));
            Assert.Equal("presentations.doc.body[0].columns[0].subtable.columns[0].subtable.source", result.Errors[0].Path);
        }

        // ---------- FieldRegistry ----------

        [Fact]
        public void FieldRegistry_未注册返回空数组_注册后可查()
        {
            var registry = new SCV.FieldRegistry();
            Assert.Empty(registry.Lookup("NOPE"));
            registry.Register("SALES_NOTE", new[] { new SCV.FieldDef("billNo", "单号", "string") });
            var fields = registry.Lookup("SALES_NOTE");
            Assert.Single(fields);
            Assert.Equal("billNo", fields[0].Code);
            Assert.Equal("单号", fields[0].Name);
            Assert.Equal("string", fields[0].DataType);
        }

        [Fact]
        public void FieldRegistry_注册查询均为防御性拷贝()
        {
            var registry = new SCV.FieldRegistry();
            var fields = new[] { new SCV.FieldDef("a", "A", "string") };
            registry.Register("BIZ", fields);
            fields[0] = new SCV.FieldDef("hacked", "h", "x");  // 外部修改不影响
            Assert.Equal("a", registry.Lookup("BIZ")[0].Code);
        }

        [Fact]
        public void FieldRegistry_重复注册覆写_非法入参抛错()
        {
            var registry = new SCV.FieldRegistry();
            registry.Register("BIZ", new[] { new SCV.FieldDef("a", "A", "string") });
            registry.Register("BIZ", new[] { new SCV.FieldDef("b", "B", "number") });
            Assert.Equal("b", registry.Lookup("BIZ")[0].Code);
            Assert.Throws<ArgumentException>(() => registry.Register("", Array.Empty<SCV.FieldDef>()));
            Assert.Throws<ArgumentException>(() => registry.Register("BIZ", null!));
        }
    }
}
