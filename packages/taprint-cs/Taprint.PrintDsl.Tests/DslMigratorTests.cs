// SPDX-License-Identifier: Apache-2.0
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using Json.Schema;
using Taprint.PrintDsl.Internal;
using Xunit;
using SCV = Taprint.PrintDsl;

// DslMigrator 测试（与 print-dsl-ts migrator.spec.ts 同构移植）：
// - detectVersion / migrate 内置链 / 恒等迁移深拷贝 / 版本文法防御 / schema 注入
//   门禁（对象 + 函数双形态） / registerStep 扩展 / clear 恢复 / 1.0→2.0 锚点
// 仓根 fixtures/templates/migration-* + fixtures/expected/parse-results/migration-*-result 为多语言实现锚点。
namespace Taprint.PrintDsl.Tests
{
    public class DslMigratorTests : IDisposable
    {
        private static readonly JsonSchema SchemaV1 = TestSchemas.V1;
        private static readonly JsonSchema SchemaV2 = TestSchemas.V2;

        public DslMigratorTests()
        {
            SCV.DslMigrator.Clear();  // 每个测试前恢复内置链
        }

        public void Dispose()
        {
            SCV.DslMigrator.Clear();  // 每个测试后清理自定义 step
        }

        private static object LegacyFixture() => RepoPaths.ReadJsonTree("fixtures/templates/migration-legacy-v09.json")!;
        private static object LegacyExpected() => RepoPaths.ExpectedJson("migration-legacy-v09-result.json")!;
        private static object V10Fixture() => RepoPaths.ReadJsonTree("fixtures/templates/migration-v10.json")!;
        private static object V10Expected() => RepoPaths.ExpectedJson("migration-v10-result.json")!;

        // ---------- detectVersion ----------

        [Fact]
        public void DetectVersion_业务v1报1_v2报2_无schemaVersion归0_9()
        {
            Assert.Equal("1.0", SCV.DslMigrator.DetectVersion(RepoPaths.ReadJsonTree("fixtures/templates/sales-note-v1.0.json")!));
            Assert.Equal("2.0", SCV.DslMigrator.DetectVersion(RepoPaths.ReadJsonTree("fixtures/templates/inventory-report-v2.0.json")!));
            Assert.Equal(SCV.DslMigrator.LegacyVersion, SCV.DslMigrator.DetectVersion(LegacyFixture()));
        }

        [Fact]
        public void DetectVersion_非对象或非文法抛错()
        {
            Assert.Throws<ArgumentException>(() => SCV.DslMigrator.DetectVersion(new Dictionary<string, object?> { ["schemaVersion"] = 1 }));
            Assert.Throws<ArgumentException>(() => SCV.DslMigrator.DetectVersion(new Dictionary<string, object?> { ["schemaVersion"] = "v1" }));
        }

        // ---------- migrate 内置链 ----------

        [Fact]
        public void Migrate_0_9到1_0锚点_迁移结果与expected逐字一致()
        {
            var migrated = SCV.DslMigrator.Migrate(LegacyFixture(), SCV.DslMigrator.LegacyVersion, "1.0");
            Assert.Equal(LegacyExpected(), migrated, new JsonDeepEquals());
            Assert.Equal("1.0", migrated["schemaVersion"]);
        }

        [Fact]
        public void Migrate_迁移后过对应版本schema()
        {
            var migrated = SCV.DslMigrator.Migrate(LegacyFixture(), SCV.DslMigrator.LegacyVersion, "1.0");
            Assert.True(SCV.DslValidator.Validate(migrated, SchemaV1).Valid);
            var migratedV2 = SCV.DslMigrator.Migrate(V10Fixture(), "1.0", SCV.DslMigrator.CurrentVersion);
            Assert.True(SCV.DslValidator.Validate(migratedV2, SchemaV2).Valid);
        }

        [Fact]
        public void Migrate_恒等迁移返回深拷贝_顶层与嵌套均不改入参()
        {
            var src = RepoPaths.ReadJsonTree("fixtures/templates/sales-note-v1.0.json")!;
            var srcDict = (IDictionary<string, object?>)src;
            var out_ = SCV.DslMigrator.Migrate(src, "1.0", "1.0");
            Assert.Equal(src, out_, new JsonDeepEquals());
            Assert.NotSame(src, out_);
            out_["name"] = "tampered";
            Assert.Equal("销售单-A4-标准", srcDict["name"]);
            // 嵌套也不共享
            var outPres = (IDictionary<string, object?>)out_["presentations"]!;
            var outDoc = (IDictionary<string, object?>)outPres["doc"]!;
            var outBody = (IList<object?>)outDoc["body"]!;
            var outFirst = (IDictionary<string, object?>)outBody[0]!;
            outFirst["type"] = "tampered";
            var srcPres = (IDictionary<string, object?>)srcDict["presentations"]!;
            var srcDoc = (IDictionary<string, object?>)srcPres["doc"]!;
            var srcBody = (IList<object?>)srcDoc["body"]!;
            var srcFirst = (IDictionary<string, object?>)srcBody[0]!;
            Assert.NotEqual("tampered", srcFirst["type"]);
        }

        [Fact]
        public void Migrate_入口深拷贝隔离_嵌套修改不波及入参()
        {
            var src = (IDictionary<string, object?>)LegacyFixture();
            var before = JsonSerializer.Serialize(src);
            var out_ = SCV.DslMigrator.Migrate(src, SCV.DslMigrator.LegacyVersion, SCV.DslMigrator.CurrentVersion);
            var outPres = (IDictionary<string, object?>)out_["presentations"]!;
            outPres["doc"] = new Dictionary<string, object?>();
            Assert.Equal(before, JsonSerializer.Serialize(src));
        }

        [Fact]
        public void Migrate_版本文法与方向防御()
        {
            Assert.Throws<ArgumentException>(() => SCV.DslMigrator.Migrate(new Dictionary<string, object?>(), "v1", "1.0"));
            Assert.Throws<ArgumentOutOfRangeException>(() => SCV.DslMigrator.Migrate(new Dictionary<string, object?>(), "1.0", "0.9"));
            Assert.Throws<InvalidOperationException>(() => SCV.DslMigrator.Migrate(new Dictionary<string, object?>(), "2.0", "2.1"));
        }

        [Fact]
        public void Migrate_注入schema时每步过校验门禁_坏步骤即拒()
        {
            SCV.DslMigrator.RegisterStep("1.0", dsl =>
            {
                var copy = new Dictionary<string, object?>(dsl) { ["schemaVersion"] = "1.1", ["name"] = 42 };
                return copy;
            });
            var ex = Assert.Throws<InvalidOperationException>(() =>
                SCV.DslMigrator.Migrate(new Dictionary<string, object?> { ["schemaVersion"] = "1.0" }, "1.0", "1.1", SchemaV1));
            Assert.Contains("未通过 schema 校验", ex.Message);
        }

        [Fact]
        public void Migrate_函数形态门禁按步产出版本选schema()
        {
            // 对象形态注入 v2 schema 会在 1.0 中间步被 ^2.x pattern 拒绝
            var exObj = Assert.Throws<InvalidOperationException>(() =>
                SCV.DslMigrator.Migrate(LegacyFixture(), SCV.DslMigrator.LegacyVersion, SCV.DslMigrator.CurrentVersion, SchemaV2));
            Assert.Contains("未通过 schema 校验", exObj.Message);

            // 函数形态按产出版本选 schema，pattern 分轨链必需
            Func<string, object> gate = v => v.StartsWith("2.") ? SchemaV2 : (object)SchemaV1;
            var migrated = SCV.DslMigrator.Migrate(LegacyFixture(), SCV.DslMigrator.LegacyVersion, SCV.DslMigrator.CurrentVersion, gate);
            Assert.Equal("2.0", migrated["schemaVersion"]);

            // 坏步骤在函数形态下同样被拦
            SCV.DslMigrator.RegisterStep(SCV.DslMigrator.LegacyVersion, dsl =>
            {
                var copy = new Dictionary<string, object?>(dsl) { ["schemaVersion"] = "1.0", ["id"] = 1 };
                return copy;
            });
            var exBad = Assert.Throws<InvalidOperationException>(() =>
                SCV.DslMigrator.Migrate(LegacyFixture(), SCV.DslMigrator.LegacyVersion, "1.0", gate));
            Assert.Contains("未通过 schema 校验", exBad.Message);
        }

        [Fact]
        public void Migrate_registerStep扩展自定义链_逐级推进()
        {
            SCV.DslMigrator.RegisterStep("1.0", dsl =>
            {
                var copy = new Dictionary<string, object?>(dsl) { ["schemaVersion"] = "1.1", ["migratedA"] = true };
                return copy;
            });
            SCV.DslMigrator.RegisterStep("1.1", dsl =>
            {
                var copy = new Dictionary<string, object?>(dsl) { ["schemaVersion"] = "2.0", ["migratedB"] = true };
                return copy;
            });
            var out_ = SCV.DslMigrator.Migrate(new Dictionary<string, object?> { ["schemaVersion"] = "1.0" }, "1.0", "2.0");
            Assert.Equal("2.0", out_["schemaVersion"]);
            Assert.Equal(true, out_["migratedA"]);
            Assert.Equal(true, out_["migratedB"]);
        }

        [Fact]
        public void Migrate_步骤未推进或越过目标均拒()
        {
            SCV.DslMigrator.RegisterStep("1.0", dsl =>
            {
                var copy = new Dictionary<string, object?>(dsl) { ["schemaVersion"] = "1.0" };
                return copy;
            });
            Assert.Throws<InvalidOperationException>(() =>
                SCV.DslMigrator.Migrate(new Dictionary<string, object?> { ["schemaVersion"] = "1.0" }, "1.0", "2.0"));

            SCV.DslMigrator.RegisterStep("1.0", dsl =>
            {
                var copy = new Dictionary<string, object?>(dsl) { ["schemaVersion"] = "3.0" };
                return copy;
            });
            Assert.Throws<InvalidOperationException>(() =>
                SCV.DslMigrator.Migrate(new Dictionary<string, object?> { ["schemaVersion"] = "1.0" }, "1.0", "2.0"));
        }

        [Fact]
        public void Migrate_clear恢复内置链()
        {
            SCV.DslMigrator.RegisterStep("1.0", dsl =>
            {
                var copy = new Dictionary<string, object?>(dsl) { ["schemaVersion"] = "9.9" };
                return copy;
            });
            SCV.DslMigrator.Clear();
            var out_ = SCV.DslMigrator.Migrate(LegacyFixture(), SCV.DslMigrator.LegacyVersion, SCV.DslMigrator.CurrentVersion);
            Assert.Equal("2.0", out_["schemaVersion"]);
            Assert.Throws<InvalidOperationException>(() =>
                SCV.DslMigrator.Migrate(new Dictionary<string, object?> { ["schemaVersion"] = "1.0" }, "1.0", "9.9"));
        }

        // ---------- 1.0 → 1.1 专项（label 域字段约定统一） ----------

        private static IDictionary<string, object?> LabelDoc(IList<object?> body)
        {
            return new Dictionary<string, object?>
            {
                ["schemaVersion"] = "1.0",
                ["id"] = "tpl_label_v11_probe",
                ["code"] = "LABEL_V11_PROBE",
                ["name"] = "v1.1 折算探针",
                ["presentations"] = new Dictionary<string, object?>
                {
                    ["label"] = new Dictionary<string, object?>
                    {
                        ["size"] = new Dictionary<string, object?> { ["width"] = "40mm", ["height"] = "30mm" },
                        ["body"] = body,
                    },
                },
            };
        }

        [Fact]
        public void Migrate_1_0到1_1_textSize0折1_qr超10折10_其余保字段()
        {
            var barcodeEl = new Dictionary<string, object?>
            {
                ["type"] = "barcode", ["content"] = "{{sku}}", ["symbology"] = "EAN13",
                ["x"] = "2mm", ["y"] = "20mm", ["height"] = "8mm",
            };
            var src = LabelDoc(new List<object?>
            {
                new Dictionary<string, object?> { ["type"] = "text", ["content"] = "{{name}}", ["x"] = "2mm", ["y"] = "2mm", ["font"] = "SIMPLIFIED CHINESE", ["size"] = 0d },
                new Dictionary<string, object?> { ["type"] = "text", ["content"] = "{{price}}", ["x"] = "2mm", ["y"] = "12mm", ["size"] = 3 },
                new Dictionary<string, object?> { ["type"] = "qrcode", ["content"] = "{{sku}}", ["x"] = "30mm", ["y"] = "20mm", ["size"] = 15d },
                new Dictionary<string, object?> { ["type"] = "qrcode", ["content"] = "{{sku}}", ["x"] = "30mm", ["y"] = "20mm", ["size"] = 4d },
                barcodeEl,
            });
            var out_ = SCV.DslMigrator.Migrate(src, "1.0", "1.1");
            Assert.Equal("1.1", out_["schemaVersion"]);
            var pres = (IDictionary<string, object?>)out_["presentations"]!;
            var label = (IDictionary<string, object?>)pres["label"]!;
            var body = (IList<object?>)label["body"]!;
            var text0 = (IDictionary<string, object?>)body[0]!;
            Assert.Equal(1d, text0["size"]); // 0 折 1
            Assert.Equal("SIMPLIFIED CHINESE", text0["font"]); // 其余字段保留
            Assert.Equal(3d, ((IDictionary<string, object?>)body[1]!)["size"]); // 合法值原样
            Assert.Equal(10d, ((IDictionary<string, object?>)body[2]!)["size"]); // >10 折 10（D4 降档事实）
            Assert.Equal(4d, ((IDictionary<string, object?>)body[3]!)["size"]); // 合法值原样
            Assert.True(System.Collections.Generic.EqualityComparer<object>.Default.Equals(null, null) && ((IEqualityComparer<object>)new JsonDeepEquals()).Equals(barcodeEl, body[4]!), "barcode 元素应原样保留");
        }

        [Fact]
        public void Migrate_1_0到1_1_无label文档仅推进版本()
        {
            var migrated = SCV.DslMigrator.Migrate(V10Fixture(), "1.0", "1.1");
            Assert.Equal("1.1", migrated["schemaVersion"]);
            var copy = new Dictionary<string, object?>(migrated);
            copy.Remove("schemaVersion");
            var src = (IDictionary<string, object?>)V10Fixture();
            Assert.True(((IEqualityComparer<object>)new JsonDeepEquals()).Equals(new Dictionary<string, object?>(src.Where(kv => kv.Key != "schemaVersion")), copy), "除 schemaVersion 外结构逐字不变");
        }

        [Fact]
        public void Migrate_1_0到1_1_入参嵌套对象不被改写()
        {
            var src = LabelDoc(new List<object?>
            {
                new Dictionary<string, object?> { ["type"] = "text", ["content"] = "{{name}}", ["x"] = "2mm", ["y"] = "2mm", ["size"] = 0d },
            });
            var before = System.Text.Json.JsonSerializer.Serialize(src);
            SCV.DslMigrator.Migrate(src, "1.0", "1.1");
            Assert.Equal(before, System.Text.Json.JsonSerializer.Serialize(src));
        }

        [Fact]
        public void Migrate_1_0到1_1_折算产物过v1_1schema_全链过v2_0schema()
        {
            var src = LabelDoc(new List<object?>
            {
                new Dictionary<string, object?> { ["type"] = "text", ["content"] = "{{name}}", ["x"] = "2mm", ["y"] = "2mm", ["size"] = 0d },
                new Dictionary<string, object?> { ["type"] = "qrcode", ["content"] = "{{sku}}", ["x"] = "30mm", ["y"] = "20mm", ["size"] = 20d },
            });
            var to11 = SCV.DslMigrator.Migrate(src, "1.0", "1.1");
            var r11 = SCV.DslValidator.Validate(to11, TestSchemas.V11);
            Assert.True(r11.Valid, string.Join("; ", r11.Errors.Select(e => e.Message)));
            var to20 = SCV.DslMigrator.Migrate(src, "1.0", SCV.DslMigrator.CurrentVersion);
            var r20 = SCV.DslValidator.Validate(to20, SchemaV2);
            Assert.True(r20.Valid, string.Join("; ", r20.Errors.Select(e => e.Message)));
        }

        // ---------- 1.0 → 2.0 专项锚点 ----------

        [Fact]
        public void Migrate_1_0到2_0_golden锚点_迁移结果与expected逐字一致()
        {
            var migrated = SCV.DslMigrator.Migrate(V10Fixture(), "1.0", SCV.DslMigrator.CurrentVersion);
            Assert.Equal(V10Expected(), migrated, new JsonDeepEquals());
            Assert.Equal("2.0", migrated["schemaVersion"]);
        }

        [Fact]
        public void Migrate_超集门禁_全部v1_0业务fixture迁移后过v2_0_schema()
        {
            var bizFiles = Directory.GetFiles(Path.Combine(RepoPaths.Root, "fixtures", "templates"))
                .Select(Path.GetFileName)
                .Where(f => f != null && f.EndsWith("-v1.0.json"))
                .Cast<string>()
                .OrderBy(f => f)
                .ToList();
            Assert.True(bizFiles.Count >= 10);
            foreach (var file in bizFiles)
            {
                var migrated = SCV.DslMigrator.Migrate(RepoPaths.ReadJsonTree($"fixtures/templates/{file}")!, "1.0", SCV.DslMigrator.CurrentVersion);
                var result = SCV.DslValidator.Validate(migrated, SchemaV2);
                Assert.True(result.Valid, $"{file}: {string.Join("; ", result.Errors.Select(e => e.Message))}");
            }
        }

        [Fact]
        public void Migrate_v2_0模板恒等迁移_降级拒绝()
        {
            var v2 = RepoPaths.ReadJsonTree("fixtures/templates/inventory-report-v2.0.json")!;
            var out_ = SCV.DslMigrator.Migrate(v2, "2.0", "2.0");
            Assert.Equal(v2, out_, new JsonDeepEquals());
            Assert.Throws<ArgumentOutOfRangeException>(() => SCV.DslMigrator.Migrate(v2, "2.0", "1.0"));
        }

        /// <summary>对象树深比较（IDictionary/IList 递归；与 TS toEqual 等价）。</summary>
        private sealed class JsonDeepEquals : IEqualityComparer<object>
        {
            bool IEqualityComparer<object>.Equals(object? a, object? b) => DeepEqual(a, b);
            int IEqualityComparer<object>.GetHashCode(object obj) => obj?.GetHashCode() ?? 0;

            private static bool DeepEqual(object? a, object? b)
            {
                if (ReferenceEquals(a, b)) return true;
                if (a is IDictionary<string, object?> da && b is IDictionary<string, object?> db)
                {
                    if (da.Count != db.Count) return false;
                    foreach (var kv in da)
                    {
                        if (!db.TryGetValue(kv.Key, out var bv) || !DeepEqual(kv.Value, bv)) return false;
                    }
                    return true;
                }
                if (a is IList<object?> la && b is IList<object?> lb)
                {
                    if (la.Count != lb.Count) return false;
                    for (var i = 0; i < la.Count; i++) if (!DeepEqual(la[i], lb[i])) return false;
                    return true;
                }
                if (a is double ad && b is double bd) return Math.Abs(ad - bd) < 1e-12;
                return Equals(a, b);
            }
        }
    }
}
