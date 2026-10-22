// SPDX-License-Identifier: Apache-2.0
using Taprint.PrintDsl.Internal;
using Xunit;

// ECMA-262 Number::toString(10) 黄金表——期望值经 Node 导出（多语言实现同源），
// 与 fixture v4（0.1/1.0/1e2/2.5 → 0.1/1/100/2.5）双重锁定 canonical 数字文法。
namespace Taprint.PrintDsl.Tests
{
    public class EcmaNumberTests
    {
        public static TheoryData<double, string> Golden => new TheoryData<double, string>
        {
            { 0d, "0" },
            { -0d, "0" },
            { 0.1, "0.1" },
            { 1d, "1" },
            { 2.5, "2.5" },
            { 100d, "100" },
            { 1e-7, "1e-7" },
            { 1e-6, "0.000001" },
            { 1e21, "1e+21" },
            { 1e20, "100000000000000000000" },
            { 1e22, "1e+22" },
            { 0.1 + 0.2, "0.30000000000000004" },
            { 3.14, "3.14" },
            { -3.14, "-3.14" },
            { -2.5, "-2.5" },
            { 9007199254740992d, "9007199254740992" },
            { 1e15, "1000000000000000" },
            { 1e16, "10000000000000000" },
            { 12345678901234567890d, "12345678901234567000" },
            { 123.456, "123.456" },
            { 5e-324, "5e-324" },
            { double.MaxValue, "1.7976931348623157e+308" },
            { 2.2250738585072014e-308, "2.2250738585072014e-308" },
            { 1.5e300, "1.5e+300" },
            { 0.00000123, "0.00000123" },
            { 10000000000000000000d, "10000000000000000000" },
        };

        [Theory]
        [MemberData(nameof(Golden))]
        public void Format_MatchesJsNumberToString(double value, string expected)
        {
            Assert.Equal(expected, EcmaNumber.Format(value));
        }

        [Fact(DisplayName = "EcmaNumber：拒绝 NaN/Infinity（JSON 非法）")]
        public void RejectsNonFinite()
        {
            Assert.Throws<System.ArgumentException>(() => EcmaNumber.Format(double.NaN));
            Assert.Throws<System.ArgumentException>(() => EcmaNumber.Format(double.PositiveInfinity));
        }
    }
}
