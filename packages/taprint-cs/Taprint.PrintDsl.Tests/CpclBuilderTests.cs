// SPDX-License-Identifier: Apache-2.0
using System;
using System.Text;
using Taprint.PrintDsl;
using Xunit;

// CPCL 构造器测试（与 Java CPCL 渲染器 / Dart CPCL 编码器双参照对拍移植）：
// - 帧序：格式头（! 坐标系指令）在首、FORM/PRINT 成对收尾
// - TEXT/BARCODE/QRCODE 字节序列冻结（空格分隔参数、内容不带引号、QR 三段式）
// - 对齐/切纸/线框命令面
// - 单位换算：mm→dot 中点远离零（ADR-0009，.NET 默认银行家舍入为反例基线）
namespace Taprint.PrintDsl.Tests
{
    public class CpclBuilderTests
    {
        private static string AsciiText(byte[] frame)
        {
            return Encoding.ASCII.GetString(frame);
        }

        // ---- 帧序与格式头（! 坐标系指令）----

        [Fact]
        public void FormatHeader_EmitsCoordinateSystemFrameWithSpaceSeparatedParams()
        {
            // ! offset horz vert height qty：200 DPI（8 dot/mm），20mm 高 → 160 dot，份数 2。
            byte[] frame = CpclBuilder.FormatHeader(CpclBuilder.MmToDots(20d), 2);
            Assert.Equal("! 0 200 200 160 2\r\n", AsciiText(frame));
        }

        [Fact]
        public void FormatHeader_ClampsHeightAndQuantityToOne()
        {
            Assert.Equal("! 0 200 200 1 1\r\n", AsciiText(CpclBuilder.FormatHeader(0, 0)));
        }

        [Fact]
        public void FullFrame_OrderIsHeaderBodyFormThenPrint()
        {
            byte[] frame = Concat(
                CpclBuilder.FormatHeader(CpclBuilder.MmToDots(30d), 1),
                CpclBuilder.Text(4, 0, 8, 16, "HELLO", Encoding.ASCII),
                CpclBuilder.Form(),
                CpclBuilder.Print());
            string text = AsciiText(frame);
            Assert.StartsWith("! 0 200 200 240 1\r\n", text);
            Assert.EndsWith("TEXT 4 0 8 16 HELLO\r\nFORM\r\nPRINT\r\n", text);
            // FORM 必须在 PRINT 之前（收口成对，序不可倒）。
            Assert.True(text.IndexOf("FORM\r\n", StringComparison.Ordinal)
                < text.IndexOf("PRINT\r\n", StringComparison.Ordinal));
        }

        // ---- TEXT ----

        [Fact]
        public void Text_SpaceSeparatedParamsUnquotedContentAndClampedFontSize()
        {
            // font/size 越界夹回 0-7（9,9 → 7,7）；内容不带引号、CR LF 收尾。
            Assert.Equal("TEXT 4 1 8 16 HELLO\r\n",
                AsciiText(CpclBuilder.Text(4, 1, 8, 16, "HELLO", Encoding.ASCII)));
            Assert.Equal("TEXT 7 7 0 0 X\r\n",
                AsciiText(CpclBuilder.Text(9, 9, 0, 0, "X", Encoding.ASCII)));
        }

        [Fact]
        public void Text_EncodingInjectedForCjkContent()
        {
            // 内容段编码由调用方注入（引擎侧 GB18030 纪律）：UTF-8 承载 CJK 的字节形状。
            byte[] frame = CpclBuilder.Text(CpclBuilder.DefaultTextFont, 0, 0, 0, "标签", Encoding.UTF8);
            byte[] expected = Concat(
                Encoding.ASCII.GetBytes("TEXT 4 0 0 0 "),
                Encoding.UTF8.GetBytes("标签"),
                Encoding.ASCII.GetBytes("\r\n"));
            Assert.Equal(expected, frame);
        }

        [Fact]
        public void Text_SanitizesLineBreaksToSpacesToProtectUnquotedFrame()
        {
            // CPCL 内容不带引号、行尾结束——CR/LF 混入即碎帧，清洗为空格（保留间隔语义）。
            Assert.Equal("TEXT 4 0 0 0 A  B\r\n",
                AsciiText(CpclBuilder.Text(4, 0, 0, 0, "A\r\nB", Encoding.ASCII)));
        }

        // ---- BARCODE ----

        [Fact]
        public void Barcode_FrozenFrameCode128WithMmHeightConversion()
        {
            // BARCODE type width ratio height x y content；高度 10mm → 80 dot。
            Assert.Equal("BARCODE 128 2 1 80 8 16 ABC-123\r\n",
                AsciiText(CpclBuilder.Barcode("CODE128", CpclBuilder.MmToDots(10d), 8, 16, "ABC-123")));
        }

        [Fact]
        public void Barcode_SymbologyMapWhitelistAndRejection()
        {
            Assert.Equal("128", CpclBuilder.MapSymbology("CODE128"));
            Assert.Equal("EAN13", CpclBuilder.MapSymbology("ean13"));
            Assert.Equal("EAN8", CpclBuilder.MapSymbology("EAN8"));
            Assert.Equal("UPCA", CpclBuilder.MapSymbology("UPC"));
            Assert.Equal("39", CpclBuilder.MapSymbology("CODE39"));
            Assert.Equal("I2OF5", CpclBuilder.MapSymbology("ITF"));
            // 白名单外抛异常——调用方按业务决定拒绝不印，禁止静默改码制。
            Assert.Throws<ArgumentException>(() => CpclBuilder.MapSymbology("CODE93"));
        }

        [Fact]
        public void Barcode_BarcodeTextHriFollowsSameUnquotedShape()
        {
            Assert.Equal("BARCODE-TEXT 4 0 8 16 ABC-123\r\n",
                AsciiText(CpclBuilder.BarcodeText(4, 0, 8, 16, "ABC-123", Encoding.ASCII)));
        }

        [Fact]
        public void Barcode_DegradesNonAsciiContentToQuestionMark()
        {
            // 码制字符域=可见 ASCII，域外降 '?'（与 TSPL 构造器同语义）。
            Assert.Equal("BARCODE 128 2 1 80 0 0 ?A?\r\n",
                AsciiText(CpclBuilder.Barcode("CODE128", 80, 0, 0, "中A文")));
        }

        // ---- QR 三段式 ----

        [Fact]
        public void QrCode_ThreeSegmentOrderAndUnitClamp()
        {
            // 段序：BARCODE QR x y M 2 U n → M0A,data → ENDQR；单元大小夹 1-32（33→32）。
            Assert.Equal("BARCODE QR 8 16 M 2 U 7\r\nM0A,DATA\r\nENDQR\r\n",
                AsciiText(CpclBuilder.QrCode(8, 16, 7, "DATA", Encoding.ASCII)));
            Assert.Equal("BARCODE QR 0 0 M 2 U 32\r\nM0A,DATA\r\nENDQR\r\n",
                AsciiText(CpclBuilder.QrCode(0, 0, 33, "DATA", Encoding.ASCII)));
        }

        // ---- LINE / BOX ----

        [Fact]
        public void LineAndBox_FramesClampThicknessToOne()
        {
            Assert.Equal("LINE 0 8 80 8 2\r\n",
                AsciiText(CpclBuilder.Line(0, 8, 80, 8, 2)));
            Assert.Equal("LINE 0 8 80 8 1\r\n",
                AsciiText(CpclBuilder.Line(0, 8, 80, 8, 0)));
            Assert.Equal("BOX 0 0 80 40 2\r\n",
                AsciiText(CpclBuilder.Box(0, 0, 80, 40, 2)));
        }

        // ---- 对齐 / 切纸 ----

        [Fact]
        public void Align_EmitsLeftCenterRightTokens()
        {
            Assert.Equal("LEFT\r\n", AsciiText(CpclBuilder.Align(CpclAlignment.Left)));
            Assert.Equal("CENTER\r\n", AsciiText(CpclBuilder.Align(CpclAlignment.Center)));
            Assert.Equal("RIGHT\r\n", AsciiText(CpclBuilder.Align(CpclAlignment.Right)));
        }

        [Fact]
        public void Cut_EmitsCutFrameForCutterModels()
        {
            Assert.Equal("CUT\r\n", AsciiText(CpclBuilder.Cut()));
        }

        // ---- 单位换算（ADR-0009：中点远离零）----

        [Fact]
        public void MmToDots_MidpointRoundsAwayFromZero()
        {
            // 2.5 → 3（.NET 默认银行家舍入会得 2 —— ADR-0009 钉死远离零，此处即反例断言）。
            Assert.Equal(3, CpclBuilder.MmToDots(2.5d, 1d));
            // 负中点同样远离零：-2.5 → -3（Java Math.round 的 -2.5→-2 口径为已知差异面）。
            Assert.Equal(-3, CpclBuilder.MmToDots(-2.5d, 1d));
            // 真实 8 dot/mm 档的中点：0.3125mm×8 = 2.5 → 3。
            Assert.Equal(3, CpclBuilder.MmToDots(0.3125d, 8d));
            // 非中点不受影响。
            Assert.Equal(2, CpclBuilder.MmToDots(2.4d, 1d));
            Assert.Equal(3, CpclBuilder.MmToDots(2.6d, 1d));
        }

        [Fact]
        public void MmToDots_DefaultsToEightDotsPerMmAndAcceptsDpiDerivedDensity()
        {
            // 缺省 200 DPI 工程值 8 dot/mm；300 DPI 档 11.811 由调用方传入。
            Assert.Equal(240, CpclBuilder.MmToDots(30d));
            Assert.Equal(150, CpclBuilder.MmToDots(12.7d, 11.811d));
        }

        private static byte[] Concat(params byte[][] chunks)
        {
            int total = 0;
            foreach (byte[] chunk in chunks)
            {
                total += chunk.Length;
            }

            var frame = new byte[total];
            int offset = 0;
            foreach (byte[] chunk in chunks)
            {
                Array.Copy(chunk, 0, frame, offset, chunk.Length);
                offset += chunk.Length;
            }

            return frame;
        }
    }
}
