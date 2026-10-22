// SPDX-License-Identifier: Apache-2.0
using System;
using System.IO;
using Json.Schema;

namespace Taprint.PrintDsl.Tests
{
    /// <summary>
    /// Schema 单例（避免 JsonSchema.Net 9.x SchemaRegistry 重复注册抛错）。
    /// 多个测试类共享同一 JsonSchema 实例。
    /// </summary>
    internal static class TestSchemas
    {
        public static readonly JsonSchema V1 = Load("v1.0.json");
        public static readonly JsonSchema V11 = Load("v1.1.json");
        public static readonly JsonSchema V2 = Load("v2.0.json");

        private static JsonSchema Load(string file)
        {
            var path = Path.Combine(RepoPaths.Root, "schema", file);
            return JsonSchema.FromText(File.ReadAllText(path));
        }
    }
}
