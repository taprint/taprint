// SPDX-License-Identifier: Apache-2.0
using System;
using System.Text;
using Taprint.PrintDsl;
using Xunit;

// ZPL 构造器测试（Java ZplRenderer v0.2 参照对拍移植，ADR-0001 内置字库路由）：
// - 帧序：^XA→^LH0,0→^PW→^LL→元素→[^PQ]→^XZ（份数 >1 才发 ^PQ）
// - ^FD 域转义（反斜杠先行 / ^ ~ 指令前缀）与多行逐行推进
// - 码制全表映射（含未知折 CODE128 的 Symbology.of 口径）
// - QR MA 三段一域、框线厚度夹取、坐标负值夹 0
// - 单位换算：mm→dot 中点远离零（ADR-0009，.NET 默认银行家舍入为反例基线）
// - GBK 内容通道：表内字符 2 字节原样、表外字符占位由注入编码承载（引擎侧纪律）
namespace Taprint.PrintDsl.Tests
{
    public class ZplBuilderTests
    {
        private static string AsciiText(byte[] frame)
        {
            return Encoding.ASCII.GetString(frame);
        }

        private static readonly Encoding Gbk = GbkEncoding();

        private static Encoding GbkEncoding()
        {
            Encoding.RegisterProvider(System.Text.CodePagesEncodingProvider.Instance);
            return Encoding.GetEncoding(936);
        }

        // ---- 帧骨架 ----

        [Fact]
        public void FrameHeader_EmitsStartHomeWidthLength()
        {
            Assert.Equal("^XA^LH0,0^PW480^LL320",
                AsciiText(ZplBuilder.FrameHeader(ZplBuilder.MmToDots(60d), ZplBuilder.MmToDots(40d))));
        }

        [Fact]
        public void FrameHeader_ClampsNegativeDimensionsToZero()
        {
            Assert.Equal("^XA^LH0,0^PW0^LL0", AsciiText(ZplBuilder.FrameHeader(-5, -1)));
            Assert.Equal("^FO0,0", AsciiText(ZplBuilder.FieldOrigin(-3, -4)));
        }

        [Fact]
        public void BuildLabel_FullFrameOrderWithoutPqWhenSingleCopy()
        {
            byte[] frame = ZplBuilder.BuildLabel(60, 40, 1, new[]
            {
                ZplLabelElement.Text("HELLO", 4, 18, 1),
            }, Gbk);
            Assert.Equal("^XA^LH0,0^PW480^LL320^FO32,144^A0N,28,28^FDHELLO^FS^XZ", AsciiText(frame));
        }

        [Fact]
        public void BuildLabel_EmitsPqOnlyWhenCopiesAboveOne()
        {
            byte[] multi = ZplBuilder.BuildLabel(60, 40, 3, new[]
            {
                ZplLabelElement.Text("X", 0, 0),
            }, Gbk);
            Assert.EndsWith("^PQ3^XZ", AsciiText(multi), StringComparison.Ordinal);

            byte[] single = ZplBuilder.BuildLabel(60, 40, 1, new[]
            {
                ZplLabelElement.Text("X", 0, 0),
            }, Gbk);
            Assert.EndsWith("^XZ", AsciiText(single), StringComparison.Ordinal);
            Assert.DoesNotContain("^PQ", AsciiText(single), StringComparison.Ordinal);
        }

        // ---- 文本 ----

        [Fact]
        public void EscapeFieldData_BackslashFirstThenCaretTilde()
        {
            Assert.Equal("a\\^b\\~c\\\\d", ZplBuilder.EscapeFieldData("a^b~c\\d"));
        }

        [Fact]
        public void TextLine_EmptyContentYieldsEmptySegment()
        {
            Assert.Empty(ZplBuilder.TextLine("", Gbk));
        }

        [Fact]
        public void TextLine_MultilineAdvancesByFontHeight()
        {
            byte[] frame = ZplBuilder.BuildLabel(60, 40, 1, new[]
            {
                ZplLabelElement.Text("A\nB", 4, 4, 2),
            }, Gbk);
            Assert.Equal("^XA^LH0,0^PW480^LL320"
                + "^FO32,32^A0N,56,56^FDA^FS"
                + "^FO32,88^A0N,56,56^FDB^FS^XZ", AsciiText(frame));
        }

        [Fact]
        public void TextLine_SizeClampedToDomain_OneToTen()
        {
            byte[] frame = ZplBuilder.BuildLabel(60, 40, 1, new[]
            {
                ZplLabelElement.Text("X", 0, 0, 15),
            }, Gbk);
            Assert.Contains("^A0N,280,280", AsciiText(frame), StringComparison.Ordinal);

            byte[] folded = ZplBuilder.BuildLabel(60, 40, 1, new[]
            {
                ZplLabelElement.Text("X", 0, 0, 0),
            }, Gbk);
            Assert.Contains("^A0N,28,28", AsciiText(folded), StringComparison.Ordinal);
        }

        // ---- 表外字符（内容通道） ----

        [Fact]
        public void ContentChannel_GbkTableBytesVerbatimAndOutsidePlaceholder()
        {
            // 注入 GBK（936）：表内字符 2 字节原样；表外字符占位形态由注入编码
            // 承载（构造器不判码表——引擎侧 ADR-0009 §3 纪律）。
            byte[] frame = ZplBuilder.BuildLabel(60, 40, 1, new[]
            {
                ZplLabelElement.Text("货位", 0, 0),
            }, Gbk);
            byte[] expected = Concat(
                Encoding.ASCII.GetBytes("^XA^LH0,0^PW480^LL320^FO0,0^A0N,28,28^FD"),
                new byte[] { 0xBB, 0xF5, 0xCE, 0xBB },
                Encoding.ASCII.GetBytes("^FS^XZ"));
            Assert.Equal(expected, frame);
        }

        // ---- 码制 ----

        [Fact]
        public void Barcode_Code128UsesByAndBcnFrames()
        {
            byte[] frame = ZplBuilder.BuildLabel(60, 40, 1, new[]
            {
                ZplLabelElement.Barcode("SKU-100086", "CODE128", 4, 22, 10),
            }, Gbk);
            Assert.Contains("^FO32,176^BY2,3,80^BCN,80,Y,N,N^FDSKU-100086^FS",
                AsciiText(frame), StringComparison.Ordinal);
        }

        [Fact]
        public void SymbologyCommand_FullTableAndUnknownFoldsToCode128()
        {
            Assert.Equal("^BEN,80,Y,N,N", ZplBuilder.SymbologyCommand("EAN13", 80));
            Assert.Equal("^BEN,80,Y,N", ZplBuilder.SymbologyCommand("EAN8", 80));
            Assert.Equal("^BUN,80,Y,N", ZplBuilder.SymbologyCommand("UPC", 80));
            Assert.Equal("^B3N,N,80,Y,N", ZplBuilder.SymbologyCommand("CODE39", 80));
            Assert.Equal("^B2N,80,N,N", ZplBuilder.SymbologyCommand("ITF", 80));
            // Java 参照 Symbology.of 缺省口径：未知码制折 CODE128（非静默丢帧）
            Assert.Equal("^BCN,80,Y,N,N", ZplBuilder.SymbologyCommand("PDF417", 80));
            Assert.Equal("^BCN,80,Y,N,N", ZplBuilder.SymbologyCommand("code128", 80));
        }

        [Fact]
        public void Barcode_EmptyContentYieldsEmptySegment()
        {
            Assert.Empty(ZplBuilder.Barcode("CODE128", 80, "", Gbk));
        }

        // ---- QR 与框线 ----

        [Fact]
        public void QrCode_MaFormWithSizeClampedToDomain()
        {
            Assert.Equal("^BQN,2,6^FDMA,TAPRINT^FS", AsciiText(ZplBuilder.QrCode(6, "TAPRINT", Gbk)));
            Assert.Equal("^BQN,2,1^FDMA,X^FS", AsciiText(ZplBuilder.QrCode(0, "X", Gbk)));
            Assert.Equal("^BQN,2,10^FDMA,X^FS", AsciiText(ZplBuilder.QrCode(99, "X", Gbk)));
            Assert.Empty(ZplBuilder.QrCode(6, "", Gbk));
        }

        [Fact]
        public void Box_DefaultThicknessTwoClampedToOne()
        {
            Assert.Equal("^GB448,288,2^FS", AsciiText(ZplBuilder.Box(448, 288)));
            Assert.Equal("^GB448,288,1^FS", AsciiText(ZplBuilder.Box(448, 288, 0)));
        }

        [Fact]
        public void LineAndRect_BothMapToGraphicBox()
        {
            byte[] frame = ZplBuilder.BuildLabel(60, 40, 1, new[]
            {
                ZplLabelElement.Line(2, 34, 56, 0.5),
                ZplLabelElement.Rect(2, 2, 56, 36),
            }, Gbk);
            string text = AsciiText(frame);
            // 线高 = height 折算下夹厚度（0.5mm → 4dot ≥ 2）
            Assert.Contains("^FO16,272^GB448,4,2^FS", text, StringComparison.Ordinal);
            Assert.Contains("^FO16,16^GB448,288,2^FS", text, StringComparison.Ordinal);
        }

        // ---- 单位换算（ADR-0009 中点） ----

        [Fact]
        public void MmToDots_MidpointRoundsAwayFromZero()
        {
            // 2.5 dot 精确中点：.NET 默认银行家舍入 2.5→2 是反例基线
            Assert.Equal(3, ZplBuilder.MmToDots(0.3125));
            Assert.Equal(-3, ZplBuilder.MmToDots(-0.3125));
            Assert.Equal(51, ZplBuilder.MmToDots(6.3125));
        }

        // ---- 工具 ----

        private static byte[] Concat(params byte[][] segments)
        {
            int total = 0;
            foreach (byte[] segment in segments)
            {
                total += segment.Length;
            }

            var frame = new byte[total];
            int offset = 0;
            foreach (byte[] segment in segments)
            {
                Array.Copy(segment, 0, frame, offset, segment.Length);
                offset += segment.Length;
            }

            return frame;
        }
    }
}
