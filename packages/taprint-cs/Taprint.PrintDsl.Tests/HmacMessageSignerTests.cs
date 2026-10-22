// SPDX-License-Identifier: Apache-2.0
using System;
using System.Collections.Generic;
using System.Text.Json;
using Xunit;

//  集成形态（ 参考代码落地）：原始 JSON 键集验签 + nonce 防重放。
//  v1.8 补充用例：message-signer-v2 原始 JSON 复算验签；POCO 默认值键注入必拒。
namespace Taprint.PrintDsl.Tests
{
    public class HmacMessageSignerTests
    {
        private const string FixtureToken = "designer-session-token-fixture";
        private const long FixtureTimestamp = 1710000000000;

        private sealed class TokenKeyProvider : IKeyProvider
        {
            private readonly string _token;

            public TokenKeyProvider(string token) => _token = token;

            public string GetDesignerMessageKey() => MessageSigner.DeriveMessageKey(_token);
        }

        private static HmacMessageSigner CreateSigner()
            => new HmacMessageSigner(
                new TokenKeyProvider(FixtureToken),
                clock: () => DateTimeOffset.FromUnixTimeMilliseconds(FixtureTimestamp));

        /// <summary>v2 fixture 消息 + 期望签名拼成「Web 端实际发送」的原始 JSON 文本。
        /// 注：Canonicalize 按定义剥离顶层 signature，故先规范化消息体再拼回签名键。</summary>
        private static string BuildV2RawJson()
        {
            var fixture = (Dictionary<string, object?>)RepoPaths.ReadJsonTree("fixtures/templates/message-signer-v2.json")!;
            var message = (Dictionary<string, object?>)fixture["message"]!;
            var expected = (Dictionary<string, object?>)RepoPaths.ExpectedJson("message-signer-result-v2.json")!;
            var body = MessageSigner.Canonicalize(message);
            return body.Substring(0, body.Length - 1) + ",\"signature\":" + JsonSerializer.Serialize(expected["signature"]) + "}";
        }

        [Fact(DisplayName = "Verify 对 v2 原始 JSON 文本（中文+嵌套+<>&）验签通过")]
        public void VerifyAcceptsV2RawJson()
        {
            Assert.True(CreateSigner().Verify(BuildV2RawJson()));
        }

        [Fact(DisplayName = "Verify 拒绝时间窗外的原始 JSON")]
        public void VerifyRejectsOutOfWindow()
        {
            var raw = BuildV2RawJson();
            var signer = new HmacMessageSigner(new TokenKeyProvider(FixtureToken)); // 真实时钟：fixture 时间戳已过期
            Assert.False(signer.Verify(raw));
        }

        [Fact(DisplayName = "Verify 拒绝 nonce 重放（第二次验签必失败）")]
        public void VerifyRejectsNonceReplay()
        {
            var signer = CreateSigner();
            var raw = BuildV2RawJson();
            Assert.True(signer.Verify(raw));
            Assert.False(signer.Verify(raw));
        }

        [Fact(DisplayName = "Verify 拒绝畸形 JSON / 缺 nonce / 浮点 timestamp 文本")]
        public void VerifyRejectsMalformedInputs()
        {
            var signer = CreateSigner();
            Assert.False(signer.Verify("{bad"));
            Assert.False(signer.Verify("[]"));
            var raw = BuildV2RawJson();
            Assert.False(signer.Verify(raw.Replace("\"nonce\"", "\"nonceX\"")));
            Assert.False(signer.Verify(raw.Replace("\"timestamp\":1710000000000", "\"timestamp\":1710000000000.5")));
        }

        // ★  闭环：Canonical 元素路径（HmacMessageSigner.Sign(object)/Verify(string)）
        // 曾对 U+3000/U+2028/U+2029 走 el.WriteTo → \uXXXX 转义，与 JS JSON.stringify 原样输出分叉，
        // 致对 Web 端合法签名验签失败。以下锚点由 TS MessageSigner（Node v22.22.2）生成。
        private static Dictionary<string, object?> BuildUnicodeMessage() => new Dictionary<string, object?>
        {
            ["type"] = "dsl:save",
            ["dsl"] = new Dictionary<string, object?>
            {
                ["id"] = "tpl-u",
                ["name"] = "全角\u3000分隔\u2028行分隔\u2029段分隔",
                ["items"] = new List<object?>
                {
                    new Dictionary<string, object?> { ["label"] = "a\u3000b" },
                },
            },
            ["timestamp"] = 1710000000000L,
            ["nonce"] = "nonce-u-plus",
        };

        [Fact(DisplayName = "Canonical 对 U+3000/U+2028/U+2029 与 TS 逐字一致")]
        public void CanonicalMatchesTsForUnicodeSeparators()
        {
            var expected = "{\"dsl\":{\"id\":\"tpl-u\",\"items\":[{\"label\":\"a\u3000b\"}]," +
                "\"name\":\"全角\u3000分隔\u2028行分隔\u2029段分隔\"}," +
                "\"nonce\":\"nonce-u-plus\",\"timestamp\":1710000000000,\"type\":\"dsl:save\"}";
            Assert.Equal(expected, MessageSigner.Canonicalize(BuildUnicodeMessage()));
        }

        [Fact(DisplayName = "Verify 通过 TS 端签发的含 U+3000/U+2028/U+2029 原始 JSON")]
        public void VerifyAcceptsTsSignedUnicodeRawJson()
        {
            const string tsSignature = "NHCW7GA3zMKEE0tUDmEbUCDy/1xn+i7kepsvPUIaUZg=";
            var canonical = MessageSigner.Canonicalize(BuildUnicodeMessage());
            var raw = canonical.Substring(0, canonical.Length - 1) + ",\"signature\":\"" + tsSignature + "\"}";
            Assert.True(CreateSigner().Verify(raw));
        }

        [Fact(DisplayName = "Sign 元素路径自签自验含 U+3000/U+2028/U+2029")]
        public void SignElementPathRoundTripsUnicodeSeparators()
        {
            var signer = CreateSigner();
            var message = BuildUnicodeMessage();
            var signature = signer.Sign(message);
            // 元素路径签名与 TS 锚点签名一致（canonical 同文本 → HMAC 必同值）
            Assert.Equal("NHCW7GA3zMKEE0tUDmEbUCDy/1xn+i7kepsvPUIaUZg=", signature);
            var canonical = MessageSigner.Canonicalize(message);
            var raw = canonical.Substring(0, canonical.Length - 1) + ",\"signature\":\"" + signature + "\"}";
            Assert.True(new HmacMessageSigner(
                new TokenKeyProvider(FixtureToken),
                clock: () => DateTimeOffset.FromUnixTimeMilliseconds(FixtureTimestamp)).Verify(raw));
        }

        // ★ v1.8 P1 回归：POCO 重序列化会补入 Web 未发送的默认值键（deviceClass/dirty/
        // errorMessage），canonical 键集与发送方不一致——对同一签名的 POCO 键集 JSON 必拒。
        private sealed class DesignerMessagePoco
        {
            public string Type { get; set; } = "";
            public object? Dsl { get; set; }
            public long Timestamp { get; set; }
            public string Nonce { get; set; } = "";
            public string? DeviceClass { get; set; }
            public bool Dirty { get; set; }
            public string? ErrorMessage { get; set; }
            public string? Signature { get; set; }
        }

        private static DesignerMessagePoco BuildV2Poco(string signature)
        {
            var fixture = (Dictionary<string, object?>)RepoPaths.ReadJsonTree("fixtures/templates/message-signer-v2.json")!;
            var message = (Dictionary<string, object?>)fixture["message"]!;
            return new DesignerMessagePoco
            {
                Type = (string)message["type"]!,
                Dsl = message["dsl"],
                Timestamp = (long)(double)message["timestamp"]!,
                Nonce = (string)message["nonce"]!,
                Signature = signature,
            };
        }

        [Fact(DisplayName = "POCO 重序列化补默认值键 → 签名与 Web 端不一致")]
        public void PocoReserializationChangesSignature()
        {
            var expected = (Dictionary<string, object?>)RepoPaths.ExpectedJson("message-signer-result-v2.json")!;
            var webSignature = (string)expected["signature"]!;

            var pocoJson = JsonSerializer.Serialize(BuildV2Poco(webSignature), DesignerProtocolJson.CamelCase);
            // POCO 键集包含 deviceClass/dirty/errorMessage 默认值键 → 签名必不同
            Assert.NotEqual(webSignature, CreateSigner().Sign(BuildV2Poco("")));
            // 携带 Web 签名的 POCO 键集 JSON 验签必拒（canonical 分叉）
            Assert.False(CreateSigner().Verify(pocoJson));
            // 原始键集 JSON 验签仍通过——对照证明分叉源于键集而非算法
            Assert.True(CreateSigner().Verify(BuildV2RawJson()));
        }

        [Fact(DisplayName = "Sign 对 POCO 输出 camelCase 且中文/<>& 不转义（DesignerProtocolJson 口径）")]
        public void SignFromPocoRoundTrips()
        {
            var signer = CreateSigner();
            var poco = BuildV2Poco("");
            var signature = signer.Sign(poco);
            // 自签自验（POCO 键集内自洽；与 Web 键集互验见 PocoReserializationChangesSignature）
            var pocoJson = JsonSerializer.Serialize(
                BuildV2Poco(signature), DesignerProtocolJson.CamelCase);
            Assert.True(new HmacMessageSigner(
                new TokenKeyProvider(FixtureToken),
                clock: () => DateTimeOffset.FromUnixTimeMilliseconds(FixtureTimestamp)).Verify(pocoJson));
            Assert.Contains("销售单-A4", pocoJson);
            Assert.Contains("a<b&c>", pocoJson);
        }

        [Fact(DisplayName = "MemoryNonceCache 过期项不再命中")]
        public void MemoryNonceCacheExpires()
        {
            var cache = new MemoryNonceCache();
            cache.Add("n1", DateTimeOffset.UtcNow.AddMinutes(5));
            cache.Add("n2", DateTimeOffset.UtcNow.AddMilliseconds(-1));
            Assert.True(cache.Exists("n1"));
            Assert.False(cache.Exists("n2"));
        }

        [Fact(DisplayName = "构造时拒绝畸形/非 32 字节密钥")]
        public void ConstructorRejectsBadKey()
        {
            Assert.ThrowsAny<Exception>(() => new HmacMessageSigner(new FixedKeyProvider("not-base64!!!")));
            Assert.Throws<ArgumentException>(() => new HmacMessageSigner(
                new FixedKeyProvider(Convert.ToBase64String(new byte[16]))));
        }

        private sealed class FixedKeyProvider : IKeyProvider
        {
            private readonly string _key;

            public FixedKeyProvider(string key) => _key = key;

            public string GetDesignerMessageKey() => _key;
        }
    }
}
