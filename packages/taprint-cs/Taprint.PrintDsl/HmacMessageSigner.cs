// SPDX-License-Identifier: Apache-2.0
using System;
using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using Taprint.PrintDsl.Internal;

//  集成形态（宿主集成参考实现）：WPF 宿主经 DI 注入使用。
// 与内核静态 MessageSigner 是同一实现的不同封装：
// 内核接受显式 key，集成形态固化 key 来源（IKeyProvider）并追加 nonce 防重放。
namespace Taprint.PrintDsl
{
    /// <summary>宿主消息签名器。</summary>
    public interface IMessageSigner
    {
        /// <summary>宿主构造消息时签名（POCO → camelCase canonical + HMAC-SHA256）。</summary>
        string Sign(object msg);

        /// <summary>
        /// 验签：必须对「收到的原始 JSON 键集」（Web 端实际发送的键）规范化，
        /// 禁止先反序列化 POCO 再重序列化——那会补入接收方默认值键导致 canonical 分叉。
        /// </summary>
        bool Verify(string json);
    }

    /// <summary>密钥来源：返回 base64(32B) 派生密钥；token 刷新后重建签名器。</summary>
    public interface IKeyProvider
    {
        /// <summary>当前配对会话 token 派生的 base64(32B) 消息密钥（DeriveMessageKey 产物）。</summary>
        string GetDesignerMessageKey();
    }

    /// <summary>nonce 防重放缓存：实现需线程安全。</summary>
    public interface INonceCache
    {
        /// <summary>nonce 是否已登记（未过期）。</summary>
        bool Exists(string nonce);

        /// <summary>登记 nonce 及其过期时间。</summary>
        void Add(string nonce, DateTimeOffset expiresAt);
    }

    /// <summary>
    /// 协议 JSON 序列化选项：多语言实现键名统一 camelCase，且传输与签名共用同一规则。
    /// </summary>
    public static class DesignerProtocolJson
    {
        /// <summary>
        /// 序列化（签名 + 传输共用）：camelCase + 不转义非 ASCII / &lt;&gt;&amp;'；
        /// null 属性显式输出（与 TS JSON.stringify / Dart jsonEncode 的 null 语义一致）。
        /// </summary>
        public static readonly JsonSerializerOptions CamelCase = new JsonSerializerOptions
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
            WriteIndented = false,
            Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        };

        /// <summary>
        /// 反序列化（Web → WPF）：大小写不敏感（Web SDK 发送 camelCase，POCO 属性 PascalCase）。
        /// </summary>
        public static readonly JsonSerializerOptions ReadOptions = new JsonSerializerOptions
        {
            PropertyNameCaseInsensitive = true,
        };
    }

    /// <summary>默认内存 nonce 缓存（ConcurrentDictionary + 过期淘汰；线程安全）。</summary>
    public sealed class MemoryNonceCache : INonceCache
    {
        private readonly ConcurrentDictionary<string, long> _expiryMs = new ConcurrentDictionary<string, long>();
        private readonly Func<DateTimeOffset> _clock;

        /// <summary>构造；clock 可注入以便测试（须与签名器时钟同源，否则过期判定分叉）。</summary>
        public MemoryNonceCache(Func<DateTimeOffset>? clock = null)
        {
            _clock = clock ?? (() => DateTimeOffset.UtcNow);
        }

        /// <inheritdoc />
        public bool Exists(string nonce)
        {
            if (!_expiryMs.TryGetValue(nonce, out var expiry)) return false;
            if (expiry < _clock().ToUnixTimeMilliseconds())
            {
                _expiryMs.TryRemove(nonce, out _);
                return false;
            }
            return true;
        }

        /// <inheritdoc />
        public void Add(string nonce, DateTimeOffset expiresAt)
        {
            _expiryMs[nonce] = expiresAt.ToUnixTimeMilliseconds();
            // 顺带淘汰过期项，防止长生命周期宿主内存无界增长
            var now = _clock().ToUnixTimeMilliseconds();
            foreach (var kv in _expiryMs)
            {
                if (kv.Value < now) _expiryMs.TryRemove(kv.Key, out _);
            }
        }
    }

    /// <summary>HMAC-SHA256 消息签名器。</summary>
    public class HmacMessageSigner : IMessageSigner
    {
        private readonly byte[] _secretKey;
        private readonly INonceCache _nonceCache;
        private readonly Func<DateTimeOffset> _clock;

        /// <summary>
        /// 构造：IKeyProvider 返回 base64(32B)，解码为原始字节后用于 HMAC，
        /// 与 TS/Dart 端密钥字节一致。nonceCache/clock 可注入以便测试。
        /// </summary>
        public HmacMessageSigner(IKeyProvider keyProvider, INonceCache? nonceCache = null, Func<DateTimeOffset>? clock = null)
        {
            if (keyProvider == null) throw new ArgumentNullException(nameof(keyProvider));
            var base64 = keyProvider.GetDesignerMessageKey();
            _secretKey = Convert.FromBase64String(base64);
            if (_secretKey.Length != 32)
            {
                throw new ArgumentException("IKeyProvider: 密钥必须为 32 字节的 base64");
            }
            _clock = clock ?? (() => DateTimeOffset.UtcNow);
            _nonceCache = nonceCache ?? new MemoryNonceCache(_clock);
        }

        /// <inheritdoc />
        public string Sign(object msg)
        {
            // 宿主构造消息：POCO → camelCase JSON → 递归排序 canonical（剥离顶层 signature）
            var json = JsonSerializer.Serialize(msg, DesignerProtocolJson.CamelCase);
            using var doc = JsonDocument.Parse(json);
            return ComputeHmac(doc.RootElement);
        }

        /// <inheritdoc />
        public bool Verify(string json)
        {
            try
            {
                using var doc = JsonDocument.Parse(json);
                var root = doc.RootElement;
                if (root.ValueKind != JsonValueKind.Object) return false;

                // 1) 时间窗校验：timestamp 须为整数毫秒且 ±5 分钟内。
                //    注：TryGetInt64 按原始文本解析，"1e2" 类指数文本判拒——合规端经
                //    EcmaNumber/JSON.stringify 产出必为普通整数文法，此差异不可达。
                if (!root.TryGetProperty("timestamp", out var tsEl) ||
                    !tsEl.TryGetInt64(out var ts) ||
                    Math.Abs(_clock().ToUnixTimeMilliseconds() - ts) > MessageSigner.TimestampWindowMs)
                {
                    return false;
                }

                if (!root.TryGetProperty("signature", out var sigEl)) return false;
                var received = sigEl.GetString();
                if (received is null || received.Length == 0) return false;

                // 2) 先验签：对「收到的原始 JSON 键集」规范化（与 TS/Dart 同一规则，）。
                //    验签失败不登记 nonce，防止伪造消息耗尽 nonce 缓存（DoS）。
                //    ★ v1.8 P1：不得先反序列化 POCO 再重序列化——POCO 会把 Web 未发送的
                //    键补成默认值，canonical 键集与发送方不一致，任何消息都会验签失败。
                var expected = ComputeHmac(root);
                if (!FixedTime.Equals(Encoding.UTF8.GetBytes(expected), Encoding.UTF8.GetBytes(received)))
                {
                    return false;
                }

                // 3) 验签通过后登记 nonce（线程安全缓存）
                if (!root.TryGetProperty("nonce", out var nonceEl)) return false;
                var nonce = nonceEl.GetString();
                if (nonce is null || nonce.Length == 0) return false;
                if (_nonceCache.Exists(nonce)) return false;
                _nonceCache.Add(nonce, _clock().AddMinutes(5));
                return true;
            }
            catch (JsonException)
            {
                return false;
            }
        }

        // 对原始键集递归 Ordinal 排序 + 顶层剥 signature 后 HMAC-SHA256 → Base64。
        // 数字经 EcmaNumber（ECMA-262 最短十进制），与 TS JSON.parse→stringify 归一一致；
        // 字符串转义经 JsonStringLiteral 手写字面量与 JS JSON.stringify 逐字一致
        // 。
        private string ComputeHmac(JsonElement root)
        {
            var canonical = Canonical.CanonicalizeElement(root, excludeSignature: true);
            using var hmac = new HMACSHA256(_secretKey);
            return Convert.ToBase64String(hmac.ComputeHash(Encoding.UTF8.GetBytes(canonical)));
        }
    }
}
