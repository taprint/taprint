// SPDX-License-Identifier: Apache-2.0
#nullable disable
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.Json;
using Taprint.PrintDsl.Engine;
using Xunit;

// ADR-0010 golden 分层 C# runner（脚本就绪 · 标注未启用）。
//
// 现状：C# 侧命令面（TsplBuilder/CpclBuilder/EscPosTicketEngine）与 canonical
// 用例模型（fixtures/cases，schema taprint/golden-case@1）的映射已具形——
// 首版接线只做「就绪+标注」（本仓约定），全部用例以 Skip 登记，待
// docs/conformance.md 中 C# 差异清单过评审后逐协议启用断言。
// 启用路径：去掉对应 Fact 的 Skip → 按 fixtures/README.md §runner 跑
// dotnet test --filter GoldenCommandConformance。
namespace Taprint.PrintDsl.Tests
{
    public class GoldenCommandConformance
    {
        private const string SkipReason =
            "ADR-0010 首版接线：Java 参照 + TS runner 先行；C# 启用前须按 docs/conformance.md 对齐构造器面（TSPL TEXT 字库缺省/QR 参数形态/CPCL 行尾等）";

        private static readonly string CommandsRoot = Path.Combine(
            RepoPaths.Root, "fixtures", "expected", "commands");

        private static readonly JsonDocument Manifest = JsonDocument.Parse(File.ReadAllText(
            Path.Combine(RepoPaths.Root, "fixtures", "manifest.json")));

        private static IEnumerable<(string CaseId, string Protocol, JsonElement Entry)> Cases()
        {
            foreach (var entry in Manifest.RootElement.GetProperty("cases").EnumerateArray())
            {
                var id = entry.GetProperty("case").GetString();
                foreach (var protocol in entry.GetProperty("protocols").EnumerateArray())
                {
                    yield return (id, protocol.GetString(), entry);
                }
            }
        }

        private static int CaseCount =>
            Manifest.RootElement.GetProperty("cases").GetArrayLength();

        [Fact(Skip = SkipReason)]
        public void ManifestCarriesLayerPolicy()
        {
            // L1 全量、L2 仅绿格；身份函数用例必须 L1-only（ADR-0007/0010）
            foreach (var entry in Manifest.RootElement.GetProperty("cases").EnumerateArray())
            {
                Assert.True(entry.GetProperty("layers").GetProperty("l1").GetBoolean());
                if (entry.GetProperty("containsIdentityFn").GetBoolean())
                {
                    Assert.False(entry.GetProperty("layers").GetProperty("l2").GetBoolean());
                }
            }
        }

        [Fact(Skip = SkipReason)]
        public void ReferenceFramesExistForEachCase()
        {
            Assert.True(CaseCount >= 40, "golden 用例集不完整");
            foreach (var (id, protocol, _) in Cases())
            {
                var frames = Path.Combine(CommandsRoot, id, "java", $"{protocol}.frames.txt");
                Assert.True(File.Exists(frames), $"缺参照帧工件: {frames}");
            }
        }

        [Fact(Skip = SkipReason)]
        public void TsplFrameOrderForLabelCasesMatchesReference()
        {
            // 映射示范：canonical 用例 → C# TsplBuilder 命令面（启用后逐帧比对）。
            // 帧序断言口径与 Java 参照一致：SIZE→GAP→DENSITY→SPEED→DIRECTION→CLS→body→PRINT。
            foreach (var (id, protocol, entry) in Cases())
            {
                if (protocol != "tspl")
                {
                    continue;
                }
                var l2 = entry.GetProperty("l2Assert");
                _ = l2.TryGetProperty("cs", out var csGreen) && csGreen.GetBoolean();
                var frames = File.ReadAllLines(
                    Path.Combine(CommandsRoot, id, "java", "tspl.frames.txt"), Encoding.UTF8);
                Assert.Contains(frames, line => line.EndsWith("|SIZE|"));
                Assert.Equal("PRINT", frames.Last().Split('|')[1]);
            }
        }

        [Fact(Skip = SkipReason)]
        public void CpclFrameOrderForLabelCasesMatchesReference()
        {
            foreach (var (id, protocol, _) in Cases().Where(c => c.Protocol == "cpcl"))
            {
                var frames = File.ReadAllLines(
                    Path.Combine(CommandsRoot, id, "java", "cpcl.frames.txt"), Encoding.UTF8);
                Assert.Contains("|HEADER|", frames[0], StringComparison.Ordinal);
                Assert.Equal("FORM", frames[frames.Length - 2].Split('|')[1]);
                Assert.Equal("PRINT", frames[frames.Length - 1].Split('|')[1]);
            }
        }
    }
}
