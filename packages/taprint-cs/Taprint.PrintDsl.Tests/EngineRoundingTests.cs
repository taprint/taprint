// SPDX-License-Identifier: Apache-2.0
using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using Taprint.PrintDsl.Engine;
using Xunit;

namespace Taprint.PrintDsl.Tests
{
    /// <summary>
    /// ADR-0009 舍入口径钉死：mm→dot 折算=中点远离零（AwayFromZero），
    /// .NET 默认银行家舍入（2.5→2）被显式覆盖；中点夹具逐值断言，
    /// 并与仓内 CpclBuilder.MmToDots 做跨方言一致性对拍。
    /// </summary>
    public class EngineRoundingTests
    {
        [Theory]
        [InlineData(0.3125d, 8d, 3)]     // 0.3125×8=2.5 → 银行家 2 / 远离零 3
        [InlineData(25.0625d, 8d, 201)]  // 200.5 → 银行家 200 / 远离零 201
        [InlineData(1.0d, 8d, 8)]
        [InlineData(0.0625d, 8d, 1)]     // 0.5 → 银行家 0 / 远离零 1
        [InlineData(1.0d, 11.811d, 12)]  // 300dpi 工程值
        [InlineData(0.2119856d, 11.811d, 3)] // 2.5047… 非中点常规值
        public void MmToDots_中点远离零_逐值钉死(double mm, double dotsPerMm, int expected)
        {
            Assert.Equal(expected, DslDimension.MmToDots(mm, dotsPerMm));
        }

        [Theory]
        [InlineData(0.3125d)]
        [InlineData(25.0625d)]
        [InlineData(0.0625d)]
        public void MmToDots_与CpclBuilder跨方言同口径(double mm)
        {
            // 两构造器族（TSPL 装载链 vs CPCL 构造器）共享 ADR-0009 钉死口径，
            // 同输入必同输出——漂移即多语言 golden 面违约。
            Assert.Equal(
                CpclBuilder.MmToDots(mm, 8d),
                DslDimension.MmToDots(mm, 8d));
        }

        [Fact]
        public void MmToDots_银行家舍入差异位_显式区分()
        {
            // 反向钉：若回归 .NET 默认（MidpointRounding.ToEven），下列值全变。
            Assert.Equal(3, DslDimension.MmToDots(0.3125d, 8d));
            Assert.NotEqual(2, DslDimension.MmToDots(0.3125d, 8d));
            Assert.Equal(201, DslDimension.MmToDots(25.0625d, 8d));
            Assert.NotEqual(200, DslDimension.MmToDots(25.0625d, 8d));
        }

        [Theory]
        [InlineData("6mm", 48)]     // mm 串形态：折算一次（6mm×8）
        [InlineData(6L, 6)]         // 裸数=dot 直读不折算（mm 口径归调用方契约，如 qr size）
        [InlineData(6.0d, 6)]
        [InlineData(320d, 320)]
        [InlineData("320", 320)]
        [InlineData("junk", 24)]    // 非法= fallback
        [InlineData("", 24)]
        public void ParseDots_mm串折算与裸数dot直读(object raw, int expected)
        {
            Assert.Equal(expected, DslDimension.ParseDots(raw, 24));
        }

        [Fact]
        public void ParseDots_mm串中点折算走AwayFromZero()
        {
            // 0.3125mm × 8 = 2.5 → 3（mm 分支经 MmToDots，同口径）。
            Assert.Equal(3, DslDimension.ParseDots("0.3125mm", 24, 8d));
        }
    }

    /// <summary>帧切分工具：按 CR LF 切命令段（TSPL/CPCL 帧结构断言共用）。</summary>
    internal static class FrameTools
    {
        public static List<byte[]> SplitCommands(byte[] frame)
        {
            var segments = new List<byte[]>();
            int start = 0;
            for (int i = 0; i + 1 < frame.Length; i++)
            {
                if (frame[i] == 0x0D && frame[i + 1] == 0x0A)
                {
                    segments.Add(frame.Skip(start).Take(i - start).ToArray());
                    i++;
                    start = i + 1;
                }
            }

            if (start < frame.Length)
            {
                segments.Add(frame.Skip(start).ToArray());
            }

            return segments;
        }

        public static string Ascii(byte[] segment)
        {
            return Encoding.ASCII.GetString(segment);
        }

        public static string AsciiQuoted(byte[] segment)
        {
            // ASCII 段里混 GB18030 内容字节：按 Latin1 保形解码便于 Contains 断言英文骨架。
            return Encoding.Latin1.GetString(segment);
        }

        public static byte[] Gb(string text)
        {
            Encoding.RegisterProvider(System.Text.CodePagesEncodingProvider.Instance);
            return Encoding.GetEncoding("GB18030").GetBytes(text);
        }

        /// <summary>子字节序列包含判定（xunit 无 byte[] 子序列 Contains，自持）。</summary>
        public static bool BytesContain(byte[] haystack, params byte[] needle)
        {
            if (needle.Length == 0)
            {
                return true;
            }

            for (int i = 0; i + needle.Length <= haystack.Length; i++)
            {
                int j = 0;
                while (j < needle.Length && haystack[i + j] == needle[j])
                {
                    j++;
                }

                if (j == needle.Length)
                {
                    return true;
                }
            }

            return false;
        }
    }
}
