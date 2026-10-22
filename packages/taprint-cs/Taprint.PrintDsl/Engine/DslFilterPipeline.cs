// SPDX-License-Identifier: Apache-2.0
#nullable disable
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;

namespace Taprint.PrintDsl.Engine
{
    // ============================================================
    // 表达式过滤管道（双参照移植：服务端 FilterRegistry + 移动端镜像，语义逐条对齐）。
    //
    // - 文法＝Liquid 风格 `路径 | 滤器名[:'单引号参数']` 多段左折叠
    //   （上游 ExpressionParser.parsePipeline 口径；参数仅字面量）；
    // - 滤器名白名单 11 枚解析期校验（上游 FILTERS 同名单，漂移即两端口径分叉），
    //   未知名＝解析失败→整段空串，非「当路径」；
    // - 失败语义二分：解析失败（文法/未知滤器名）→整段空串；
    //   值面 null→按各滤器缺省行为（currency→￥0.00、date→空串——保「以在线为准」口径）。
    // 实现形态：纯函数、零依赖 DslValues.AsText 之外的运行时面。
    // ============================================================

    /// <summary>{{ path | filter }} 管道求值纯函数（11 滤器全量）。</summary>
    public static class DslFilterPipeline
    {
        /// <summary>滤器白名单（上游 FILTERS 同名单——漂移即两端口径分叉）。</summary>
        private static readonly HashSet<string> FilterNames = new HashSet<string>
        {
            "date", "currency", "round", "sum", "avg", "min", "max",
            "count", "truncate", "mask", "default"
        };

        // CNY 用全角 ￥（U+FFE5，GBK A2E3）：半角 ¥（U+00A5）在小票机大字号/驱动字体下
        // 缺字形渲染成「?」（真机实拍合计行实证；服务端滤器同款修正）。
        private static readonly Dictionary<string, string> CurrencySymbols = new Dictionary<string, string>
        {
            { "CNY", "￥" }, { "USD", "$" }, { "EUR", "€" }, { "GBP", "£" },
            { "JPY", "JP￥" }, { "HKD", "HK$" }, { "KRW", "₩" }, { "TWD", "NT$" }
        };

        /// <summary>零小数位币种（上游 ZERO_DECIMAL_CURRENCIES 同名单）。</summary>
        private static readonly HashSet<string> ZeroDecimalCurrencies = new HashSet<string> { "JPY", "KRW" };

        /// <summary>字符串日期解析模板（上游 toDate 同清单；不含 ISO T 形——契约实证）。</summary>
        private static readonly string[] DatePatterns =
        {
            "yyyy-MM-dd HH:mm:ss", "yyyy-MM-dd HH:mm", "yyyy-MM-dd",
            "yyyy/MM/dd HH:mm:ss", "yyyy/MM/dd"
        };

        /// <summary>
        /// 求值入口：内容＝{{...}} 内侧原文。返回 null＝解析失败（文法/未知滤器——调用方置空串，
        /// 与「路径缺失置空」同面不抛）。无管道（不含 '|'）＝null 由调用方走旧路径腿。
        /// </summary>
        public static string Evaluate(string content, ExpressionScope scope)
        {
            List<string> segments = SplitRespectingQuotes(content, '|');
            if (segments.Count == 0)
            {
                return null;
            }

            string path = segments[0].Trim();
            object value = scope != null ? scope.LookupObject(path) : null;

            for (int i = 1; i < segments.Count; i++)
            {
                FilterCall call = ParseCall(segments[i]);
                if (call == null)
                {
                    return null;   // 文法坏（无名字/参数形态不识）→解析失败。
                }

                value = Apply(call, value);
            }

            return DslValues.AsText(value);
        }

        /// <summary>滤器调用形态（name[:arg]）。</summary>
        private sealed class FilterCall
        {
            public string Name;
            public string Arg;
            public bool HasArg;
        }

        private static FilterCall ParseCall(string raw)
        {
            string text = raw == null ? string.Empty : raw.Trim();
            if (text.Length == 0)
            {
                return null;
            }

            var call = new FilterCall();
            int colon = IndexOutsideQuotes(text, ':');
            if (colon < 0)
            {
                call.Name = text;
                return FilterNames.Contains(call.Name) ? call : null;
            }

            call.Name = text.Substring(0, colon).Trim();
            if (!FilterNames.Contains(call.Name))
            {
                return null;
            }

            string arg = text.Substring(colon + 1).Trim();
            if (arg.Length >= 2 && arg[0] == '\'' && arg[arg.Length - 1] == '\'')
            {
                arg = arg.Substring(1, arg.Length - 2);
            }
            else if (arg.Length == 0)
            {
                return null;
            }

            call.Arg = arg;
            call.HasArg = true;
            return call;
        }

        private static object Apply(FilterCall call, object value)
        {
            switch (call.Name)
            {
                case "date":
                    return Date(value, call.HasArg ? call.Arg : "YYYY-MM-DD");
                case "currency":
                    return Currency(value, call.HasArg ? call.Arg : "CNY");
                case "round":
                    return Round(value, call.HasArg ? ParseInt(call.Arg, 0) : 0);
                case "sum":
                    return Aggregate(value, call.HasArg ? call.Arg : null, "sum");
                case "avg":
                    return Aggregate(value, call.HasArg ? call.Arg : null, "avg");
                case "min":
                    return Aggregate(value, call.HasArg ? call.Arg : null, "min");
                case "max":
                    return Aggregate(value, call.HasArg ? call.Arg : null, "max");
                case "count":
                    return Count(value);
                case "truncate":
                    return Truncate(value, call.HasArg ? ParseInt(call.Arg, 0) : 0);
                case "mask":
                    return Mask(value, call.HasArg ? call.Arg : string.Empty);
                case "default":
                    return Truthy(value) ? value : (call.HasArg ? call.Arg : string.Empty);
                default:
                    return null;
            }
        }

        // ---------- date（上游 date 滤器同语义） ----------

        private static string Date(object value, string pattern)
        {
            DateTime? date = ToDate(value);
            if (date == null)
            {
                return string.Empty;
            }

            return date.Value.ToString(ToClrPattern(pattern), CultureInfo.InvariantCulture);
        }

        private static DateTime? ToDate(object value)
        {
            if (value == null)
            {
                return null;
            }

            if (value is DateTime)
            {
                return (DateTime)value;
            }

            if (value is double || value is long || value is int)
            {
                // epoch 毫秒（JsonElement 数值经 AsNumber 归一为 double）。
                double epoch = Convert.ToDouble(value, CultureInfo.InvariantCulture);
                return new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Local).AddMilliseconds(epoch);
            }

            string text = value as string;
            if (!string.IsNullOrEmpty(text))
            {
                text = text.Trim();
                for (int i = 0; i < DatePatterns.Length; i++)
                {
                    DateTime parsed;
                    if (DateTime.TryParseExact(text, DatePatterns[i], CultureInfo.InvariantCulture,
                        DateTimeStyles.None, out parsed))
                    {
                        return parsed;
                    }
                }
            }

            return null;
        }

        /// <summary>DSL 占位符→CLR 模式（YYYY→yyyy、DD→dd；上游 toJavaPattern 同映射——MM/mm/HH/ss 原样）。</summary>
        private static string ToClrPattern(string pattern)
        {
            var sb = new StringBuilder(pattern == null ? string.Empty : pattern);
            sb.Replace("YYYY", "yyyy").Replace("DD", "dd");
            return sb.ToString();
        }

        // ---------- currency（同语义：千分位+HALF_UP+null→符号+0.00） ----------

        private static string Currency(object value, string code)
        {
            string symbol;
            if (!CurrencySymbols.TryGetValue(code, out symbol))
            {
                symbol = code + " ";
            }

            decimal amount;
            if (!TryToDecimal(value, out amount))
            {
                amount = 0m;   // null/非数值→￥0.00（上游同款缺省）。
            }

            int scale = ZeroDecimalCurrencies.Contains(code) ? 0 : 2;
            decimal scaled = Math.Round(amount, scale, MidpointRounding.AwayFromZero);
            return symbol + FormatGrouped(scaled, scale);
        }

        private static string FormatGrouped(decimal value, int scale)
        {
            bool negative = value < 0m;
            decimal abs = Math.Abs(value);
            string fixedText = abs.ToString("F" + scale.ToString(CultureInfo.InvariantCulture), CultureInfo.InvariantCulture);
            int dot = fixedText.IndexOf('.');
            string intPart = dot >= 0 ? fixedText.Substring(0, dot) : fixedText;
            string fracPart = dot >= 0 ? fixedText.Substring(dot) : string.Empty;

            var sb = new StringBuilder();
            for (int i = 0; i < intPart.Length; i++)
            {
                if (i > 0 && (intPart.Length - i) % 3 == 0)
                {
                    sb.Append(',');
                }

                sb.Append(intPart[i]);
            }

            return (negative ? "-" : string.Empty) + sb + fracPart;
        }

        // ---------- round（HALF_UP；digits<=0→整数） ----------

        private static object Round(object value, int digits)
        {
            decimal amount;
            if (!TryToDecimal(value, out amount))
            {
                return null;
            }

            decimal rounded = Math.Round(amount, digits, MidpointRounding.AwayFromZero);
            return digits <= 0 ? (object)Convert.ToInt64(rounded) : rounded;
        }

        // ---------- sum/avg/min/max（集合聚合；非集合 sum→0 其余 null） ----------

        private static object Aggregate(object value, string field, string op)
        {
            var list = value as IList<object>;
            if (list == null)
            {
                return string.Equals(op, "sum", StringComparison.Ordinal) ? (object)0m : null;
            }

            decimal? total = null;
            decimal? min = null;
            decimal? max = null;
            int n = 0;
            for (int i = 0; i < list.Count; i++)
            {
                object raw = field == null ? list[i] : ExtractField(list[i], field);
                decimal item;
                if (!TryToDecimal(raw, out item))
                {
                    continue;
                }

                total = total == null ? item : total.Value + item;
                min = min == null || item < min.Value ? item : min;
                max = max == null || item > max.Value ? item : max;
                n++;
            }

            switch (op)
            {
                case "sum":
                    return total == null ? 0m : total.Value;
                case "avg":
                    if (total == null || n == 0)
                    {
                        return 0m;
                    }

                    decimal avg = total.Value / n;
                    return decimal.Round(avg, 10, MidpointRounding.AwayFromZero);
                case "min":
                    return min;
                case "max":
                    return max;
                default:
                    return null;
            }
        }

        private static object ExtractField(object item, string field)
        {
            object current = item;
            string[] segments = field.Split('.');
            for (int i = 0; i < segments.Length; i++)
            {
                var dict = current as IDictionary<string, object>;
                if (dict == null || !dict.TryGetValue(segments[i], out current))
                {
                    return null;
                }
            }

            return current;
        }

        // ---------- count/truncate/mask/default ----------

        private static int Count(object value)
        {
            var list = value as IList<object>;
            if (list != null)
            {
                return list.Count;
            }

            var dict = value as IDictionary<string, object>;
            if (dict != null)
            {
                return dict.Count;
            }

            return value as string != null ? ((string)value).Length : 0;
        }

        private static string Truncate(object value, int maxLen)
        {
            if (value == null)
            {
                return string.Empty;
            }

            string text = DslValues.AsText(value);
            if (text.Length <= maxLen)
            {
                return text;
            }

            return maxLen <= 3 ? text.Substring(0, maxLen) : text.Substring(0, maxLen - 3) + "...";
        }

        private static string Mask(object value, string pattern)
        {
            if (value == null)
            {
                return string.Empty;
            }

            string text = DslValues.AsText(value);
            if (string.IsNullOrEmpty(pattern))
            {
                return new string('*', text.Length);
            }

            var sb = new StringBuilder();
            for (int i = 0; i < pattern.Length; i++)
            {
                char p = pattern[i];
                if (p == '*')
                {
                    sb.Append('*');
                }
                else
                {
                    sb.Append(i < text.Length ? text[i] : p);
                }
            }

            return sb.ToString();
        }

        /// <summary>真值（上游 EcmaValue.truthy 同口径：非空非零非 false）。</summary>
        private static bool Truthy(object value)
        {
            if (value == null)
            {
                return false;
            }

            if (value is string)
            {
                string text = (string)value;
                return text.Length > 0 && text != "0" && text != "false";
            }

            if (value is bool)
            {
                return (bool)value;
            }

            if (value is double || value is long || value is int || value is decimal)
            {
                return Convert.ToDecimal(value, CultureInfo.InvariantCulture) != 0m;
            }

            return true;
        }

        // ---------- 原语 ----------

        private static bool TryToDecimal(object value, out decimal result)
        {
            result = 0m;
            if (value == null)
            {
                return false;
            }

            if (value is decimal)
            {
                result = (decimal)value;
                return true;
            }

            if (value is double || value is long || value is int || value is float)
            {
                try
                {
                    result = Convert.ToDecimal(value, CultureInfo.InvariantCulture);
                    return true;
                }
                catch (OverflowException)
                {
                    return false;
                }
            }

            if (value is string)
            {
                return decimal.TryParse((string)value, NumberStyles.Float,
                    CultureInfo.InvariantCulture, out result);
            }

            return false;
        }

        private static int ParseInt(string text, int fallback)
        {
            int value;
            return int.TryParse(text, NumberStyles.Integer, CultureInfo.InvariantCulture, out value) ? value : fallback;
        }

        /// <summary>按分隔符切分（引号内不切——防参数串里含 '|' 的错切）。</summary>
        private static List<string> SplitRespectingQuotes(string text, char separator)
        {
            var parts = new List<string>();
            var current = new StringBuilder();
            if (text == null)
            {
                parts.Add(string.Empty);
                return parts;
            }

            bool inQuote = false;
            for (int i = 0; i < text.Length; i++)
            {
                char c = text[i];
                if (c == '\'')
                {
                    inQuote = !inQuote;
                    current.Append(c);
                }
                else if (c == separator && !inQuote)
                {
                    parts.Add(current.ToString());
                    current.Length = 0;
                }
                else
                {
                    current.Append(c);
                }
            }

            parts.Add(current.ToString());
            return parts;
        }

        private static int IndexOutsideQuotes(string text, char target)
        {
            bool inQuote = false;
            for (int i = 0; i < text.Length; i++)
            {
                if (text[i] == '\'')
                {
                    inQuote = !inQuote;
                }
                else if (text[i] == target && !inQuote)
                {
                    return i;
                }
            }

            return -1;
        }
    }
}
