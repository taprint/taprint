// SPDX-License-Identifier: Apache-2.0
using System;
using System.Globalization;

// ECMA-262 Number::toString(10) 复刻——全内核唯一数字出口（canonical 写出、
// 表达式拼接/过滤器的数字→字符串均经此函数）。锁定物：fixture v4
//（0.1/1.0/1e2/2.5 → 0.1/1/100/2.5）与 EcmaNumberTests 黄金表（多语言实现同源）。
// C# 各内建格式器（"R"/"G"/Utf8JsonWriter）在指数文法、-0、阈值上与 JS 不一致，
// 禁止绕过本函数直接格式化 double。
namespace Taprint.PrintDsl.Internal
{
    internal static class EcmaNumber
    {
        private const double MaxSafeInteger = 9007199254740992; // 2^53

        public static string Format(double value)
        {
            if (double.IsNaN(value) || double.IsInfinity(value))
            {
                throw new ArgumentException("非 JSON-safe 数字（NaN/Infinity）", nameof(value));
            }
            if (value == 0) return "0"; // 含 -0（JS (-0).toString() === "0"）
            var negative = value < 0;
            var v = Math.Abs(value);
            var prefix = negative ? "-" : "";

            // 整数捷径：≤ 2^53 的整数值精确可表示，最短数字串即全位数字
            //（> 2^53 的整数值须走一般路径按最短串补零，如 JS 12345678901234567890 → ...67000）
            if (v <= MaxSafeInteger && v == Math.Truncate(v))
            {
                return prefix + ((long)v).ToString(CultureInfo.InvariantCulture);
            }

            // 最短往返数字串：精度 p=1..17 递增取首个可往返者（等价 ECMA「最少数字位数」+
            // 等长取最接近值的取舍；InvariantCulture "G" 输出已无尾随零）
            string g = "";
            for (var p = 1; p <= 17; p++)
            {
                var candidate = v.ToString("G" + p, CultureInfo.InvariantCulture);
                if (double.Parse(candidate, NumberStyles.Float, CultureInfo.InvariantCulture) == v)
                {
                    g = candidate;
                    break;
                }
            }

            // 解析 "G" 输出（形如 "123" / "1.23" / "1.23E+20"）为 digits + n（ECMA 6.1.6.1.20：
            // value = Σ d_i × 10^(n-i)，n 为十进制小数点位置）
            var exp = 0;
            var mantissa = g;
            var eIdx = g.IndexOf('E');
            if (eIdx >= 0)
            {
                mantissa = g.Substring(0, eIdx);
                exp = int.Parse(g.Substring(eIdx + 1), CultureInfo.InvariantCulture);
            }
            var dot = mantissa.IndexOf('.');
            var dotIndex = dot >= 0 ? dot : mantissa.Length;
            var raw = mantissa.Replace(".", "");
            var lz = 0;
            while (lz < raw.Length && raw[lz] == '0') lz++;
            var digits = raw.Substring(lz);
            var n = dotIndex + exp - lz;
            var k = digits.Length;

            string text;
            if (k <= n && n <= 21)
            {
                text = digits + new string('0', n - k);
            }
            else if (n > 0 && n <= 21)
            {
                text = digits.Substring(0, n) + "." + digits.Substring(n);
            }
            else if (n > -6 && n <= 0)
            {
                text = "0." + new string('0', -n) + digits;
            }
            else
            {
                var expText = "e" + (n - 1 >= 0 ? "+" : "-") + Math.Abs(n - 1).ToString(CultureInfo.InvariantCulture);
                text = k == 1 ? digits + expText : digits[0] + "." + digits.Substring(1) + expText;
            }
            return prefix + text;
        }
    }
}
