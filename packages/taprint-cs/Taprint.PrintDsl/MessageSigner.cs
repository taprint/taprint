// SPDX-License-Identifier: Apache-2.0
using System;
using System.Collections.Generic;
using Taprint.PrintDsl.Internal;

// HostMessage/DesignerMessage HMAC 签名内核 API，
// 与 print-dsl-ts MessageSigner 逐条同构。一致性由 tests/fixtures/message-signer-v1…v5
// + expected-output 锁定。集成形态（IKeyProvider/NonceCache/原始 JSON 验签）
// 见 HmacMessageSigner.cs。
//
// 数字序列化契约：canonical 串数字经 EcmaNumber（ECMA-262 最短十进制），
// 1.0 → "1"、0.1 → "0.1"；浮点规范化由 fixture v4 锁定。
//
// 入参必须 JSON-safe 且无循环引用（Canonical.AssertJsonSafe）：DateTime/自定义 POCO 等
// 会被 JSON 序列化静默变形，导致多语言实现 canonical 串不一致——显式拒绝。
namespace Taprint.PrintDsl
{
    /// <summary>HMAC-SHA256 消息签名内核（多语言实现同构；密钥 base64(32B) 表示， v1.6）。</summary>
    public static class MessageSigner
    {
        internal const string HkdfSalt = "taprint-designer-v1";
        internal const string HkdfInfo = "postmessage-hmac";
        internal const int KeyBytes = 32;

        /// <summary>验签时间窗 ±5 分钟。</summary>
        internal const long TimestampWindowMs = 5 * 60 * 1000;

        /// <summary>HKDF-SHA256 派生；返回 base64(32 字节密钥)——多语言实现统一表示。</summary>
        public static string DeriveMessageKey(string sessionToken)
        {
            var okm = Crypto.HkdfSha256(Crypto.Utf8(sessionToken), Crypto.Utf8(HkdfSalt), Crypto.Utf8(HkdfInfo), KeyBytes);
            return Crypto.ToBase64(okm);
        }

        /// <summary>
        /// 规范化：顶层剥离 signature、全深度递归 key 字典序、
        /// JSON 无多余空白（多语言实现同规则，fixture 锁定，）。
        /// </summary>
        public static string Canonicalize(object msg) => Canonical.CanonicalizeTree(msg);

        /// <summary>HMAC-SHA256 → Base64；密钥须 base64 解码为 32 字节原始字节后计算。</summary>
        public static string Sign(object msg, string key)
        {
            var mac = Crypto.HmacSha256(DecodeKey(key), Crypto.Utf8(Canonicalize(msg)));
            return Crypto.ToBase64(mac);
        }

        /// <summary>验签：时间窗 ±5 分钟 + 常量时间比较（与宿主侧  一致）。</summary>
        public static bool Verify(object msg, string key)
        {
            if (msg is not IReadOnlyDictionary<string, object?> record) return false;
            if (!record.TryGetValue("signature", out var sigObj) || sigObj is not string signature) return false;
            // ：毫秒时间戳必须为整数（浮点时间戳视为伪造/跨端实现错误）
            if (!TryGetIntegerTimestamp(record, out var timestamp)) return false;
            var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            if (Math.Abs(now - timestamp) > TimestampWindowMs) return false;
            try
            {
                return ConstantTimeEquals(Sign(msg, key), signature);
            }
            catch (Exception)
            {
                // 畸形密钥/消息不抛给宿主，直接判为验签失败
                return false;
            }
        }

        private static bool TryGetIntegerTimestamp(IReadOnlyDictionary<string, object?> record, out long timestamp)
        {
            timestamp = 0;
            if (!record.TryGetValue("timestamp", out var tsObj)) return false;
            switch (tsObj)
            {
                case double d when d == Math.Truncate(d) && Math.Abs(d) < 9.007199254740992E15:
                    timestamp = (long)d;
                    return true;
                case int i:
                    timestamp = i;
                    return true;
                case long l:
                    timestamp = l;
                    return true;
                default:
                    return false;
            }
        }

        /// <summary>密钥解码并校验长度（畸形密钥显式失败，避免静默产出错误签名；）。</summary>
        private static byte[] DecodeKey(string key)
        {
            var bytes = Crypto.FromBase64(key);
            if (bytes.Length != KeyBytes)
            {
                throw new ArgumentException($"MessageSigner: 密钥必须为 {KeyBytes} 字节的 base64");
            }
            return bytes;
        }

        private static bool ConstantTimeEquals(string a, string b)
            => FixedTime.Equals(Crypto.Utf8(a), Crypto.Utf8(b));
    }
}
