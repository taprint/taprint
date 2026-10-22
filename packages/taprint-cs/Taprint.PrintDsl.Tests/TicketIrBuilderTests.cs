// SPDX-License-Identifier: Apache-2.0
using System;
using System.Collections.Generic;
using System.Linq;
using Taprint.PrintDsl.Engine;
using Xunit;
// 内核解析面（Taprint.PrintDsl.DslParser）与出票解析面（Engine.DslParser）同名不同层；
// 本测试命名空间嵌套于 Taprint.PrintDsl 之下，裸名会先命中内核面——别名消歧。
using TicketDslParser = Taprint.PrintDsl.Engine.DslParser;

namespace Taprint.PrintDsl.Tests
{
    /// <summary>
    /// IR 构建面（DSL JSON → 元素树 → 行序列）与过滤管道求值：正典/旧方言双键回退、
    /// loop 行作用域、条件真值、码块尺寸契约、kvtable 双形态。
    /// </summary>
    public class TicketIrBuilderTests
    {
        private static DslDocument Parse(string dslJson)
        {
            return TicketDslParser.Parse(dslJson);
        }

        private static IDictionary<string, object> Data() => new Dictionary<string, object>
        {
            ["store"] = new Dictionary<string, object> { ["name"] = "测试门店" },
            ["amount"] = 12.5d,
            ["bigAmount"] = 1234567.891d,
            ["midAmount"] = 2.345d,
            ["when"] = "true",
            ["goodsList"] = new List<object>
            {
                new Dictionary<string, object> { ["name"] = "苹果", ["qty"] = 2.0, ["price"] = 3.5d },
                new Dictionary<string, object> { ["name"] = "梨", ["qty"] = 1.0, ["price"] = 4.0d },
            },
        };

        [Fact]
        public void 纸宽列数换算_80mm48列_58mm32列()
        {
            const string wide = @"{""presentations"":{""receipt"":{""widthmm"":80,""body"":[{""type"":""text"",""content"":""a""}]}}}";
            const string narrow = @"{""presentations"":{""receipt"":{""widthmm"":58,""body"":[{""type"":""text"",""content"":""a""}]}}}";
            Assert.Equal(48, TicketIrBuilder.Build(Parse(wide), "receipt", Data()).Columns);
            Assert.Equal(32, TicketIrBuilder.Build(Parse(narrow), "receipt", Data()).Columns);
            Assert.Equal(80d, TicketIrBuilder.Build(Parse(wide), "receipt", Data()).PaperWidthMm);
        }

        [Fact]
        public void 文本行_表达式替换_对齐与字号档()
        {
            const string dsl = @"{""presentations"":{""receipt"":{""widthmm"":80,""body"":[
                {""type"":""text"",""content"":""门店：{{store.name}}"",""align"":""center"",""fontSize"":3},
                {""type"":""text"",""content"":""{{missing.path}}"", ""fontSize"": 6},
                {""type"":""text"",""content"":""静态行""}
            ]}}}";
            PrintTicketIr ir = TicketIrBuilder.Build(Parse(dsl), "receipt", Data());

            Assert.Equal(3, ir.Lines.Count);
            Assert.Equal(TicketLineKind.Text, ir.Lines[0].Kind);
            Assert.Equal("门店：测试门店", ir.Lines[0].Text);
            Assert.Equal("center", ir.Lines[0].Align);
            Assert.Equal(3, ir.Lines[0].FontScale);   // 档保真
            Assert.Equal(4, ir.Lines[1].FontScale);   // 6→夹 4 档
            Assert.Equal(string.Empty, ir.Lines[1].Text);   // 动态求值空=占位空行（结构位不塌）
            Assert.Equal("静态行", ir.Lines[2].Text);
        }

        [Fact]
        public void loop行作用域_内层帧优先_表格全量展开()
        {
            const string dsl = @"{""presentations"":{""receipt"":{""widthmm"":80,""body"":[
                {""type"":""loop"",""each"":""goodsList"",""body"":[
                    {""type"":""text"",""content"":""{{name}} x{{qty}}""}
                ]},
                {""type"":""table"",""source"":""goodsList"",""columns"":[
                    {""field"":""name"",""header"":""品名"",""width"":""60%""},
                    {""field"":""price"",""label"":""单价"",""width"":2}
                ]}
            ]}}}";
            PrintTicketIr ir = TicketIrBuilder.Build(Parse(dsl), "receipt", Data());

            Assert.Equal(2, ir.Lines.Count(l => l.Kind == TicketLineKind.Text));
            Assert.Equal("苹果 x2", ir.Lines[0].Text);
            Assert.Equal("梨 x1", ir.Lines[1].Text);

            // 表格：表头行 + 2 数据行；列头正典 header 与旧方言 label 各一，权重 60/2。
            var tableRows = ir.Lines.Where(l => l.Kind == TicketLineKind.TableRow).ToList();
            Assert.Equal(3, tableRows.Count);
            Assert.Equal("品名", tableRows[0].Columns[0].Key);
            Assert.Equal(60, tableRows[0].Columns[0].Value);
            Assert.Equal("单价", tableRows[0].Columns[1].Key);
            Assert.Equal(2, tableRows[0].Columns[1].Value);
            Assert.Equal("苹果", tableRows[1].Columns[0].Key);
            Assert.Equal("3.5", tableRows[1].Columns[1].Key);   // 数值整形化（3.5 非整）
        }

        [Fact]
        public void kvtable_正典rows三层嵌套_含滤器管道()
        {
            const string dsl = @"{""presentations"":{""receipt"":{""widthmm"":80,""body"":[
                {""type"":""kvtable"",""rows"":[[[""合计"",""{{amount | currency:CNY}}""],[""大额"",""{{bigAmount | currency:CNY}}""]]]}
            ]}}}";
            PrintTicketIr ir = TicketIrBuilder.Build(Parse(dsl), "receipt", Data());

            Assert.Equal(2, ir.Lines.Count);
            Assert.Equal(TicketLineKind.KeyValue, ir.Lines[0].Kind);
            Assert.Equal("合计", ir.Lines[0].Key);
            Assert.Equal("￥12.50", ir.Lines[0].Text);
            Assert.Equal("大额", ir.Lines[1].Key);
            Assert.Equal("￥1,234,567.89", ir.Lines[1].Text);   // 千分位+HALF_UP(.891→.89)
        }

        [Fact]
        public void kvtable_旧方言keys回退_缺label容错()
        {
            const string dsl = @"{""presentations"":{""receipt"":{""widthmm"":80,""body"":[
                {""type"":""kvtable"",""keys"":[
                    {""label"":""门店"",""key"":""store.name""},
                    {""key"":""amount""}
                ]}
            ]}}}";
            PrintTicketIr ir = TicketIrBuilder.Build(Parse(dsl), "receipt", Data());

            Assert.Equal(2, ir.Lines.Count);
            Assert.Equal("门店", ir.Lines[0].Key);
            Assert.Equal("测试门店", ir.Lines[0].Text);
            Assert.Equal("amount", ir.Lines[1].Key);   // 缺 label 回退键名（禁 KeyNotFound 炸链）
            Assert.Equal("12.5", ir.Lines[1].Text);
        }

        [Fact]
        public void 条件_正典when与旧方言condition回退_elseBody()
        {
            const string truthy = @"{""presentations"":{""receipt"":{""widthmm"":80,""body"":[
                {""type"":""conditional"",""when"":""{{store.name}}"",""body"":[{""type"":""text"",""content"":""T""}],""elseBody"":[{""type"":""text"",""content"":""F""}]}
            ]}}}";
            const string falsy = @"{""presentations"":{""receipt"":{""widthmm"":80,""body"":[
                {""type"":""conditional"",""condition"":""{{missing.path}}"",""body"":[{""type"":""text"",""content"":""T""}],""elseBody"":[{""type"":""text"",""content"":""F""}]}
            ]}}}";
            Assert.Equal("T", TicketIrBuilder.Build(Parse(truthy), "receipt", Data()).Lines[0].Text);
            Assert.Equal("F", TicketIrBuilder.Build(Parse(falsy), "receipt", Data()).Lines[0].Text);
        }

        [Fact]
        public void 码块尺寸契约_qrSize毫米口径两形等价_barcode高度()
        {
            const string dsl = @"{""presentations"":{""receipt"":{""widthmm"":80,""body"":[
                {""type"":""qrcode"",""content"":""qr1"",""size"":""6mm""},
                {""type"":""qrcode"",""content"":""qr2"",""size"":6},
                {""type"":""barcode"",""content"":""4001"",""height"":""9mm""}
            ]}}}";
            PrintTicketIr ir = TicketIrBuilder.Build(Parse(dsl), "receipt", Data());

            Assert.Equal(48, ir.Lines[0].HeightDots);   // "6mm"：折算一次
            Assert.Equal(48, ir.Lines[1].HeightDots);   // 数值 6(mm)：×8 一次——两形同值
            Assert.Equal(72, ir.Lines[2].HeightDots);   // 9mm×8
        }

        [Fact]
        public void 未知与指令元素跳过_line_cut_spacer()
        {
            const string dsl = @"{""presentations"":{""receipt"":{""widthmm"":80,""body"":[
                {""type"":""cashDrawer"",""pin"":0},
                {""type"":""line"",""lineStyle"":""dashed""},
                {""type"":""cut""},
                {""type"":""spacer"",""height"":""9mm""},
                {""type"":""image"",""src"":""logo.png"",""height"":""3mm""}
            ]}}}";
            PrintTicketIr ir = TicketIrBuilder.Build(Parse(dsl), "receipt", Data());

            Assert.Equal(4, ir.Lines.Count);
            Assert.Equal(TicketLineKind.Rule, ir.Lines[0].Kind);
            Assert.True(ir.Lines[0].Dashed);
            Assert.Equal(TicketLineKind.Cut, ir.Lines[1].Kind);
            Assert.Equal(TicketLineKind.Spacer, ir.Lines[2].Kind);
            Assert.Equal(72, ir.Lines[2].HeightDots);
            Assert.Equal(TicketLineKind.Spacer, ir.Lines[3].Kind);   // image=占位行承载
            Assert.Equal(24, ir.Lines[3].HeightDots);
        }

        [Fact]
        public void 解析层_形态级错误类型化_空呈现空文档()
        {
            var empty = Assert.Throws<PrintDomainException>(() => TicketDslParser.Parse("  "));
            Assert.Equal(PrintErrorCode.DslParseFailed, empty.Code);

            var bad = Assert.Throws<PrintDomainException>(() => TicketDslParser.Parse("{oops"));
            Assert.Equal(PrintErrorCode.DslParseFailed, bad.Code);

            var notObject = Assert.Throws<PrintDomainException>(() => TicketDslParser.Parse("[1,2]"));
            Assert.Equal(PrintErrorCode.DslParseFailed, notObject.Code);

            Assert.Empty(TicketDslParser.Parse(@"{""presentations"":{}}").Sections);
        }

        [Fact]
        public void doc呈现_三段序_receipt优先()
        {
            const string dsl = @"{""presentations"":{
                ""doc"":{""header"":[{""type"":""text"",""content"":""H""}],""footer"":[{""type"":""text"",""content"":""F""}]},
                ""receipt"":{""body"":[{""type"":""text"",""content"":""R""}]}}}";
            DslDocument doc = Parse(dsl);

            // 呈现优先级 receipt→doc→label：receipt 首位。
            Assert.Equal("receipt", doc.Sections[0].Presentation);
            var docSections = doc.Sections.Where(s => s.Presentation == "doc").ToList();
            Assert.Equal(2, docSections.Count);
            Assert.Equal("header", docSections[0].Name);
            Assert.Equal("footer", docSections[1].Name);
        }

        // ---------- 过滤管道 ----------

        private static ExpressionScope Scope(IDictionary<string, object> data)
        {
            var scope = new ExpressionScope();
            scope.Push(data);
            return scope;
        }

        [Fact]
        public void 滤器_currency_中点远离零_千分位_缺省零()
        {
            var data = new Dictionary<string, object>(Data()) { ["yen"] = "1235" };
            var scope = Scope(data);
            Assert.Equal("￥2.35", DslFilterPipeline.Evaluate("midAmount | currency:CNY", scope));   // 2.345→2.35
            Assert.Equal("￥12.50", DslFilterPipeline.Evaluate("amount | currency", scope));        // 缺省 CNY
            Assert.Equal("￥0.00", DslFilterPipeline.Evaluate("nothing | currency:CNY", scope));    // 缺路径→缺省零
            Assert.Equal("JP￥1,235", DslFilterPipeline.Evaluate("yen | currency:JPY", scope));     // 字串数值+零小数位币种
        }

        [Fact]
        public void 滤器_白名单与失败语义二分()
        {
            var scope = Scope(Data());
            Assert.Null(DslFilterPipeline.Evaluate("amount | nosuchfilter", scope));      // 未知滤器=解析失败 null
            Assert.Null(DslFilterPipeline.Evaluate("amount | currency:", scope));        // 空参=文法坏 null
            Assert.Equal("12.5", DslFilterPipeline.Evaluate("amount", scope));           // 无管道腿=路径腿文本直出
        }

        [Fact]
        public void 滤器_date_占位符映射与不可解析置空()
        {
            var scope = Scope(new Dictionary<string, object> { ["ts"] = "2026-01-02 03:04:05" });
            Assert.Equal("2026-01-02", DslFilterPipeline.Evaluate("ts | date:'YYYY-MM-DD'", scope));
            Assert.Equal("2026-01-02 03:04", DslFilterPipeline.Evaluate("ts | date:'YYYY-MM-DD HH:mm'", scope));
            Assert.Equal(string.Empty, DslFilterPipeline.Evaluate("store | date:'YYYY-MM-DD'", scope));  // 不可解析→空
        }

        [Fact]
        public void 滤器_round_truncate_mask_default_count()
        {
            var data = new Dictionary<string, object>
            {
                ["m"] = 2.345d,
                ["half"] = 2.5d,
                ["s"] = "abcdefghijk",
                ["card"] = "402123",
                ["blank"] = "",
            };
            var scope = Scope(data);

            Assert.Equal("2.35", DslFilterPipeline.Evaluate("m | round:2", scope));
            Assert.Equal("3", DslFilterPipeline.Evaluate("half | round", scope));        // 中点远离零（非银行家 2）
            Assert.Equal("abcde...", DslFilterPipeline.Evaluate("s | truncate:8", scope));
            Assert.Equal("******", DslFilterPipeline.Evaluate("card | mask", scope));
            Assert.Equal("fallback", DslFilterPipeline.Evaluate("blank | default:'fallback'", scope));
            Assert.Equal("6", DslFilterPipeline.Evaluate("card | count", scope));
        }

        [Fact]
        public void 滤器_集合聚合_sum_avg_min_max()
        {
            var data = new Dictionary<string, object>
            {
                ["rows"] = new List<object>
                {
                    new Dictionary<string, object> { ["qty"] = 2.0 },
                    new Dictionary<string, object> { ["qty"] = 4.0 },
                    new Dictionary<string, object> { ["qty"] = 9.0 },
                },
            };
            var scope = Scope(data);
            Assert.Equal("15", DslFilterPipeline.Evaluate("rows | sum:'qty'", scope));
            Assert.Equal("5", DslFilterPipeline.Evaluate("rows | avg:'qty'", scope));
            Assert.Equal("2", DslFilterPipeline.Evaluate("rows | min:'qty'", scope));
            Assert.Equal("9", DslFilterPipeline.Evaluate("rows | max:'qty'", scope));
        }

        [Fact]
        public void 表达式_未闭合花括号按字面量_真值判定()
        {
            var scope = Scope(Data());
            Assert.Equal("a{{b", DslExpression.Substitute("a{{b", scope));
            Assert.True(DslExpression.EvaluateTruthy("{{store.name}}", scope));
            Assert.False(DslExpression.EvaluateTruthy("{{missing}}", scope));
            Assert.False(DslExpression.EvaluateTruthy("no marker", scope));
        }

        [Fact]
        public void 预览渲染_纯函数_纸底墨点与列宽()
        {
            const string dsl = @"{""presentations"":{""receipt"":{""widthmm"":80,""body"":[
                {""type"":""text"",""content"":""HELLO""},
                {""type"":""line""}
            ]}}}";
            var bitmap = IrPreviewRenderer.Render(TicketIrBuilder.Build(Parse(dsl), "receipt", Data()));

            int stride = bitmap.Stride;
            Assert.Equal(48 * IrPreviewRenderer.BaseCharDots, stride);   // 576=48列×12dot（8像素/字节对齐）
            Assert.Equal(stride * bitmap.Height, bitmap.Pixels.Length);
            int ink = bitmap.Pixels.Count(p => p == 0);
            Assert.True(ink > 0, "文本/分隔线应有墨点");                // 块面字形+横线落墨
            Assert.True(bitmap.Pixels.Length - ink > 0, "余量纸底");     // 其余纸底

            var gray = bitmap.ToGray8();
            Assert.Equal(byte.MaxValue, gray.Pixels[0]);   // 顶行起点=纸底→255 白（墨自 y0+2 起）
        }
    }
}
