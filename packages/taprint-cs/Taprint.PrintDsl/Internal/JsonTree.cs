// SPDX-License-Identifier: Apache-2.0
using System.Collections.Generic;
using System.Text.Json;

// JsonElement → .NET 对象树（Dictionary/List/string/double/bool/null）。
// 数字一律归一 double（镜像 JS JSON.parse），是 stringify/hash 与 JS 逐字一致的前提。
// 原为测试侧辅助（轮 1），轮 2 提升入库供 DslParser.Parse 复用。
namespace Taprint.PrintDsl.Internal
{
    internal static class JsonTree
    {
        public static object? ToTree(JsonElement el)
        {
            switch (el.ValueKind)
            {
                case JsonValueKind.Object:
                    var dict = new Dictionary<string, object?>();
                    foreach (var prop in el.EnumerateObject()) dict[prop.Name] = ToTree(prop.Value);
                    return dict;
                case JsonValueKind.Array:
                    var list = new List<object?>();
                    foreach (var item in el.EnumerateArray()) list.Add(ToTree(item));
                    return list;
                case JsonValueKind.String:
                    return el.GetString();
                case JsonValueKind.Number:
                    return el.GetDouble();
                case JsonValueKind.True:
                    return true;
                case JsonValueKind.False:
                    return false;
                default:
                    return null;
            }
        }
    }
}
