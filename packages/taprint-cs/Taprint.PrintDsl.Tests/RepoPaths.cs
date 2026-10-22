// SPDX-License-Identifier: Apache-2.0
using System;
using System.Collections.Generic;
using System.IO;
using System.Text.Json;
using Taprint.PrintDsl.Internal;

// 仓库根定位：从测试程序集目录向上查找 pnpm-workspace.yaml（不硬编码层级）。
// 金样（fixtures/templates、fixtures/expected）为多语言实现共享真值，直接读取不复制。
namespace Taprint.PrintDsl.Tests
{
    internal static class RepoPaths
    {
        public static readonly string Root = FindRoot();

        public static string Fixtures => Root; // rel 以 "fixtures/templates/..." 形态书写（源仓形态保留）

        public static string Expected => Path.Combine(Root, "fixtures", "expected", "parse-results");

        public static string Schema => Path.Combine(Root, "schema");

        private static string FindRoot()
        {
            var dir = new DirectoryInfo(AppContext.BaseDirectory);
            while (dir != null)
            {
                if (File.Exists(Path.Combine(dir.FullName, "pnpm-workspace.yaml")) &&
                    File.Exists(Path.Combine(dir.FullName, "fixtures", "templates", "message-signer-v1.json")))
                {
                    return dir.FullName;
                }
                dir = dir.Parent;
            }
            throw new DirectoryNotFoundException("未找到仓库根（pnpm-workspace.yaml + fixtures/templates）");
        }

        /// <summary>读 JSON 为对象树（数字归一 double，镜像 JS JSON.parse 语义）。</summary>
        public static object? ReadJsonTree(string rel)
        {
            var text = File.ReadAllText(Path.Combine(Fixtures, rel));
            using var doc = JsonDocument.Parse(text);
            return JsonTree.ToTree(doc.RootElement);
        }

        public static string ReadText(string rel) => File.ReadAllText(Path.Combine(Fixtures, rel));

        public static string ExpectedRead(string rel) => File.ReadAllText(Path.Combine(Expected, rel));

        public static object? ExpectedJson(string rel)
        {
            var text = File.ReadAllText(Path.Combine(Expected, rel));
            using var doc = JsonDocument.Parse(text);
            return JsonTree.ToTree(doc.RootElement);
        }
    }
}
