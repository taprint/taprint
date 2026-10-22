// SPDX-License-Identifier: Apache-2.0
using System;
using System.Collections.Generic;
using System.Linq;
using Taprint.PrintDsl.Engine;
using Xunit;
using static Taprint.PrintDsl.Tests.FrameTools;

namespace Taprint.PrintDsl.Tests
{
    /// <summary>
    /// 两方言对齐面：同一份数据与内容经 esc-pos / tspl 两条引擎链产出字节流，
    /// 断言内容替换、编码、清洗、份数语义三面同口径；mm→dot 舍入与
    /// CpclBuilder（仓内第三方言）跨族一致（ADR-0009）。
    /// </summary>
    public class EngineDialectAlignmentTests
    {
        private const string Content = "货号A-123";

        private static IDictionary<string, object> Data() => new Dictionary<string, object>
        {
            ["item"] = new Dictionary<string, object> { ["code"] = Content },
        };

        [Fact]
        public void 同内容同数据_CJK字节两方言同编码()
        {
            byte[] expected = FrameTools.Gb(Content);

            // esc-pos 面：IR 文本行经 GB18030 落字节。
            var ticket = new PrintTicketIr { Columns = 48 };
            ticket.Lines.Add(new TicketLine(TicketLineKind.Text) { Text = Content });
            byte[] escpos = new EscPosTicketEngine(null).Build(ticket);

            // tspl 面：标签 TEXT 元素经同一 GB18030 编码注入（表达式已替换）。
            const string labelJson = @"
{ ""size"": { ""width"": ""40mm"", ""height"": ""30mm"" },
  ""body"": [ { ""type"": ""text"", ""content"": ""{{item.code}}"", ""x"": ""1mm"", ""y"": ""1mm"" } ] }";
            byte[] tspl = new TsplLabelEngine(null).Build(
                LabelTemplateLoader.Load(labelJson), Data(), 1);

            Assert.True(BytesContain(escpos, expected));
            byte[] textCommand = SplitCommands(tspl)[6];
            Assert.True(BytesContain(textCommand, expected));
        }

        [Fact]
        public void 码块内容_ASCII域清洗两方言同语义()
        {
            string dirty = "4001\u00d72345";   // ×（非可见 ASCII）→ '?'

            var ticket = new PrintTicketIr { Columns = 48 };
            ticket.Lines.Add(new TicketLine(TicketLineKind.Barcode) { Text = dirty, HeightDots = 40 });
            byte[] escpos = new EscPosTicketEngine(null).Build(ticket);
            Assert.Contains(System.Text.Encoding.ASCII.GetBytes("{B4001?2345"), escpos);

            // TSPL 构造器 AsciiSafe 同语义（internal 面对拍）。
            Assert.Equal("4001?2345", TsplBuilder.AsciiSafe(dirty));
        }

        [Fact]
        public void 帧结构字符清洗_引号换行剔除防碎裂()
        {
            // TSPL 引号串无转义文法：双引号与 CR/LF 全剔，防命令碎裂。
            Assert.Equal("abcd", TsplBuilder.Sanitize("a\"b\"c\r\nd"));
        }

        [Fact]
        public void 份数语义_TSPL单帧承载PRINTn_escpos无份数面()
        {
            const string labelJson = @"
{ ""size"": { ""width"": ""40mm"", ""height"": ""30mm"" },
  ""body"": [ { ""type"": ""text"", ""content"": ""x"", ""x"": ""1mm"", ""y"": ""1mm"" } ] }";
            var engine = new TsplLabelEngine(null);
            LabelTicketIr ir = LabelTemplateLoader.Load(labelJson);

            // 三份=一帧内 PRINT 3（禁客户端逐份循环重发）；三份与一份帧长相等（仅 PRINT 参数差 1 字节）。
            byte[] three = engine.Build(ir, Data(), 3);
            byte[] one = engine.Build(ir, Data(), 1);
            Assert.Equal(three.Length, one.Length);
            Assert.EndsWith("PRINT 3\r\n", Ascii(three));

            // esc-pos 面无份数承载（份数归调用方循环/业务层），方言分工登记。
            var ticket = new PrintTicketIr { Columns = 48 };
            ticket.Lines.Add(new TicketLine(TicketLineKind.Text) { Text = "x" });
            Assert.DoesNotContain("PRINT", Ascii(new EscPosTicketEngine(null).Build(ticket)));
        }

        [Fact]
        public void 行尾终结符_与CPCL构造器同冻结()
        {
            // TSPL/CPCL 均按手册通例 CR LF 收尾（Dart CPCL 为裸 LF 的真机差异以带 CR 形态冻结）。
            Assert.Equal(CpclBuilder.LineTerminator, TsplBuilder.LineTerminator);
            Assert.EndsWith(TsplBuilder.LineTerminator, Ascii(TsplBuilder.Cls()));
            Assert.EndsWith(TsplBuilder.LineTerminator, Ascii(TsplBuilder.Print(1)));
        }

        [Fact]
        public void 数值串形态_毫平米整形化跨构造器一致()
        {
            // 70 不发 "70.0"（SIZE 参数确定性）；与 CPCL 数值形态纪律同族。
            Assert.Equal("SIZE 70 mm,30 mm" + TsplBuilder.LineTerminator, Ascii(TsplBuilder.Size(70d, 30d)));
            Assert.Equal("GAP 2.5 mm,0 mm" + TsplBuilder.LineTerminator, Ascii(TsplBuilder.Gap(2.5d)));
        }

        [Fact]
        public async System.Threading.Tasks.Task 通道契约_SpoolerTicketChannel编帧直写复用()
        {
            // seam 组合面：EnsureOpen→Build→WriteRawAsync（假通道记录序）。
            var fake = new FakeChannel();
            var seam = new SpoolerTicketChannel(fake, new EscPosTicketEngine(null));
            var ticket = new PrintTicketIr { Columns = 32 };
            ticket.Lines.Add(new TicketLine(TicketLineKind.Text) { Text = "S" });

            await seam.PrintAsync(ticket, default);
            Assert.Equal(1, fake.EnsureOpenCalls);
            Assert.NotNull(fake.LastPayload);
            Assert.True(fake.LastPayload!.Length > 0);
            Assert.Equal("fake", fake.Transport);   // seam 透传通道形态，不自行改写
        }

        private sealed class FakeChannel : IPrinterChannel
        {
            public int EnsureOpenCalls;
            public byte[]? LastPayload;

            public string Transport => "fake";

            public void EnsureOpen()
            {
                EnsureOpenCalls++;
            }

            public System.Threading.Tasks.Task WriteRawAsync(byte[] data, System.Threading.CancellationToken cancellationToken)
            {
                LastPayload = data;
                return System.Threading.Tasks.Task.CompletedTask;
            }

            public void Dispose()
            {
            }
        }
    }
}
