// SPDX-License-Identifier: Apache-2.0
using System;
using System.Collections.Generic;
using System.Linq;
using Taprint.PrintDsl.Engine;
using Xunit;

namespace Taprint.PrintDsl.Tests
{
    /// <summary>
    /// ESC/POS 出票引擎帧面冻结：初始化三态（ESC @ / FS & 选卡 / 收尾走纸）、
    /// 文本行命令序、码块命令族、CJK 排版原语。
    /// </summary>
    public class EscPosTicketEngineTests
    {
        private static EscPosTicketEngine Engine() => new EscPosTicketEngine(null);

        private static byte[] Build(params TicketLine[] lines)
        {
            var ticket = new PrintTicketIr { Columns = 48 };
            foreach (TicketLine line in lines)
            {
                ticket.Lines.Add(line);
            }

            return Engine().Build(ticket);
        }

        private static bool Contains(byte[] haystack, params byte[] needle)
        {
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

        [Fact]
        public void 帧头三态_ESC初始化_中文选卡_收尾走纸()
        {
            byte[] frame = Build(new TicketLine(TicketLineKind.Text) { Text = "HELLO" });

            Assert.Equal(0x1B, frame[0]);
            Assert.Equal(0x40, frame[1]);           // ESC @
            Assert.Equal(0x1C, frame[2]);           // FS &（缺省选卡）
            Assert.Equal(0x26, frame[3]);

            // 收尾走纸 8 行（撕纸位推出）。
            byte[] tail = { 0x1B, 0x64, 0x08 };
            Assert.True(Contains(frame, tail));
        }

        [Fact]
        public void epson42档_不发中文选卡()
        {
            var ticket = new PrintTicketIr { Columns = 48 };
            ticket.Lines.Add(new TicketLine(TicketLineKind.Text) { Text = "HELLO" });

            byte[] frame = Engine().Build(ticket, false);
            Assert.False(Contains(frame, 0x1C, 0x26));   // FS & 缺席
            Assert.True(Contains(frame, 0x1B, 0x40));    // ESC @ 仍在
        }

        [Fact]
        public void 文本行命令序_对齐_字号_GB18030正文_复位()
        {
            TicketLine line = new TicketLine(TicketLineKind.Text)
            {
                Text = "合计中文",
                Align = "center",
                FontScale = 2,
            };

            byte[] frame = Build(line);
            byte[] alignCenter = { 0x1B, (byte)'a', 0x01 };
            byte[] scale2 = { 0x1D, (byte)'!', 0x11 };
            byte[] scaleReset = { 0x1D, (byte)'!', 0x00 };

            Assert.True(Contains(frame, alignCenter));
            Assert.True(Contains(frame, scale2));
            Assert.True(Contains(frame, FrameTools.Gb("合计中文")));
            // 每行复原：scaleReset 出现于 scale2 之后（防倍率泄漏到后续行）。
            Assert.True(Array.IndexOf(frame, (byte)0x11) < Array.LastIndexOf(frame, (byte)0x00));
            Assert.True(Contains(frame, scaleReset));
        }

        [Fact]
        public void 切纸行_8行走纸后半切()
        {
            byte[] frame = Build(new TicketLine(TicketLineKind.Cut));
            Assert.True(Contains(frame, 0x1B, 0x64, 0x08));   // ESC d 8
            Assert.True(Contains(frame, 0x1D, 0x56, 0x42, 0x00)); // GS V 66 0
        }

        [Fact]
        public void QR码_GS括k命令族_cn49在场()
        {
            TicketLine qr = new TicketLine(TicketLineKind.QrCode) { Text = "ORDER-1", HeightDots = 48 };
            byte[] frame = Build(qr);

            // function 165 model：GS ( k 04 00 31 41 32 00（cn=0x31 在场——缺即静默不打）。
            Assert.True(Contains(frame, 0x1D, (byte)'(', (byte)'k', 0x04, 0x00, 0x31, (byte)'A', (byte)'2', 0x00));
            // function 181 print。
            Assert.True(Contains(frame, 0x1D, (byte)'(', (byte)'k', 0x03, 0x00, 0x31, (byte)'Q', (byte)'0'));
        }

        [Fact]
        public void 条码_GS高度前置_GSk_CODE128B子集()
        {
            TicketLine barcode = new TicketLine(TicketLineKind.Barcode) { Text = "4001234567890", HeightDots = 64 };
            byte[] frame = Build(barcode);

            Assert.True(Contains(frame, 0x1D, (byte)'h', 64));       // GS h n
            Assert.True(Contains(frame, 0x1D, (byte)'k', 73));       // GS k m=CODE128
            Assert.True(Contains(frame, System.Text.Encoding.ASCII.GetBytes("{B4001234567890")));
        }

        [Fact]
        public void 表格行_权重分摊列预算()
        {
            TicketLine row = new TicketLine(TicketLineKind.TableRow);
            row.Columns.Add(new KeyValuePair<string, int>("商品", 3));
            row.Columns.Add(new KeyValuePair<string, int>("12.50", 1));

            byte[] frame = Build(row);
            Assert.True(Contains(frame, FrameTools.Gb("商品")));
            Assert.True(Contains(frame, System.Text.Encoding.ASCII.GetBytes("12.50")));
        }

        [Fact]
        public void 键值行_键栏右对齐值栏左贴()
        {
            TicketLine kv = new TicketLine(TicketLineKind.KeyValue) { Key = "应收", Text = "￥25.00" };
            byte[] frame = Build(kv);
            Assert.True(Contains(frame, FrameTools.Gb("应收")));
            Assert.True(Contains(frame, FrameTools.Gb("￥25.00")));
        }

        [Fact]
        public void 未知行种类_告警跳过不炸()
        {
            var warnings = new List<string>();
            var engine = new EscPosTicketEngine(new EngineLog(warnings.Add, null));
            var ticket = new PrintTicketIr { Columns = 48 };
            ticket.Lines.Add(new TicketLine((TicketLineKind)99));

            byte[] frame = engine.Build(ticket);
            Assert.Single(warnings);
            Assert.Contains("未知 IR 行种类", warnings[0]);
            Assert.True(frame.Length > 0);
        }

        [Fact]
        public void 静默日志面_默认零依赖不炸()
        {
            var ticket = new PrintTicketIr { Columns = 32 };
            ticket.Lines.Add(new TicketLine((TicketLineKind)99));
            byte[] frame = new EscPosTicketEngine(null).Build(ticket);
            Assert.True(frame.Length > 0);
        }

        // ---------- CJK 排版原语（internal 面） ----------

        [Theory]
        [InlineData("abc", 10, "left", "abc       ")]
        [InlineData("abc", 10, "right", "       abc")]
        [InlineData("abc", 10, "center", "   abc    ")]
        [InlineData("中a", 10, "left", "中a       ")]   // CJK 双宽计列：宽=3
        [InlineData("a中b", 3, "left", "a中")]           // 超宽按显示宽截断（双宽不劈半）
        public void PadText_CJK双宽计列与三档对齐(string text, int columns, string align, string expected)
        {
            Assert.Equal(expected, EscPosTicketEngine.PadText(text, columns, align));
        }

        [Theory]
        [InlineData("中a", 2, "中")]    // 放不下双宽字=整字舍弃
        [InlineData("中a", 3, "中a")]
        [InlineData("abcd", 2, "ab")]
        public void TruncateToWidth_双宽不劈半(string text, int maxWidth, string expected)
        {
            Assert.Equal(expected, EscPosTicketEngine.TruncateToWidth(text, maxWidth));
        }

        [Theory]
        [InlineData("中文A", 5)]      // 2+2+1
        [InlineData("abc", 3)]
        [InlineData("", 0)]
        [InlineData("￥1", 3)]        // 全角 ￥（U+FFE5 区）双宽
        public void DisplayWidth_CJK全角双宽(string text, int expected)
        {
            Assert.Equal(expected, EscPosTicketEngine.DisplayWidth(text));
        }

        [Fact]
        public void EscPosBuilder_命令字节冻结()
        {
            Assert.Equal(new byte[] { 0x1B, 0x40 }, EscPosBuilder.Initialize());
            Assert.Equal(new byte[] { 0x0A }, EscPosBuilder.LineFeed());
            Assert.Equal(new byte[] { 0x1B, 0x64, 0x03 }, EscPosBuilder.FeedLines(3));
            Assert.Equal(new byte[] { 0x1D, 0x56, 0x42, 0x00 }, EscPosBuilder.CutPaper());
            Assert.Equal(new byte[] { 0x1C, 0x26 }, EscPosBuilder.SelectChineseEncoding());
            Assert.Equal(new byte[] { 0x1B, 0x70, 0, 25, 250 }, EscPosBuilder.DrawerKickPulse(0, 25, 250));
            Assert.Throws<ArgumentOutOfRangeException>(() => EscPosBuilder.DrawerKickPulse(2, 1, 1));
        }
    }
}
