// SPDX-License-Identifier: Apache-2.0
using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using Taprint.PrintDsl.Engine;
using Xunit;
using static Taprint.PrintDsl.Tests.FrameTools;

namespace Taprint.PrintDsl.Tests
{
    /// <summary>
    /// TSPL 标签引擎帧序冻结：SIZE→[GAP|BLINE|（cont 不发）]→SPEED→DENSITY→
    /// SET TEAR（显式双态）→[DIRECTION]→CLS→元素集→PRINT n；帧尾禁 FORMFEED。
    /// 参数优先级=模板显式 > 设备键 > 引擎缺省。
    /// </summary>
    public class TsplLabelEngineTests
    {
        private const string FiveElementLabelJson = @"
{
  ""size"": { ""width"": ""40mm"", ""height"": ""30mm"" },
  ""gap"": ""3mm"",
  ""density"": 6,
  ""speed"": 2,
  ""body"": [
    { ""type"": ""text"", ""content"": ""货架{{shelf.no}}"", ""font"": ""SIMPLIFIED CHINESE"", ""size"": 2, ""x"": ""2mm"", ""y"": ""2mm"" },
    { ""type"": ""barcode"", ""content"": ""4001234567890"", ""symbology"": ""EAN13"", ""height"": ""8mm"", ""x"": ""2mm"", ""y"": ""8mm"" },
    { ""type"": ""qrcode"", ""content"": ""https://taprint.example/{{sku}}"", ""size"": 4, ""x"": ""30mm"", ""y"": ""20mm"" },
    { ""type"": ""line"", ""x"": ""2mm"", ""y"": ""28mm"", ""w"": ""20mm"", ""h"": ""0.5mm"" },
    { ""type"": ""box"", ""x"": ""24mm"", ""y"": ""20mm"", ""w"": ""10mm"", ""h"": ""5mm"", ""thickness"": ""0.25mm"" }
  ]
}";

        private static IDictionary<string, object> Data() => new Dictionary<string, object>
        {
            ["shelf"] = new Dictionary<string, object> { ["no"] = "A-07" },
            ["sku"] = "SKU-1",
        };

        private static LabelTicketIr Load(string json = FiveElementLabelJson)
        {
            return LabelTemplateLoader.Load(json);
        }

        [Fact]
        public void 帧序冻结_全序逐段钉死()
        {
            var engine = new TsplLabelEngine(null);
            byte[] frame = engine.Build(Load(), Data(), 2);

            var commands = SplitCommands(frame).Select(Ascii).ToList();
            Assert.Equal(new[]
            {
                "SIZE 40 mm,30 mm",
                "GAP 3 mm,0 mm",        // 模板显式 gap=3
                "SPEED 2",              // 模板显式
                "DENSITY 6",            // 模板显式
                "SET TEAR OFF",         // 显式双态（无设备键=OFF 也发）
                "CLS",
            }, commands.Take(6));

            // 元素面：TEXT/BARCODE/QRCODE/BAR/BOX 依 body 序；PRINT 2 收尾。
            Assert.StartsWith("TEXT 16,16,", commands[6]);
            Assert.StartsWith("BARCODE 16,64,", commands[7]);
            Assert.StartsWith("QRCODE 240,160,", commands[8]);
            Assert.Equal("BAR 16,224,160,4", commands[9]);
            Assert.Equal("BOX 192,160,80,40,2", commands[10]);
            Assert.Equal("PRINT 2", commands[11]);
            Assert.Equal(12, commands.Count);
        }

        [Fact]
        public void 帧尾禁FORMFEED_PRINT收位()
        {
            var engine = new TsplLabelEngine(null);
            byte[] frame = engine.Build(Load(), Data(), 1);
            // 真机定谳：定位介质上 PRINT 已送出完整一张，再跟 FORMFEED=多走一张空白。
            Assert.DoesNotContain("FORMFEED", Ascii(frame));
            Assert.EndsWith("PRINT 1\r\n", Ascii(frame));
        }

        [Fact]
        public void 文本内容_GB18030编码且表达式已替换()
        {
            var engine = new TsplLabelEngine(null);
            byte[] frame = engine.Build(Load(), Data(), 1);
            byte[] textCommand = SplitCommands(frame)[6];

            Assert.Contains(Gb("货架A-07"), textCommand);
            Assert.StartsWith("TEXT 16,16,\"SIMPLIFIED CHINESE\",0,2,2,\"", AsciiQuoted(textCommand));
            Assert.EndsWith("\"", AsciiQuoted(textCommand));
        }

        [Fact]
        public void 黑标纸_BLINE代替GAP_模板gap让位()
        {
            var engine = new TsplLabelEngine(null);
            var device = new LabelDeviceParams { GapType = "black", GapMm = 4d };
            byte[] frame = engine.Build(Load(), Data(), 1, device);

            var commands = SplitCommands(frame).Select(Ascii).ToList();
            Assert.Equal("BLINE 3 mm,0 mm", commands[1]);   // 黑标线高取模板 gap 值承载
            Assert.DoesNotContain(commands, c => c.StartsWith("GAP"));
        }

        [Fact]
        public void 连续纸_cont_GAP与BLINE皆不发()
        {
            var engine = new TsplLabelEngine(null);
            var device = new LabelDeviceParams { GapType = "cont" };
            byte[] frame = engine.Build(Load(), Data(), 1, device);

            var commands = SplitCommands(frame).Select(Ascii).ToList();
            Assert.Equal("SIZE 40 mm,30 mm", commands[0]);
            Assert.Equal("SPEED 2", commands[1]);   // cont 后紧接 SPEED——GAP/BLINE 缺席
            Assert.DoesNotContain(commands, c => c.StartsWith("GAP") || c.StartsWith("BLINE"));
        }

        [Fact]
        public void 参数优先级_模板显式大于设备键大于引擎缺省()
        {
            var engine = new TsplLabelEngine(null);
            var device = new LabelDeviceParams { GapMm = 5d, Density = 10, Speed = 7, TearOn = true };

            // 模板三项显式 → 设备键不参与；tear 设备键生效（模板无此面）。
            var withTemplate = SplitCommands(
                engine.Build(Load(), Data(), 1, device)).Select(Ascii).ToList();
            Assert.Equal("GAP 3 mm,0 mm", withTemplate[1]);
            Assert.Equal("SPEED 2", withTemplate[2]);
            Assert.Equal("DENSITY 6", withTemplate[3]);
            Assert.Equal("SET TEAR ON", withTemplate[4]);

            // 模板三项缺（无 gap/density/speed 的最小标签）→ 设备键接管。
            const string bareJson = @"
{ ""size"": { ""width"": ""40mm"", ""height"": ""30mm"" },
  ""body"": [ { ""type"": ""text"", ""content"": ""x"", ""x"": ""1mm"", ""y"": ""1mm"" } ] }";
            var deviceOnly = SplitCommands(
                engine.Build(LabelTemplateLoader.Load(bareJson), Data(), 1, device)).Select(Ascii).ToList();
            Assert.Equal("GAP 5 mm,0 mm", deviceOnly[1]);
            Assert.Equal("SPEED 7", deviceOnly[2]);
            Assert.Equal("DENSITY 10", deviceOnly[3]);

            // 设备也 null → 引擎缺省（2/4/8）。
            var defaults = SplitCommands(
                engine.Build(LabelTemplateLoader.Load(bareJson), Data(), 1, null)).Select(Ascii).ToList();
            Assert.Equal("GAP 2 mm,0 mm", defaults[1]);
            Assert.Equal("SPEED 4", defaults[2]);
            Assert.Equal("DENSITY 8", defaults[3]);
        }

        [Fact]
        public void Direction预留_有值才入帧且序位在CLS前()
        {
            var engine = new TsplLabelEngine(null);
            var device = new LabelDeviceParams { Direction = 1 };
            var commands = SplitCommands(engine.Build(Load(), Data(), 1, device)).Select(Ascii).ToList();

            int directionIndex = commands.FindIndex(c => c == "DIRECTION 1");
            Assert.True(directionIndex > 0);
            Assert.Equal("CLS", commands[directionIndex + 1]);

            var without = SplitCommands(engine.Build(Load(), Data(), 1)).Select(Ascii).ToList();
            Assert.DoesNotContain(without, c => c.StartsWith("DIRECTION"));
        }

        [Fact]
        public void 越界与不可映射元素_丢弃并告警不炸()
        {
            const string json = @"
{ ""size"": { ""width"": ""40mm"", ""height"": ""30mm"" },
  ""body"": [
    { ""type"": ""image"", ""src"": ""logo.png"", ""x"": ""1mm"", ""y"": ""1mm"" },
    { ""type"": ""text"", ""content"": ""inside"", ""x"": ""2mm"", ""y"": ""2mm"" },
    { ""type"": ""text"", ""content"": ""outside"", ""x"": ""50mm"", ""y"": ""2mm"" }
  ] }";
            var warnings = new List<string>();
            var log = new EngineLog(warnings.Add, null);
            var engine = new TsplLabelEngine(log);

            var commands = SplitCommands(engine.Build(LabelTemplateLoader.Load(json), Data(), 1))
                .Select(Ascii).ToList();

            Assert.Equal(2, warnings.Count);   // Unsupported 跳过 + 坐标出画布丢弃
            Assert.Contains(warnings, w => w.Contains("无 TSPL 映射"));
            Assert.Contains(warnings, w => w.Contains("出画布"));
            Assert.Single(commands, c => c.StartsWith("TEXT"));   // 只剩 in-canvas 文本
            Assert.DoesNotContain(commands, c => AsciiQuoted(Encoding.ASCII.GetBytes(c)).Contains("outside"));
        }

        [Fact]
        public void 份数域_至少1_零负拒打()
        {
            var engine = new TsplLabelEngine(null);
            Assert.Throws<ArgumentOutOfRangeException>(() => engine.Build(Load(), Data(), 0));
            Assert.Throws<ArgumentNullException>(() => engine.Build(null!, Data(), 1));
        }

        [Fact]
        public void CommandSet方言标识()
        {
            Assert.Equal("tspl", new TsplLabelEngine(null).CommandSet);
            Assert.Equal("esc-pos", new EscPosTicketEngine(null).CommandSet);
        }

        [Fact]
        public void 装载器_必填面违约即畸形异常()
        {
            // 缺 size / 缺 x/y / 缺 content / 空 body → LabelIrMalformed(8409)。
            Assert.Throws<PrintDomainException>(() => LabelTemplateLoader.Load(@"{""body"":[{""type"":""text"",""content"":""x"",""x"":""1mm"",""y"":""1mm""}]}"));
            Assert.Throws<PrintDomainException>(() => LabelTemplateLoader.Load(
                @"{""size"":{""width"":""40mm"",""height"":""30mm""},""body"":[{""type"":""text"",""content"":""x"",""x"":""1mm""}]}"));
            Assert.Throws<PrintDomainException>(() => LabelTemplateLoader.Load(
                @"{""size"":{""width"":""40mm"",""height"":""30mm""},""body"":[{""type"":""text"",""x"":""1mm"",""y"":""1mm""}]}"));
            Assert.Throws<PrintDomainException>(() => LabelTemplateLoader.Load(
                @"{""size"":{""width"":""40mm"",""height"":""30mm""},""body"":[]}"));

            var ex = Assert.Throws<PrintDomainException>(() => LabelTemplateLoader.Load("not json"));
            Assert.Equal(LabelPrintErrorCode.LabelIrMalformed, ex.Code);
        }

        [Fact]
        public void 装载器_长度单位换算_mm主单位cm_pt_px()
        {
            const string json = @"
{ ""size"": { ""width"": ""4cm"", ""height"": ""30mm"" },
  ""gap"": ""0.5mm"",
  ""body"": [ { ""type"": ""text"", ""content"": ""u"", ""x"": ""1mm"", ""y"": ""1mm"" } ] }";
            LabelTicketIr ir = LabelTemplateLoader.Load(json);
            Assert.Equal(40d, ir.WidthMm);        // 4cm→40mm
            Assert.Equal(0.5d, ir.GapMm);
            Assert.Equal(320, ir.WidthDots);      // 40mm×8
        }
    }
}
