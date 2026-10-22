// SPDX-License-Identifier: Apache-2.0
using System;
using System.Collections.Generic;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using Xunit;

// DslParser C# 端等价测试（print-dsl-ts parser.spec.ts 的 parse/stringify/hash 部分逐锚移植；
// parseResult 锚点归轮 3——依赖 DslValidator）。 多语言实现一致性：hash 为最硬跨端断言。
namespace Taprint.PrintDsl.Tests
{
    public class DslParserTests
    {
        private static IDictionary<string, object?> SalesNote() =>
            DslParser.Parse(RepoPaths.ReadText("fixtures/templates/sales-note-v1.0.json"));

        // ---------- DslParser.Parse（Phase 1-A） ----------

        [Fact]
        public void 解析业务fixture且保留全部顶层字段()
        {
            var dsl = SalesNote();
            Assert.Equal("SALES_NOTE", dsl["code"]);
            Assert.Equal("1.0", dsl["schemaVersion"]);
            Assert.IsAssignableFrom<IList<object?>>(dsl["dataSources"]);
        }

        [Fact]
        public void 容忍BOM前缀()
        {
            var dsl = DslParser.Parse("\uFEFF{\"schemaVersion\":\"1.0\"}");
            Assert.Equal("1.0", dsl["schemaVersion"]);
        }

        [Fact]
        public void 非法JSON抛FormatException_非对象顶层抛ArgumentException()
        {
            Assert.Throws<FormatException>(() => DslParser.Parse("{oops"));
            Assert.Throws<ArgumentException>(() => DslParser.Parse("[1,2]"));
            Assert.Throws<ArgumentException>(() => DslParser.Parse("null"));
            Assert.Throws<ArgumentException>(() => DslParser.Parse("\"str\""));
        }

        // ---------- DslParser.Stringify / Hash（规范化口径锁定） ----------

        [Fact]
        public void stringify与key插入顺序无关_全深度key字典序()
        {
            var a = new Dictionary<string, object?>
            {
                ["b"] = 1.0,
                ["a"] = new Dictionary<string, object?>
                {
                    ["d"] = 2.0,
                    ["c"] = new List<object?>
                    {
                        new Dictionary<string, object?> { ["f"] = 4.0, ["e"] = 5.0 },
                    },
                },
            };
            var b = new Dictionary<string, object?>
            {
                ["a"] = new Dictionary<string, object?>
                {
                    ["c"] = new List<object?>
                    {
                        new Dictionary<string, object?> { ["e"] = 5.0, ["f"] = 4.0 },
                    },
                    ["d"] = 2.0,
                },
                ["b"] = 1.0,
            };
            Assert.Equal(DslParser.Stringify(b), DslParser.Stringify(a));
            Assert.Equal("{\"a\":{\"c\":[{\"e\":5,\"f\":4}],\"d\":2},\"b\":1}", DslParser.Stringify(a));
        }

        [Fact]
        public void stringify拒绝循环引用_异常而非栈溢出()
        {
            var cyclic = new Dictionary<string, object?>();
            cyclic["self"] = cyclic;
            var ex = Assert.Throws<ArgumentException>(() => DslParser.Stringify(cyclic));
            Assert.Contains("循环引用", ex.Message);
        }

        [Fact]
        public void hash形如sha256_64hex_确定性且独立复算一致()
        {
            var dsl = SalesNote();
            var hash = DslParser.Hash(dsl);
            Assert.Matches(new Regex("^sha256:[0-9a-f]{64}$"), hash);
            Assert.Equal(hash, DslParser.Hash(dsl));
            using var sha = SHA256.Create();
            var independent = "sha256:" + BitConverter.ToString(
                sha.ComputeHash(Encoding.UTF8.GetBytes(DslParser.Stringify(dsl))))
                .Replace("-", "").ToLowerInvariant();
            Assert.Equal(independent, hash);
        }

        [Fact]
        public void 内容不同hash必不同()
        {
            var dsl = SalesNote();
            var altered = new Dictionary<string, object?>(dsl) { ["name"] = dsl["name"] + "-改" };
            Assert.NotEqual(DslParser.Hash(dsl), DslParser.Hash(altered));
        }

        // ---------- parseResult ----------

        [Fact]
        public void ParseResult_sales_note锚点逐字一致()
        {
            var dsl = SalesNote();
            var expected = (IDictionary<string, object?>)RepoPaths.ExpectedJson("sales-note-parse-result.json")!;
            var result = DslParser.GetParseResult(dsl, TestSchemas.V1);
            Assert.Equal((string)expected["hash"]!, result.Hash);
            Assert.Equal((long)(double)expected["expressionCount"]!, result.ExpressionCount);
            Assert.Equal((bool)expected["valid"]!, result.Valid);
            var expectedPaths = ((IList<object?>)expected["fieldPaths"]!).Cast<string>().ToList();
            Assert.Equal(expectedPaths, result.FieldPaths);
        }

        [Fact]
        public void ParseResult_inventory_report_v2_0锚点逐字一致()
        {
            ParseResultAnchor("inventory-report-v2.0.json", "inventory-report-parse-result.json", TestSchemas.V2);
        }

        [Fact]
        public void ParseResult_coupon_sheet_v2_0锚点逐字一致()
        {
            ParseResultAnchor("coupon-sheet-v2.0.json", "coupon-sheet-parse-result.json", TestSchemas.V2);
        }

        //  闭环：锚点覆盖补齐 AI-3 新增 fixture（原仅覆盖前 3 个）
        [Fact]
        public void ParseResult_nup_extremes_v2_0锚点逐字一致()
        {
            ParseResultAnchor("nup-extremes-v2.0.json", "nup-extremes-parse-result.json", TestSchemas.V2);
        }

        [Fact]
        public void ParseResult_static_rows_boundary_v2_0锚点逐字一致()
        {
            ParseResultAnchor("static-rows-boundary-v2.0.json", "static-rows-boundary-parse-result.json", TestSchemas.V2);
        }

        private static void ParseResultAnchor(string fixtureFile, string expectedFile, Json.Schema.JsonSchema schema)
        {
            var dsl = RepoPaths.ReadJsonTree($"fixtures/templates/{fixtureFile}")!;
            var expected = (IDictionary<string, object?>)RepoPaths.ExpectedJson(expectedFile)!;
            var result = DslParser.GetParseResult(dsl, schema);
            Assert.Equal((string)expected["hash"]!, result.Hash);
            Assert.Equal((long)(double)expected["expressionCount"]!, result.ExpressionCount);
            Assert.Equal((bool)expected["valid"]!, result.Valid);
            var expectedPaths = ((IList<object?>)expected["fieldPaths"]!).Cast<string>().ToList();
            Assert.Equal(expectedPaths, result.FieldPaths);
        }

        [Fact]
        public void ParseResult_fieldPaths覆盖主源裸路径与detail行路径()
        {
            var result = DslParser.GetParseResult(SalesNote(), TestSchemas.V1);
            Assert.Contains("billNo", result.FieldPaths);
            Assert.Contains("customer.name", result.FieldPaths);
            Assert.Contains("items[*].sku", result.FieldPaths);
            // 字典序锁定
            var sorted = result.FieldPaths.OrderBy(p => p, StringComparer.Ordinal).ToList();
            Assert.Equal(sorted, result.FieldPaths);
        }

        [Fact]
        public void ParseResult_schema违反时valid_false且其余字段仍产出()
        {
            var broken = new Dictionary<string, object?>(SalesNote());
            broken.Remove("id");
            var result = DslParser.GetParseResult(broken, TestSchemas.V1);
            Assert.False(result.Valid);
            Assert.Matches("^sha256:[0-9a-f]{64}$", result.Hash);
            Assert.True(result.ExpressionCount > 0);
        }
    }
}
