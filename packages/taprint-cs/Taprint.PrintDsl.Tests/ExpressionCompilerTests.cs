// SPDX-License-Identifier: Apache-2.0
using System;
using System.Collections.Generic;
using System.Linq;
using Xunit;

// ExpressionCompiler C# 端等价测试（print-dsl-ts expression-compiler.spec.ts 224 行逐锚移植）：
// 主文档 （JS 表达式 + Liquid 管道）+  沙箱；多语言实现一致性锚点。
// JS 语义复刻断言：undefined 哨兵（JsUndefined）、== 宽松相等、字典序比较、转义白名单等。
// 时区注：date 过滤器取本地时区分量，与 TS spec 同环境基线（本机 UTC；CI 建议 TZ=Asia/Shanghai 声明化）。
namespace Taprint.PrintDsl.Tests
{
    public class ExpressionCompilerTests
    {
        private static object? Run(string expr, Dictionary<string, object?>? data = null) =>
            ExpressionCompiler.Evaluate(ExpressionCompiler.Compile(expr), data, 100);

        private static double AsDouble(object? v) => Assert.IsType<double>(v);
        private static string AsString(object? v) => Assert.IsType<string>(v);
        private static bool AsBool(object? v) => Assert.IsType<bool>(v);
        private static ExpressionSyntaxError SyntaxThrows(Action action)
        {
            var ex = Assert.Throws<ExpressionSyntaxError>(action);
            return ex;
        }

        // ---------- ExpressionCompiler.Compile ----------

        [Fact]
        public void 字面量_路径_索引的AST形态()
        {
            var lit = Assert.IsType<LiteralNode>(ExpressionCompiler.Compile("42").Root);
            Assert.Equal(42.0, AsDouble(lit.Value));

            var path = Assert.IsType<PathNode>(ExpressionCompiler.Compile("customer.name").Root);
            Assert.Equal(new object[] { "customer", "name" }, path.Segments.ToArray());

            var indexed = Assert.IsType<PathNode>(ExpressionCompiler.Compile("items[0].sku").Root);
            Assert.Equal(new object[] { "items", 0, "sku" }, indexed.Segments.ToArray());

            Assert.Equal("billNo", ExpressionCompiler.Compile("billNo").Raw);
        }

        [Fact]
        public void 通配符不参与表达式文法_仅字段字典展示形态()
        {
            SyntaxThrows(() => ExpressionCompiler.Compile("items[*].sku"));
        }

        [Fact]
        public void 未知过滤器_非整数索引_未闭合字符串_非法字符均拒绝()
        {
            Assert.Contains("未知过滤器", SyntaxThrows(() => ExpressionCompiler.Compile("x | nope:1")).Message);
            SyntaxThrows(() => ExpressionCompiler.Compile("items[0.5]"));
            Assert.Contains("未闭合", SyntaxThrows(() => ExpressionCompiler.Compile("'abc")).Message);
            Assert.Contains("非法字符", SyntaxThrows(() => ExpressionCompiler.Compile("a @ b")).Message);
        }

        [Fact]
        public void 沙箱限额_单表达式不超过1KB()
        {
            Assert.Contains("沙箱限额",
                SyntaxThrows(() => ExpressionCompiler.Compile(new string('a', 1025))).Message);
            Assert.IsType<PathNode>(ExpressionCompiler.Compile(new string('a', 1024)).Root);
        }

        [Fact]
        public void AST嵌套深度限额64()
        {
            var expr = string.Concat(Enumerable.Repeat("1 + ", 66)) + "1";
            Assert.Contains("嵌套过深", SyntaxThrows(() => ExpressionCompiler.Compile(expr)).Message);
        }

        // ---------- ExpressionCompiler.Evaluate ----------

        [Fact]
        public void 四则运算与优先级()
        {
            Assert.Equal(59.7, AsDouble(Run("qty * price | round:2",
                new Dictionary<string, object?> { ["qty"] = 3.0, ["price"] = 19.9 })));
            Assert.Equal(84.5, AsDouble(Run("totalAmount - discount",
                new Dictionary<string, object?> { ["totalAmount"] = 100.0, ["discount"] = 15.5 })));
            Assert.Equal(14.0, AsDouble(Run("2 + 3 * 4")));
            Assert.Equal(20.0, AsDouble(Run("(2 + 3) * 4")));
            Assert.Equal(-3.0, AsDouble(Run("-qty", new Dictionary<string, object?> { ["qty"] = 3.0 })));
        }

        [Fact]
        public void payslip债务表达式()
        {
            Assert.Equal("¥9,540.75", AsString(Run("baseSalary + bonus + overtime | currency:CNY",
                new Dictionary<string, object?>
                {
                    ["baseSalary"] = 8000.0,
                    ["bonus"] = 1200.5,
                    ["overtime"] = 340.25,
                })));
        }

        [Fact]
        public void 比较_逻辑_三元()
        {
            var data = new Dictionary<string, object?> { ["paidAmount"] = 80.0, ["totalAmount"] = 100.0 };
            Assert.Equal("欠款", AsString(Run("paidAmount < totalAmount ? '欠款' : '已付'", data)));
            Assert.Equal("已付", AsString(Run("paidAmount >= totalAmount ? '已付' : '欠款'",
                new Dictionary<string, object?> { ["paidAmount"] = 100.0, ["totalAmount"] = 100.0 })));
            Assert.Equal("x", AsString(Run("a && b",
                new Dictionary<string, object?> { ["a"] = true, ["b"] = "x" })));
            Assert.Equal("fallback", AsString(Run("a || b",
                new Dictionary<string, object?> { ["a"] = "", ["b"] = "fallback" })));
            Assert.True(AsBool(Run("5 == '5'")));
            Assert.False(AsBool(Run("5 === '5'")));
        }

        [Fact]
        public void 字符串拼接()
        {
            Assert.Equal("单号：XS20260808001", AsString(Run("'单号：' + billNo",
                new Dictionary<string, object?> { ["billNo"] = "XS20260808001" })));
        }

        [Fact]
        public void 路径解析_嵌套_索引_缺失即undefined()
        {
            var data = new Dictionary<string, object?>
            {
                ["customer"] = new Dictionary<string, object?> { ["name"] = "张三" },
                ["items"] = new List<object?>
                {
                    new Dictionary<string, object?> { ["sku"] = "A-01" },
                    new Dictionary<string, object?> { ["sku"] = "B-02" },
                },
            };
            Assert.Equal("张三", AsString(Run("customer.name", data)));
            Assert.Equal("A-01", AsString(Run("items[0].sku", data)));
            Assert.Equal("B-02", AsString(Run("items[1].sku", data)));
            Assert.Same(JsUndefined.Value, Run("items[2].sku", data));
            Assert.Same(JsUndefined.Value, Run("customer.phone", data));
        }

        [Fact]
        public void 过滤管道_date_currency_round_sum_count_truncate_mask_default()
        {
            Assert.Equal("2026-08-08", AsString(Run("d | date:'YYYY-MM-DD'",
                new Dictionary<string, object?> { ["d"] = "2026-08-08T10:00:00Z" })));
            Assert.Equal("¥1,234.50", AsString(Run("amount | currency:CNY",
                new Dictionary<string, object?> { ["amount"] = 1234.5 })));
            Assert.Equal(3.14, AsDouble(Run("v | round:2",
                new Dictionary<string, object?> { ["v"] = 3.14159 })));
            Assert.Equal(12.5, AsDouble(Run("items | sum:'amount'",
                new Dictionary<string, object?>
                {
                    ["items"] = new List<object?>
                    {
                        new Dictionary<string, object?> { ["amount"] = 10.0 },
                        new Dictionary<string, object?> { ["amount"] = 2.5 },
                    },
                })));
            Assert.Equal(3.0, AsDouble(Run("items | count",
                new Dictionary<string, object?> { ["items"] = new List<object?> { 1.0, 2.0, 3.0 } })));
            Assert.Equal("备注很长...", AsString(Run("remark | truncate:4",
                new Dictionary<string, object?> { ["remark"] = "备注很长很长" })));
            Assert.Equal("138****8888", AsString(Run("phone | mask:'138****8888'",
                new Dictionary<string, object?> { ["phone"] = "13812348888" })));
            Assert.Equal("139****7777", AsString(Run("phone | mask:'138****8888'",
                new Dictionary<string, object?> { ["phone"] = "13999997777" })));
            Assert.Equal("-", AsString(Run("v | default:'-'", new Dictionary<string, object?>())));
            Assert.Equal("-", AsString(Run("v | default:'-'",
                new Dictionary<string, object?> { ["v"] = "" })));
            Assert.Equal("x", AsString(Run("v | default:'-'",
                new Dictionary<string, object?> { ["v"] = "x" })));
        }

        [Fact]
        public void 过滤器链式应用_左到右()
        {
            Assert.Equal("¥59.70", AsString(Run("qty * price | round:1 | currency:CNY",
                new Dictionary<string, object?> { ["qty"] = 3.0, ["price"] = 19.9 })));
        }

        [Fact]
        public void 自定义函数由宿主经data注入()
        {
            Assert.Equal("示例门店", AsString(Run("tenantName()",
                new Dictionary<string, object?> { ["tenantName"] = new Func<string>(() => "示例门店") })));
            var ex = Assert.Throws<InvalidOperationException>(() => Run("now()"));
            Assert.Contains("未注册函数", ex.Message);
        }

        [Fact]
        public void evaluate防御_AST形态与timeout校验()
        {
            Assert.Throws<ArgumentException>(() => ExpressionCompiler.Evaluate(null!, new Dictionary<string, object?>(), 100));
            var ast = ExpressionCompiler.Compile("x");
            Assert.Throws<ArgumentException>(() => ExpressionCompiler.Evaluate(ast, new Dictionary<string, object?>(), 0));
            Assert.Throws<ArgumentException>(() => ExpressionCompiler.Evaluate(ast, new Dictionary<string, object?>(), double.NaN));
        }

        // ---------- ExpressionCompiler.ExtractFields（字段联动校验） ----------

        [Fact]
        public void 提取路径引用_含索引段_去重保序()
        {
            var ast = ExpressionCompiler.Compile("items[0].sku + items[1].sku + billNo + (billNo | truncate:5)");
            Assert.Equal(new[] { "items.0.sku", "items.1.sku", "billNo" },
                ExpressionCompiler.ExtractFields(ast).ToArray());
        }

        [Fact]
        public void 字面量_函数名不计入字段()
        {
            Assert.Empty(ExpressionCompiler.ExtractFields(ExpressionCompiler.Compile("now() + 'x'")));
        }

        // ---------- 生产级严格化（V3/V5/V6/V7 + 聚合补全） ----------

        [Fact]
        public void V3_宽松相等与JS对齐_boolean转数字_严格相等仍严格()
        {
            Assert.True(AsBool(Run("flag == 1", new Dictionary<string, object?> { ["flag"] = true })));
            Assert.True(AsBool(Run("flag == 0", new Dictionary<string, object?> { ["flag"] = false })));
            Assert.True(AsBool(Run("flag == '1'", new Dictionary<string, object?> { ["flag"] = true })));
            Assert.False(AsBool(Run("flag == 2", new Dictionary<string, object?> { ["flag"] = true })));
            Assert.False(AsBool(Run("flag === 1", new Dictionary<string, object?> { ["flag"] = true })));
        }

        [Fact]
        public void V5_currency补HKD_KRW_TWD符号()
        {
            Assert.Equal("HK$12.00", AsString(Run("amount | currency:HKD",
                new Dictionary<string, object?> { ["amount"] = 12.0 })));
            Assert.Equal("₩12.00", AsString(Run("amount | currency:KRW",
                new Dictionary<string, object?> { ["amount"] = 12.0 })));
            Assert.Equal("NT$12.00", AsString(Run("amount | currency:TWD",
                new Dictionary<string, object?> { ["amount"] = 12.0 })));
        }

        [Fact]
        public void V6_过滤器参数类型个数编译期即拒()
        {
            Assert.Contains("必须是字符串", SyntaxThrows(() => ExpressionCompiler.Compile("amount | currency:123")).Message);
            Assert.Contains("必须是数字", SyntaxThrows(() => ExpressionCompiler.Compile("v | truncate:\"5\"")).Message);
            Assert.Contains("最多接受", SyntaxThrows(() => ExpressionCompiler.Compile("v | round:2:3")).Message);
            Assert.Contains("最多接受", SyntaxThrows(() => ExpressionCompiler.Compile("items | count:1")).Message);
        }

        [Fact]
        public void V7_date格式未识别占位符编译期即拒()
        {
            Assert.Contains("未识别占位符",
                SyntaxThrows(() => ExpressionCompiler.Compile("d | date:'yyyy-mm-dd'")).Message);
            var _ = ExpressionCompiler.Compile("d | date:'YYYY年MM月DD日'"); // 非字母字符透传，不抛
            Assert.Equal("2026年08月", AsString(Run("d | date:'YYYY年MM月'",
                new Dictionary<string, object?> { ["d"] = "2026-08-08T10:00:00Z" })));
        }

        [Fact]
        public void 聚合补全_avg_min_max_跳过非数值_无数值返回空串()
        {
            var data = new Dictionary<string, object?>
            {
                ["items"] = new List<object?>
                {
                    new Dictionary<string, object?> { ["q"] = 2.0 },
                    new Dictionary<string, object?> { ["q"] = 4.0 },
                    new Dictionary<string, object?> { ["q"] = "x" },
                },
            };
            Assert.Equal(3.0, AsDouble(Run("items | avg:'q'", data)));
            Assert.Equal(2.0, AsDouble(Run("items | min:'q'", data)));
            Assert.Equal(4.0, AsDouble(Run("items | max:'q'", data)));
            Assert.Equal("", AsString(Run("items | avg",
                new Dictionary<string, object?> { ["items"] = new List<object?> { "a" } })));
        }

        // ---------- 二轮严格化（原型链防护/转义语义/比较边界） ----------

        [Fact]
        public void P2_原型链穿透防护_constructor_proto_toString一律不可达()
        {
            Assert.Same(JsUndefined.Value, Run("constructor.name"));
            Assert.Same(JsUndefined.Value, Run("constructor.name",
                new Dictionary<string, object?> { ["billNo"] = "X-1" }));
            Assert.Same(JsUndefined.Value, Run("__proto__"));
            Assert.Same(JsUndefined.Value, Run("toString"));
            Assert.Same(JsUndefined.Value, Run("hasOwnProperty"));
            // 继承成员也不可被当作宿主函数调用
            Assert.Contains("未注册函数",
                Assert.Throws<InvalidOperationException>(() => Run("constructor()")).Message);
            Assert.Contains("未注册函数",
                Assert.Throws<InvalidOperationException>(() => Run("toString()")).Message);
            // 自有同名属性不受防护影响（宿主显式注入仍然可达）
            Assert.Equal("自定义", AsString(Run("constructor.name",
                new Dictionary<string, object?>
                {
                    ["constructor"] = new Dictionary<string, object?> { ["name"] = "自定义" },
                })));
        }

        [Fact]
        public void P2_字符串转义白名单_未知转义编译期拒绝()
        {
            Assert.Equal("a\nb", AsString(Run("'a\\nb'")));
            Assert.Equal("a\tb", AsString(Run("'a\\tb'")));
            Assert.Equal("a\rb", AsString(Run("'a\\rb'")));
            Assert.Equal("a\\b", AsString(Run("'a\\\\b'")));
            Assert.Equal("it's ok", AsString(Run("'it\\'s ok'")));
            Assert.Equal("say \"hi\"", AsString(Run("\"say \\\"hi\\\"\"")));
            Assert.Contains("未知转义序列", SyntaxThrows(() => ExpressionCompiler.Compile("'a\\qb'")).Message);
            Assert.Contains("未知转义序列", SyntaxThrows(() => ExpressionCompiler.Compile("\"\\x41\"")).Message);
        }

        [Fact]
        public void P3_比较语义边界_数字字符串转数值_双侧字符串字典序()
        {
            Assert.True(AsBool(Run("'10' > 9")));
            Assert.False(AsBool(Run("'2' < '10'")));
            Assert.Equal("num", AsString(Run("'2' < '10' ? 'dict' : 'num'")));
            Assert.True(AsBool(Run("'5' == 5")));
            // null/undefined 不做 JS 式互转（显式不跟随）：缺失字段 == null 为 false
            Assert.False(AsBool(Run("a == null", new Dictionary<string, object?>())));
            Assert.True(AsBool(Run("null == null")));
        }

        // ---------- 十四轮（N1：过滤器可选参数契约与实现的缺省语义对齐） ----------

        [Fact]
        public void N1_sum_avg_min_max无参数对整个数组元素求值()
        {
            Assert.Equal(6.5, AsDouble(Run("nums | sum",
                new Dictionary<string, object?> { ["nums"] = new List<object?> { 1.0, 2.0, 3.5 } })));
            Assert.Equal(2.0, AsDouble(Run("nums | avg",
                new Dictionary<string, object?> { ["nums"] = new List<object?> { 1.0, 2.0, 3.0 } })));
            Assert.Equal(2.0, AsDouble(Run("nums | min",
                new Dictionary<string, object?> { ["nums"] = new List<object?> { 4.0, 2.0 } })));
            Assert.Equal(4.0, AsDouble(Run("nums | max",
                new Dictionary<string, object?> { ["nums"] = new List<object?> { 4.0, 2.0 } })));
        }

        [Fact]
        public void N1_其余过滤器无参数走文档化缺省()
        {
            Assert.Equal("2026-08-08", AsString(Run("d | date",
                new Dictionary<string, object?> { ["d"] = "2026-08-08T10:00:00Z" })));
            Assert.Equal("¥12.00", AsString(Run("amount | currency",
                new Dictionary<string, object?> { ["amount"] = 12.0 })));
            Assert.Equal(4.0, AsDouble(Run("v | round",
                new Dictionary<string, object?> { ["v"] = 3.7 })));
            Assert.Equal(new string('x', 20) + "...", AsString(Run("s | truncate",
                new Dictionary<string, object?> { ["s"] = new string('x', 25) })));
        }

        [Fact]
        public void N1_参数类型错误仍编译期拒绝_可选不等于放松类型契约()
        {
            Assert.Contains("必须是字符串", SyntaxThrows(() => ExpressionCompiler.Compile("items | sum:123")).Message);
            Assert.Contains("必须是数字", SyntaxThrows(() => ExpressionCompiler.Compile("v | round:\"2\"")).Message);
            Assert.Contains("最多接受", SyntaxThrows(() => ExpressionCompiler.Compile("nums | sum:x:y")).Message);
        }

        // ---------- 内部复刻护栏（ToFixed/JsRound，Node 实测基线） ----------

        [Fact]
        public void ToFixed_ties远离零与1e21回退_Node实测基线()
        {
            Assert.Equal("1", ExpressionCompiler.ToFixed(0.5, 0));
            Assert.Equal("-1", ExpressionCompiler.ToFixed(-0.5, 0));
            Assert.Equal("2", ExpressionCompiler.ToFixed(1.5, 0));
            Assert.Equal("-2", ExpressionCompiler.ToFixed(-1.5, 0));
            Assert.Equal("1234.57", ExpressionCompiler.ToFixed(1234.565, 2));
            Assert.Equal("-1234.57", ExpressionCompiler.ToFixed(-1234.565, 2));
            Assert.Equal("0.61", ExpressionCompiler.ToFixed(0.615, 2));
            Assert.Equal("2.67", ExpressionCompiler.ToFixed(2.675, 2));
            Assert.Equal("9540.75", ExpressionCompiler.ToFixed(9540.75, 2));
            Assert.Equal("1e+21", ExpressionCompiler.ToFixed(1e21, 2));
            Assert.Equal("NaN", ExpressionCompiler.ToFixed(double.NaN, 2));
        }

        [Fact]
        public void JsRound_floor加0点5语义_Math_round负0点5等于负0()
        {
            Assert.Equal(1.0, ExpressionCompiler.JsRound(0.5));
            Assert.Equal(-1.0, ExpressionCompiler.JsRound(-1.5));
            Assert.Equal(4.0, ExpressionCompiler.JsRound(3.7));
            var negZero = ExpressionCompiler.JsRound(-0.5);
            Assert.Equal(0.0, negZero);
            // -0 位形断言（1/-0 = -Infinity）
            Assert.True(double.IsNegativeInfinity(1.0 / negZero));
        }

        // ---------- 修复（P1-1 自有访问 / P1-2 date 接受面 / P2 truncate 钳制 / P3 泛型列表 / S1 回退路径） ----------

        [Fact]
        public void P1_1_数组length与字典数字键自有访问_镜像JS_Object_hasOwn()
        {
            // [1,2,3].length = 3（length 为数组自有属性）
            Assert.Equal(3.0, Run("items.length", new Dictionary<string, object?>
            {
                ["items"] = new List<object?> { 1.0, 2.0, 3.0 },
            }));
            // obj[0] 命中字典自有键 "0"（hasOwn(obj, 0) 键串化）
            Assert.Equal("zero", Run("items[0]", new Dictionary<string, object?>
            {
                ["items"] = new Dictionary<string, object?> { ["0"] = "zero" },
            }));
            // 泛型列表同样可达（宿主注入面）
            Assert.Equal(2.0, Run("nums[1]", new Dictionary<string, object?>
            {
                ["nums"] = new List<double> { 1.0, 2.0 },
            }));
            Assert.Equal(2.0, Run("nums.length", new Dictionary<string, object?>
            {
                ["nums"] = new List<double> { 1.0, 2.0 },
            }));
            // 非自有/非整数段仍不可达
            var list = new Dictionary<string, object?> { ["items"] = new List<object?> { 1.0 } };
            Assert.Same(JsUndefined.Value, Run("items.sku", list));
            Assert.Same(JsUndefined.Value, Run("items[1]", list));
        }

        [Fact]
        public void P1_2_date过滤器_V8_ISO子集与接受面保守收窄_Node实测基线()
        {
            // date-only → UTC 零点（本机 TZ=UTC 环境断言，与 TS spec 同基线）
            Assert.Equal("2026-08-09", AsString(Run("d | date", new Dictionary<string, object?> { ["d"] = "2026-08-09" })));
            Assert.Equal("2026-01-01", AsString(Run("d | date", new Dictionary<string, object?> { ["d"] = "2026" })));
            Assert.Equal("2026-08-01", AsString(Run("d | date", new Dictionary<string, object?> { ["d"] = "2026-08" })));
            // 日溢出进位与 V8 一致（2026-02-30 → 3 月 2 日）
            Assert.Equal("2026-03-02", AsString(Run("d | date", new Dictionary<string, object?> { ["d"] = "2026-02-30" })));
            // 小写 t/z 与 4 位小数秒（截断毫秒）
            Assert.Equal("2026-08-09", AsString(Run("d | date", new Dictionary<string, object?> { ["d"] = "2026-08-09t10:00:00z" })));
            Assert.Equal("2026-08-09", AsString(Run("d | date", new Dictionary<string, object?> { ["d"] = "2026-08-09T10:00:00.1234Z" })));
            // 越界拒绝（V8 Invalid Date → ''）
            foreach (var bad in new[] { "10:00", "08/09", "2026-13-01", "2026-08-09T25:00:00", "August 9, 2026" })
            {
                Assert.Equal("", AsString(Run("d | date", new Dictionary<string, object?> { ["d"] = bad })));
            }
            // 宿主 int/long 毫秒经 TryGetDouble 归一（与 TS typeof number 一致）
            Assert.Equal("1970-01-02", AsString(Run("d | date", new Dictionary<string, object?> { ["d"] = 86400000 })));
            Assert.Equal("1970-01-02", AsString(Run("d | date", new Dictionary<string, object?> { ["d"] = 86400000L })));
        }

        // ope 0.1：ToDate 五类 V8 合法 ISO 边缘输入接受面（Node v22.22.2 实测基线，TZ=UTC）
        [Fact]
        public void P1_2_V8接受面五类_月日非补零_24点进位_时区放宽_首尾空白_年0()
        {
            // ① 月/日允许 1-2 位（"2026-1-1" 合法）
            Assert.Equal("2026-01-01", AsString(Run("d | date:'YYYY-MM-DD'", new Dictionary<string, object?> { ["d"] = "2026-1-1" })));
            Assert.Equal("2026-01-01", AsString(Run("d | date", new Dictionary<string, object?> { ["d"] = "2026-1-01" })));
            Assert.Equal("2026-01-01", AsString(Run("d | date", new Dictionary<string, object?> { ["d"] = "2026-01-1" })));
            // ② hour=24 且分秒毫秒全 0 进位到次日零点（"2026-01-01T24:00" → 次日）
            Assert.Equal("2026-01-02", AsString(Run("d | date:'YYYY-MM-DD'", new Dictionary<string, object?> { ["d"] = "2026-01-01T24:00" })));
            Assert.Equal("2026-01-02", AsString(Run("d | date", new Dictionary<string, object?> { ["d"] = "2026-01-01T24:00:00" })));
            // hour=24 但分秒非 0 仍拒绝
            Assert.Equal("", AsString(Run("d | date", new Dictionary<string, object?> { ["d"] = "2026-01-01T24:01" })));
            Assert.Equal("", AsString(Run("d | date", new Dictionary<string, object?> { ["d"] = "2026-01-01T24:00:01" })));
            // ③ 时区偏移上限 ±23:59（V8 真值，原 ±14:00 过严）
            Assert.Equal("2025-12-31", AsString(Run("d | date", new Dictionary<string, object?> { ["d"] = "2026-01-01T00:00:00+15:00" })));
            Assert.Equal("2025-12-31", AsString(Run("d | date", new Dictionary<string, object?> { ["d"] = "2026-01-01T00:00:00+23:59" })));
            Assert.Equal("2026-01-01", AsString(Run("d | date", new Dictionary<string, object?> { ["d"] = "2026-01-01T00:00:00-23:59" })));
            // ④ date-only / 空格分隔形态宽容首尾空白（含 tab）；T 分隔严格
            Assert.Equal("2026-01-01", AsString(Run("d | date", new Dictionary<string, object?> { ["d"] = " 2026-01-01" })));
            Assert.Equal("2026-01-01", AsString(Run("d | date", new Dictionary<string, object?> { ["d"] = "2026-01-01 " })));
            Assert.Equal("2026-01-01", AsString(Run("d | date", new Dictionary<string, object?> { ["d"] = " 2026-01-01 " })));
            Assert.Equal("2026-01-01", AsString(Run("d | date", new Dictionary<string, object?> { ["d"] = "\t2026-01-01\t" })));
            // T 分隔 + 首尾空白 V8 拒绝
            Assert.Equal("", AsString(Run("d | date", new Dictionary<string, object?> { ["d"] = " 2026-01-01T00:00:00" })));
            Assert.Equal("", AsString(Run("d | date", new Dictionary<string, object?> { ["d"] = "2026-01-01T00:00:00 " })));
            // ⑤ year=0（proleptic Gregorian，JS getFullYear 不补零 → "0-01-01"）
            Assert.Equal("0-01-01", AsString(Run("d | date:'YYYY-MM-DD'", new Dictionary<string, object?> { ["d"] = "0000-01-01" })));
            Assert.Equal("0-01-01", AsString(Run("d | date", new Dictionary<string, object?> { ["d"] = "0000-01-01T00:00:00Z" })));
        }

        //  闭环：数值 ms 超 V8 合法范围 ±8.64e15 → Invalid Date（"NaN" 占位，非空串、
        // 非 (long) 溢出垃圾值），与 TS new Date(v) 逐字一致（Node v22.22.2 实测基线，TZ=UTC）
        [Fact]
        public void P2_date过滤器数值ms范围边界_InvalidDate输出NaN占位()
        {
            const string Fmt = "d | date:'YYYY-MM-DD HH:mm:ss'";
            // V8 合法 ms 上下边界（含）
            Assert.Equal("275760-09-13 00:00:00", AsString(Run(Fmt, new Dictionary<string, object?> { ["d"] = 8640000000000000d })));
            Assert.Equal("-271821-04-20 00:00:00", AsString(Run(Fmt, new Dictionary<string, object?> { ["d"] = -8640000000000000d })));
            // 边界 ±1 与极端值/NaN/Infinity → Invalid Date → 各占位符 "NaN"
            foreach (var bad in new[] { 8640000000000001d, -8640000000000001d, 1e300, -1e300, double.NaN, double.PositiveInfinity })
            {
                Assert.Equal("NaN-NaN-NaN NaN:NaN:NaN", AsString(Run(Fmt, new Dictionary<string, object?> { ["d"] = bad })));
            }
            // 锚点回归：epoch 零点
            Assert.Equal("1970-01-01 00:00:00", AsString(Run(Fmt, new Dictionary<string, object?> { ["d"] = 0d })));
        }

        // ope 0.2：ReadField 收非泛型 IDictionary，强类型字典列表上 sum:'field' 与 TS 一致
        [Fact]
        public void P3_强类型字典列表_sum_count与TS逐字一致()
        {
            // List<Dictionary<string,double>> 上 sum:'amount' = 12.5（修复前返 0）
            var items = new System.Collections.Generic.List<System.Collections.Generic.Dictionary<string, double>>
            {
                new() { ["amount"] = 10.0 },
                new() { ["amount"] = 2.5 },
            };
            var data = new Dictionary<string, object?> { ["items"] = items };
            Assert.Equal(12.5, Run("items | sum:'amount'", data));
            Assert.Equal(2.0, Run("items | count", data));
            // List<Dictionary<string,int>> 同样可达
            var ints = new System.Collections.Generic.List<System.Collections.Generic.Dictionary<string, int>>
            {
                new() { ["qty"] = 3 },
                new() { ["qty"] = 4 },
            };
            var dataInt = new Dictionary<string, object?> { ["items"] = ints };
            Assert.Equal(7.0, Run("items | sum:'qty'", dataInt));
            // 泛型 IDictionary<string,object?> 路径不受影响（既有用例零回归锚点）
            var mixed = new System.Collections.Generic.List<Dictionary<string, object?>>
            {
                new() { ["amount"] = 1.0 },
                new() { ["amount"] = 2.5 },
            };
            Assert.Equal(3.5, Run("items | sum:'amount'", new Dictionary<string, object?> { ["items"] = mixed }));
        }

        [Fact]
        public void P2_truncate大数钳制与JS_slice负值语义()
        {
            // 3e9 不再溢出崩溃：钳制返回全串（TS slice(0, 3e9) 同）
            Assert.Equal("abcdef", AsString(Run("s | truncate:3000000000", new Dictionary<string, object?> { ["s"] = "abcdef" })));
            // 负值按 JS slice(0, -1) 相对语义（文法不可达负字面量参数，手工 AST 注入验证求值域）
            var ast = new ExpressionAst("s | truncate:-1", new FilterNode(
                new PathNode(new object[] { "s" }), "truncate",
                new ExpressionNode[] { new LiteralNode(-1.0) }));
            Assert.Equal("abcde...", Assert.IsType<string>(
                ExpressionCompiler.Evaluate(ast, new Dictionary<string, object?> { ["s"] = "abcdef" }, 100)));
        }

        [Fact]
        public void P3_宿主泛型列表注入_聚合与拼接不再静默失效()
        {
            var data = new Dictionary<string, object?>
            {
                ["nums"] = new List<double> { 1.0, 2.0, 3.5 },
                ["tags"] = new List<string> { "a", "b" },
            };
            Assert.Equal(6.5, Run("nums | sum", data));
            Assert.Equal(3.0, Run("nums | count", data));
            Assert.Equal(3.5, Run("nums | max", data));
            // JS Array.toString 逗号连接
            Assert.Equal("前缀:a,b", AsString(Run("'前缀:' + tags", data)));
        }

        [Fact]
        public void S1_toFixed大于等于1e21回退EcmaNumber_端到端经currency()
        {
            // (1e21).toFixed(2) = "1e+21"（V8），FormatNumber 回退路径不产生千分位
            Assert.Equal("¥1e+21", AsString(Run("amount | currency:CNY", new Dictionary<string, object?> { ["amount"] = 1e21 })));
            Assert.Equal("¥-1e+21", AsString(Run("amount | currency:CNY", new Dictionary<string, object?> { ["amount"] = -1e21 })));
        }
    }
}
