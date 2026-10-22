// SPDX-License-Identifier: Apache-2.0
#nullable disable
using System;
using System.Collections.Generic;

namespace Taprint.PrintDsl.Engine
{
    // ============================================================
    // DSL 表达式/尺寸解析原语（表达式替换与尺寸语义同构上游票据仿真器；
    // 点路径段语法含数字索引（items.0.sku ⇔ items[0].sku），逐段走字典下钻/
    // 列表索引）。
    // ============================================================

    /// <summary>{{ path }} 表达式替换 + 点路径求值纯函数。</summary>
    public static class DslExpression
    {
        /// <summary>表达式开记号。</summary>
        private const string OpenMark = "{{";

        /// <summary>表达式闭记号。</summary>
        private const string CloseMark = "}}";

        /// <summary>
        /// 全串替换：非表达式文字原样保留；路径缺失/不可求值替换为空串
        /// （上游 substituteExpressions 宽容兜底同款，禁抛异常断渲染流）。
        /// </summary>
        public static string Substitute(string content, ExpressionScope scope)
        {
            if (string.IsNullOrEmpty(content))
            {
                return string.Empty;
            }

            string working = content;
            var builder = new System.Text.StringBuilder(working.Length + 16);
            int cursor = 0;
            while (cursor < working.Length)
            {
                int open = working.IndexOf(OpenMark, cursor, StringComparison.Ordinal);
                if (open < 0)
                {
                    builder.Append(working, cursor, working.Length - cursor);
                    break;
                }

                builder.Append(working, cursor, open - cursor);
                int close = working.IndexOf(CloseMark, open + OpenMark.Length, StringComparison.Ordinal);
                if (close < 0)
                {
                    // 未闭合花括号按字面量保留（仿真器宽容形态）。
                    builder.Append(working, open, working.Length - open);
                    break;
                }

                string path = working.Substring(open + OpenMark.Length, close - open - OpenMark.Length).Trim();
                builder.Append(ResolveContent(path, scope));
                cursor = close + CloseMark.Length;
            }

            return builder.ToString();
        }

        /// <summary>
        /// 内容求值（正典管道腿）：含 '|' 走滤器管道
        /// （{{path | date:'YYYY-MM-DD HH:mm'}}/{{x | currency:CNY}}）；解析失败（文法坏/
        /// 未知滤器名）＝null→空串（与路径缺失同面禁抛）；值面 null→各滤器缺省行为
        /// （currency→￥0.00、date→空）。不含 '|'＝旧点路径腿零变化。
        /// </summary>
        private static string ResolveContent(string content, ExpressionScope scope)
        {
            if (content != null && content.IndexOf('|') >= 0)
            {
                string piped = DslFilterPipeline.Evaluate(content, scope);
                return piped ?? string.Empty;
            }

            return scope != null ? scope.Resolve(content) : string.Empty;
        }

        /// <summary>
        /// 条件表达式最小判定：仅认「首个 {{path}} 的真值」——真值=非空且非 "0"/"false"
        /// （比较式等文法扩展位：与仓内内核 ExpressionCompiler 三端同构内核合流后切换，
        /// 本面如实不自创文法——登记遗留风险）。
        /// </summary>
        public static bool EvaluateTruthy(string condition, ExpressionScope scope)
        {
            if (string.IsNullOrEmpty(condition))
            {
                return false;
            }

            int open = condition.IndexOf(OpenMark, StringComparison.Ordinal);
            int close = open >= 0 ? condition.IndexOf(CloseMark, open + OpenMark.Length, StringComparison.Ordinal) : -1;
            if (open < 0 || close < 0)
            {
                return false;   // 无可判定路径引用：保守判假（宁不打印不少打印——对账安全侧）。
            }

            string path = condition.Substring(open + OpenMark.Length, close - open - OpenMark.Length).Trim();
            string value = scope != null ? scope.Resolve(path) : string.Empty;
            if (string.IsNullOrEmpty(value))
            {
                return false;
            }

            string normalized = value.Trim().ToLowerInvariant();
            return normalized != "false" && normalized != "0";
        }

        /// <summary>点路径求值独立面（分段扫描器免 Regex；返回 null=路径不存在）。</summary>
        public static object Lookup(IDictionary<string, object> data, string path)
        {
            if (data == null || string.IsNullOrWhiteSpace(path))
            {
                return null;
            }

            object current = data;
            int start = 0;
            for (int i = 0; i <= path.Length; i++)
            {
                if (i == path.Length || path[i] == '.')
                {
                    string segment = path.Substring(start, i - start);
                    if (!ResolveSegment(ref current, segment))
                    {
                        return null;
                    }

                    start = i + 1;
                }
            }

            return current;
        }

        /// <summary>单段下钻：字典键取/列表整数索引取；失败 false。</summary>
        private static bool ResolveSegment(ref object current, string segment)
        {
            var dict = current as IDictionary<string, object>;
            if (dict != null)
            {
                object next;
                if (dict.TryGetValue(segment, out next))
                {
                    current = next;
                    return true;
                }

                return false;
            }

            var list = current as IList<object>;
            int index;
            if (list != null && int.TryParse(segment, out index) && index >= 0 && index < list.Count)
            {
                current = list[index];
                return true;
            }

            return false;
        }
    }

    /// <summary>
    /// 行作用域链（loop 内层优先）。绑定语义同上游仿真器：loop 把
    /// data[source] 绑定到当前行走查，body 内 path 首段命中任一层即下钻。
    /// </summary>
    public sealed class ExpressionScope
    {
        private readonly IList<IDictionary<string, object>> _frames;

        /// <summary>构造（空帧链）。</summary>
        public ExpressionScope()
        {
            _frames = new List<IDictionary<string, object>>();
        }

        /// <summary>压入一层作用域帧（loop 迭代一行产生一层）。</summary>
        public void Push(IDictionary<string, object> frame)
        {
            _frames.Add(frame);
        }

        /// <summary>弹出一层。</summary>
        public void Pop()
        {
            if (_frames.Count > 0)
            {
                _frames.RemoveAt(_frames.Count - 1);
            }
        }

        /// <summary>路径求值：内层帧优先，命中首段后全路径下钻；无帧则用根数据由调用方另接。</summary>
        public string Resolve(string path)
        {
            for (int i = _frames.Count - 1; i >= 0; i--)
            {
                object value = DslExpression.Lookup(_frames[i], path);
                if (value != null)
                {
                    return DslValues.AsText(value);
                }
            }

            return string.Empty;
        }

        /// <summary>对象值求值变体（table 列字段取原始类型保留数值形态）。</summary>
        public object LookupObject(string path)
        {
            for (int i = _frames.Count - 1; i >= 0; i--)
            {
                object value = DslExpression.Lookup(_frames[i], path);
                if (value != null)
                {
                    return value;
                }
            }

            return null;
        }
    }

    /// <summary>DSL 尺寸属性解析（上游 parseDimensionDots 同语义）。</summary>
    public static class DslDimension
    {
        /// <summary>203dpi = 8 dot/mm（小票域冻结常量——票面 IR 恒 203，禁改语义；
        /// 标签域按设备档位走 MmToDots/ParseDots 重载）。</summary>
        public const int DotsPerMm = 8;

        /// <summary>标签域缺省 dots/mm（203dpi 工程值 8.0——保旧行为；300dpi=11.811）。</summary>
        public const double LabelDotsPerMmDefault = 8d;

        /// <summary>
        /// 标签域 mm→dot（dotsPerMm 由设备 labelDpi 派生：203→8.0 工程/300→11.811）。
        /// 舍入口径＝ADR-0009：显式 <see cref="MidpointRounding.AwayFromZero"/>（中点远离零）。
        /// .NET 默认 Math.Round 为银行家舍入（2.5→2、200.5→200），与 Java/Dart 端
        /// 半值口径不一致即字节漂移（多语言 golden 中点夹具按本口径冻结）；
        /// 与仓内 CpclBuilder.MmToDots 同一钉死口径。
        /// </summary>
        public static int MmToDots(double millimetres, double dotsPerMm)
        {
            return (int)Math.Round(millimetres * dotsPerMm, MidpointRounding.AwayFromZero);
        }

        /// <summary>数值=dot 直读；"nnn mm" 形态折算 dot（小票域 203 冻结口径）；非法返 fallback。</summary>
        public static int ParseDots(object raw, int fallback)
        {
            return ParseDots(raw, fallback, DotsPerMm);
        }

        /// <summary>标签域 dpi 感知版（mm 分支按 dotsPerMm 折算；裸数=dot 直读不折算——
        /// 任何 dpi 下 320 就是 320dot）。mm 分支经 MmToDots（ADR-0009 中点远离零）。</summary>
        public static int ParseDots(object raw, int fallback, double dotsPerMm)
        {
            if (raw is double)
            {
                return (int)Math.Round((double)raw);
            }

            if (raw is long)
            {
                return (int)(long)raw;
            }

            string text = raw as string;
            if (string.IsNullOrEmpty(text))
            {
                return fallback;
            }

            int end = text.Length;
            while (end > 0 && !char.IsDigit(text[end - 1]) && text[end - 1] != '.')
            {
                end--;
            }

            double value;
            if (end == 0 ||
                !double.TryParse(text.Substring(0, end), System.Globalization.NumberStyles.Float,
                    System.Globalization.CultureInfo.InvariantCulture, out value))
            {
                return fallback;
            }

            string tail = text.Substring(end).Trim().ToLowerInvariant();
            if (tail == "mm")
            {
                return MmToDots(value, dotsPerMm);
            }

            return (int)Math.Round(value);
        }
    }
}
