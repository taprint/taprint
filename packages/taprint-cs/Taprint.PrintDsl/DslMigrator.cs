// SPDX-License-Identifier: Apache-2.0
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text.Json;
using System.Text.RegularExpressions;
using Taprint.PrintDsl.Internal;

// DSL 版本迁移。
// 内置链：0.9 → 1.0 → 1.1（label 折算） → 2.0；CURRENT_VERSION=2.0；schemaVersion pattern `^\d+\.\d+$`。
// MigrationSchemaGate 双形态：JsonSchema 对象（逐步同 schema）或 Func<string, JsonSchema>（按
// 该步产出版本选 schema，多版本链各 pattern 分轨时必需）。
// 入口深拷贝隔离入参（JSON 语义）；step 契约：纯函数，禁改入参、须返回新对象。
namespace Taprint.PrintDsl
{
    /// <summary>
    /// DSL 版本迁移内核：内置 0.9→1.0→1.1→2.0 链 + registerStep 扩展 + clear 隔离。
    /// MigrationSchemaGate 支持 JsonSchema 对象或 Func&lt;string, JsonSchema&gt; 函数双形态。
    /// </summary>
    public static class DslMigrator
    {
        /// <summary>版本文法：`主.次` 十进制数段（与 schema/changelog.md 版本列一致）。</summary>
        public static readonly Regex VersionRe = new Regex(@"^\d+\.\d+$", RegexOptions.Compiled);

        /// <summary>DSL 定稿前模板（无 schemaVersion 字段）的归档版本号。</summary>
        public const string LegacyVersion = "0.9";

        /// <summary>当前权威 schema 版本（schema/v2.0.json / schema/changelog.md，中国式报表专项）。</summary>
        public const string CurrentVersion = "2.0";

        private static readonly Dictionary<string, MigrationStep> _stepRegistry = new Dictionary<string, MigrationStep>();
        private static readonly object _lock = new object();

        /// <summary>迁移步骤契约：纯函数——禁止原地修改入参，须返回新对象。</summary>
        public delegate IDictionary<string, object?> MigrationStep(IDictionary<string, object?> dsl);

        static DslMigrator()
        {
            RegisterBuiltins();
        }

        /// <summary>
        /// 从旧版本逐级迁移到目标版本。
        /// 入口深拷贝隔离入参；schema 注入时每步后经 DslValidator.Validate 门禁；
        /// from == to 为恒等迁移（返回深拷贝）。
        /// </summary>
        /// <param name="dsl">DSL 对象（IDictionary 树；JsonElement / JsonSchema 均拒）。</param>
        /// <param name="fromVersion">起始版本（须为 `主.次` 文法）。</param>
        /// <param name="toVersion">目标版本（须为 `主.次` 文法）。</param>
        /// <param name="schemaGate">可选：JsonSchema 对象（逐步同 schema）或 Func&lt;string, JsonSchema&gt;（按产出版本选）。</param>
        public static IDictionary<string, object?> Migrate(object dsl, string fromVersion, string toVersion, object? schemaGate = null)
        {
            var from = NormalizeVersion(fromVersion, "fromVersion");
            var to = NormalizeVersion(toVersion, "toVersion");
            if (CompareVersions(from, to) > 0)
            {
                throw new ArgumentOutOfRangeException(nameof(toVersion), $"DslMigrator.Migrate: 不支持降级迁移（{from} → {to}）");
            }
            var current = DeepClone(AssertObject(dsl));
            var version = from;
            MigrationStep step;
            while (CompareVersions(version, to) < 0)
            {
                lock (_lock)
                {
                    if (!_stepRegistry.TryGetValue(version, out var stepFn))
                    {
                        throw new InvalidOperationException($"DslMigrator.Migrate: 版本 {version} 无已注册迁移步骤（迁移链断裂，目标 {to}）");
                    }
                    step = stepFn;
                }
                var stepped = step(current);
                current = stepped ?? throw new InvalidOperationException($"DslMigrator.Migrate: {version} 迁移步骤返回 null");
                var next = current.TryGetValue("schemaVersion", out var svObj) && svObj is string sv ? sv : null;
                if (next == null || CompareVersions(next, version) <= 0)
                {
                    throw new InvalidOperationException($"DslMigrator.Migrate: {version} 迁移步骤未将 schemaVersion 推进（得到 {next ?? "null"}）");
                }
                if (CompareVersions(next, to) > 0)
                {
                    throw new InvalidOperationException($"DslMigrator.Migrate: {version} 迁移步骤越过目标版本（推进至 {next}，目标 {to}）");
                }
                version = next;
                if (schemaGate != null)
                {
                    object gateSchema;
                    if (schemaGate is Delegate fn) gateSchema = fn.DynamicInvoke(version) ?? throw new InvalidOperationException("schemaGate 函数返回 null");
                    else gateSchema = schemaGate;
                    var result = DslValidator.Validate(current, gateSchema);
                    if (!result.Valid)
                    {
                        var msg = result.Errors.Count > 0 ? result.Errors[0].Message : "未知错误";
                        throw new InvalidOperationException($"DslMigrator.Migrate: 迁移至 {version} 后未通过 schema 校验：{msg}");
                    }
                }
            }
            return current;
        }

        /// <summary>检测模板版本：缺 schemaVersion 归 0.9；否则按文法如实上报。</summary>
        public static string DetectVersion(object dsl)
        {
            var obj = AssertObject(dsl);
            if (!obj.TryGetValue("schemaVersion", out var v) || v == null) return LegacyVersion;
            if (!(v is string s) || !VersionRe.IsMatch(s))
            {
                throw new ArgumentException($"DslMigrator.DetectVersion: schemaVersion 不可识别：{v}");
            }
            return s;
        }

        /// <summary>
        /// 注册迁移步骤（fromVersion → 步骤内声明的下一版本；重复注册覆写）。
        /// 风险声明：覆写内置 0.9 步骤会改变**所有**定稿前模板的迁移路径——
        /// 生产环境仅在有明确迁移策略变更时使用；Clear() 可恢复内置链。
        /// </summary>
        public static void RegisterStep(string fromVersion, MigrationStep step)
        {
            var from = NormalizeVersion(fromVersion, "fromVersion");
            if (step == null) throw new ArgumentException("DslMigrator.RegisterStep: step 不能为 null");
            lock (_lock)
            {
                _stepRegistry[from] = step;
            }
        }

        /// <summary>恢复内置迁移链（0.9 → 1.0 → 1.1 → 2.0）；测试隔离 / 宿主生命周期用。</summary>
        public static void Clear()
        {
            lock (_lock)
            {
                _stepRegistry.Clear();
                RegisterBuiltins();
            }
        }

        // ---------- 内部工具 ----------

        private static void RegisterBuiltins()
        {
            // 0.9 → 1.0：DSL 权威定稿（Phase 0）。结构兼容，仅补版本声明。
            _stepRegistry[LegacyVersion] = (dsl) =>
            {
                var copy = new Dictionary<string, object?>(dsl);
                copy["schemaVersion"] = "1.0";
                return copy;
            };
            // 1.0 → 1.1：label 域字段约定统一（schema/changelog.md v1.1 行）。仅折算两处
            // 收窄值——text.size 0 折 1、qrcode.size >10 折 10（D4：PC 引擎与后端 TSPL
            // 渲染早已按 1-10 clamp，本步把存量文档折进新值域）；其余字段原样保留（保字段
            // 铁律：1.0 文档无 v1.1 新增字段，本步不产生也不丢失任何字段）。
            _stepRegistry["1.0"] = NormalizeLabelV11ThenBump;
            // 1.1 → 2.0：中国式报表专项步骤 3（v2.0 为 1.x 严格超集）。v1.1 同批已把
            // label 六元素/收窄落稿同步进 v2.0，步骤仅推进版本声明；结构兼容由锚点锁定
            // （migrator 测试：全部 v1.0 fixture 迁移后通过 v2.0 schema）。
            _stepRegistry["1.1"] = (dsl) =>
            {
                var copy = new Dictionary<string, object?>(dsl);
                copy["schemaVersion"] = "2.0";
                return copy;
            };
        }

        /// <summary>
        /// 1.0 → 1.1 折算（纯函数，禁改入参嵌套对象）：遍历 presentations.label.body——
        /// text 元素 size==0 → 1；qrcode 元素 size>10 → 10
        /// 。其余元素与字段一律原样保留。
        /// </summary>
        private static IDictionary<string, object?> NormalizeLabelV11ThenBump(IDictionary<string, object?> dsl)
        {
            var copy = new Dictionary<string, object?>(dsl) { ["schemaVersion"] = "1.1" };
            if (!copy.TryGetValue("presentations", out var presObj) || !(presObj is IDictionary<string, object?> pres))
            {
                return copy;
            }
            if (!pres.TryGetValue("label", out var labelObj) || !(labelObj is IDictionary<string, object?> label))
            {
                return copy;
            }
            if (!label.TryGetValue("body", out var bodyObj) || !(bodyObj is IList<object?> body))
            {
                return copy;
            }
            var normalizedBody = new List<object?>();
            foreach (var item in body)
            {
                if (!(item is IDictionary<string, object?> el))
                {
                    normalizedBody.Add(item);
                    continue;
                }
                var typeSeen = el.TryGetValue("type", out var t) ? t as string : null;
                if (typeSeen == "text" && el.TryGetValue("size", out var sizeObj) && sizeObj is double dSize && dSize == 0d)
                {
                    var patched = new Dictionary<string, object?>(el) { ["size"] = 1d }; // JsonTree 数字一律 double（镜像 JS JSON.parse）
                    normalizedBody.Add(patched);
                    continue;
                }
                if (typeSeen == "qrcode" && el.TryGetValue("size", out var qrObj) && qrObj is double dQr && dQr > 10d)
                {
                    var patched = new Dictionary<string, object?>(el) { ["size"] = 10d };
                    normalizedBody.Add(patched);
                    continue;
                }
                normalizedBody.Add(el);
            }
            var normalizedLabel = new Dictionary<string, object?>(label) { ["body"] = normalizedBody };
            var normalizedPres = new Dictionary<string, object?>(pres) { ["label"] = normalizedLabel };
            copy["presentations"] = normalizedPres;
            return copy;
        }

        private static int CompareVersions(string a, string b)
        {
            var aParts = a.Split('.');
            var bParts = b.Split('.');
            var aMajor = int.Parse(aParts[0], CultureInfo.InvariantCulture);
            var aMinor = int.Parse(aParts[1], CultureInfo.InvariantCulture);
            var bMajor = int.Parse(bParts[0], CultureInfo.InvariantCulture);
            var bMinor = int.Parse(bParts[1], CultureInfo.InvariantCulture);
            return aMajor != bMajor ? aMajor.CompareTo(bMajor) : aMinor.CompareTo(bMinor);
        }

        private static string NormalizeVersion(string v, string label)
        {
            if (v == null || !VersionRe.IsMatch(v))
            {
                throw new ArgumentException($"DslMigrator: {label} 版本格式非法（须为 \"主.次\"）：{v ?? "null"}");
            }
            return v;
        }

        private static IDictionary<string, object?> AssertObject(object dsl)
        {
            if (dsl is IDictionary<string, object?> dict) return dict;
            throw new ArgumentException("DslMigrator: dsl 必须为对象（IDictionary<string,object?>）");
        }

        /// <summary>入口深拷贝：调用方入参与迁移产物完全隔离（JSON 语义；循环引用即拒）。</summary>
        private static IDictionary<string, object?> DeepClone(IDictionary<string, object?> dsl)
        {
            try
            {
                var json = JsonSerializer.Serialize(dsl);
                using var doc = JsonDocument.Parse(json);
                return (IDictionary<string, object?>)JsonTree.ToTree(doc.RootElement)!;
            }
            catch (Exception e) when (!(e is ArgumentException))
            {
                throw new ArgumentException("DslMigrator.Migrate: dsl 必须为 JSON-safe（拒绝循环引用）");
            }
        }
    }
}
