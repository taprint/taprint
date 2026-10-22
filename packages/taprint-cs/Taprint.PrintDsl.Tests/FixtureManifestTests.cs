// SPDX-License-Identifier: Apache-2.0
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using Json.Schema;
using Xunit;
using SCV = Taprint.PrintDsl;

// fixture-manifest 驱动遍历测试（Scope 4）：读 packages/print-dsl-ts/tests/generated/fixture-manifest.json
// （fixture-codegen 产物，多语言实现共享真值清单），全部 bizFixture 过 parse/validate/migrate 口径
// 对齐 TS validator.spec 的全 fixture 门禁。manifest 格式冻结（AI-3 维护，AI-1 只读消费）。
namespace Taprint.PrintDsl.Tests
{
    /// <summary>
    /// fixture-manifest 驱动遍历——多语言实现一致性清单消费方。
    /// manifest 由 fixture-codegen 产物维护（AI-3 Owns），C# 端只读遍历。
    /// </summary>
    public class FixtureManifestTests
    {
        private static readonly string ManifestPath = Path.Combine(
            RepoPaths.Root, "packages/taprint-ts/tests/generated/fixture-manifest.json");

        private static readonly JsonDocument Manifest = JsonDocument.Parse(File.ReadAllText(ManifestPath));

        private static IEnumerable<(string file, string schemaVersion)> BizFixtures()
        {
            foreach (var item in Manifest.RootElement.GetProperty("bizFixtures").EnumerateArray())
            {
                yield return (
                    item.GetProperty("file").GetString()!,
                    item.GetProperty("schemaVersion").GetString()!);
            }
        }

        private static JsonSchema SchemaFor(string version) =>
            version.StartsWith("2.") ? TestSchemas.V2
            : version == "1.1" ? TestSchemas.V11
            : TestSchemas.V1;

        [Fact]
        public void manifest_sha256与fixture本体canonical哈希逐字一致_T5锚定()
        {
            foreach (var (file, _) in BizFixtures())
            {
                var json = File.ReadAllText(Path.Combine(RepoPaths.Root, "fixtures", "templates", file));
                var tree = SCV.DslParser.Parse(json);
                var canonical = SCV.Internal.Canonical.CanonicalizeTree(tree, excludeSignature: false);
                using var sha = System.Security.Cryptography.SHA256.Create();
                var actual = Convert.ToHexString(sha.ComputeHash(System.Text.Encoding.UTF8.GetBytes(canonical)))
                    .ToLowerInvariant();
                var expected = Manifest.RootElement.GetProperty("bizFixtures")
                    .EnumerateArray()
                    .First(e => e.GetProperty("file").GetString() == file)
                    .GetProperty("sha256").GetString();
                Assert.True(actual == expected, $"{file}: canonical sha256 不匹配（实际 {actual}）");
            }
        }

        [Fact]
        public void 全部bizFixture过Parse返回非空对象树()
        {
            foreach (var (file, _) in BizFixtures())
            {
                var json = File.ReadAllText(Path.Combine(RepoPaths.Root, "fixtures", "templates", file));
                var tree = SCV.DslParser.Parse(json);
                Assert.True(tree.Count > 0, $"{file}: Parse 返回空");
            }
        }

        [Fact]
        public void 全部bizFixture过对应版本schema校验()
        {
            foreach (var (file, schemaVersion) in BizFixtures())
            {
                var tree = RepoPaths.ReadJsonTree($"fixtures/templates/{file}")!;
                var result = SCV.DslValidator.Validate(tree, SchemaFor(schemaVersion));
                Assert.True(result.Valid, $"{file} (v{schemaVersion}): {string.Join("; ", result.Errors.Select(e => $"{e.Path}:{e.Message}"))}");
            }
        }

        [Fact]
        public void 全部bizFixture过ValidateBusiness_无表达式或字段绑定错误()
        {
            foreach (var (file, _) in BizFixtures())
            {
                var tree = RepoPaths.ReadJsonTree($"fixtures/templates/{file}")!;
                var result = SCV.DslValidator.ValidateBusiness(tree);
                Assert.True(result.Valid, $"{file}: {string.Join("; ", result.Errors.Select(e => $"{e.Code}@{e.Path}"))}");
            }
        }

        [Fact]
        public void v1_bizFixture迁移至v2后过v2_schema_超集承诺锁定()
        {
            foreach (var (file, schemaVersion) in BizFixtures())
            {
                if (schemaVersion != "1.0") continue;
                var tree = RepoPaths.ReadJsonTree($"fixtures/templates/{file}")!;
                var migrated = SCV.DslMigrator.Migrate(tree, "1.0", SCV.DslMigrator.CurrentVersion);
                var result = SCV.DslValidator.Validate(migrated, TestSchemas.V2);
                Assert.True(result.Valid, $"{file} 迁移后: {string.Join("; ", result.Errors.Select(e => e.Message))}");
            }
        }

        [Fact]
        public void manifest格式冻结检查_schema与dslSchemaVersions字段存在()
        {
            Assert.Equal("taprint/fixture-manifest@1", Manifest.RootElement.GetProperty("schema").GetString());
            var versions = Manifest.RootElement.GetProperty("dslSchemaVersions").EnumerateArray()
                .Select(v => v.GetString()).ToList();
            Assert.Contains("1.0", versions);
            Assert.Contains("2.0", versions);
        }
    }
}
