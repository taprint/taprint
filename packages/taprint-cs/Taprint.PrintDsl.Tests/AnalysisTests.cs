// SPDX-License-Identifier: Apache-2.0
using System.Collections.Generic;
using System.Linq;
using Taprint.PrintDsl.Internal;
using Xunit;

// Analysis C# 端定向单测（TS 无独立 analysis.spec——其消费方 parseResult/validateBusiness
// 在轮 3 锚定；本轮先锁 fieldPathsOf/expressionsOf/classifyRef 语义）。
namespace Taprint.PrintDsl.Tests
{
    public class AnalysisTests
    {
        private static IDictionary<string, object?> SalesNote() =>
            DslParser.Parse(RepoPaths.ReadText("fixtures/templates/sales-note-v1.0.json"));

        [Fact]
        public void fieldPathsOf_覆盖主源裸路径与detail行路径_字典序锁定()
        {
            var paths = Analysis.FieldPathsOf(SalesNote());
            Assert.Contains("billNo", paths);
            Assert.Contains("customer.name", paths);
            Assert.Contains("items[*].sku", paths);
            Assert.Equal(paths.OrderBy(p => p, System.StringComparer.Ordinal).ToList(), paths);
        }

        [Fact]
        public void expressionsOf_仅收集presentations渲染面()
        {
            var occurrences = Analysis.ExpressionsOf(SalesNote());
            Assert.NotEmpty(occurrences);
            Assert.All(occurrences, o =>
            {
                Assert.StartsWith("presentations", o.Path);
                Assert.StartsWith("{{", o.Raw);
                Assert.EndsWith("}}", o.Raw);
                Assert.Equal(o.Raw.Substring(2, o.Raw.Length - 4).Trim(), o.Ref);
            });
        }

        [Fact]
        public void paramNamesOf_收集parameters名称()
        {
            var dsl = SalesNote();
            var names = Analysis.ParamNamesOf(dsl);
            // sales-note 若有 parameters 则全为字符串名；空亦合法
            Assert.All(names, n => Assert.False(string.IsNullOrEmpty(n)));
        }

        [Fact]
        public void classifyRef_首段源名_整源聚合与子路径()
        {
            var items = new DataSourceInfo("items", "detail", new Dictionary<string, object?>
            {
                ["sku"] = "string",
                ["amount"] = "number",
            });
            Assert.Equal(Analysis.RefOk, Analysis.ClassifyRef("items", new[] { items }));
            Assert.Equal(Analysis.RefOk, Analysis.ClassifyRef("items.sku", new[] { items }));
            Assert.Equal(Analysis.RefUnknown, Analysis.ClassifyRef("items.nope", new[] { items }));
        }

        [Fact]
        public void classifyRef_裸路径单源命中ok_多源命中ambiguous_均未命中查parameters()
        {
            var main = new DataSourceInfo("main", "main", new Dictionary<string, object?>
            {
                ["billNo"] = "string",
                ["amount"] = "number",
            });
            var sub = new DataSourceInfo("sub", "main", new Dictionary<string, object?>
            {
                ["amount"] = "number",
            });
            Assert.Equal(Analysis.RefOk, Analysis.ClassifyRef("billNo", new[] { main, sub }));
            Assert.Equal(Analysis.RefAmbiguous, Analysis.ClassifyRef("amount", new[] { main, sub }));
            Assert.Equal(Analysis.RefOk, Analysis.ClassifyRef("amount", new[] { main }));
            var paramsSet = new HashSet<string> { "copies" };
            Assert.Equal(Analysis.RefOk, Analysis.ClassifyRef("copies", new[] { main }, paramsSet));
            Assert.Equal(Analysis.RefUnknown, Analysis.ClassifyRef("nope", new[] { main }, paramsSet));
        }

        [Fact]
        public void classifyRef_数字索引段剥离_纯索引路径为unknown()
        {
            var items = new DataSourceInfo("items", "detail", new Dictionary<string, object?>
            {
                ["sku"] = "string",
            });
            // ExtractFields 输出形态 items.0.sku ⇔ items[0].sku
            Assert.Equal(Analysis.RefOk, Analysis.ClassifyRef("items.0.sku", new[] { items }));
            Assert.Equal(Analysis.RefUnknown, Analysis.ClassifyRef("0.1", new[] { items }));
        }
    }
}
