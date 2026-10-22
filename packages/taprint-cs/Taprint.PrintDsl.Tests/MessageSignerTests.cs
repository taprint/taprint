// SPDX-License-Identifier: Apache-2.0
using System;
using System.Collections.Generic;
using Xunit;

//  多语言实现一致性锚点：fixture 输入 → canonical/keyBase64/signature 与
// 期望值逐字一致；行为用例为 print-dsl-ts message-signer.spec.ts 等价移植。
namespace Taprint.PrintDsl.Tests
{
    public class MessageSignerTests
    {
        public static TheoryData<string, string> Cases => new TheoryData<string, string>
        {
            { "fixtures/templates/message-signer-v1.json", "message-signer-result.json" },
            { "fixtures/templates/message-signer-v2.json", "message-signer-result-v2.json" },
            { "fixtures/templates/message-signer-v3.json", "message-signer-result-v3.json" },
            { "fixtures/templates/message-signer-v4.json", "message-signer-result-v4.json" },
            { "fixtures/templates/message-signer-v5.json", "message-signer-result-v5.json" },
        };

        private static Dictionary<string, object?> ReadMessage(string fixtureRel)
            => (Dictionary<string, object?>)((Dictionary<string, object?>)RepoPaths.ReadJsonTree(fixtureRel)!)["message"]!;

        private static string ReadSessionToken(string fixtureRel)
            => (string)((Dictionary<string, object?>)RepoPaths.ReadJsonTree(fixtureRel)!)["sessionToken"]!;

        private static Dictionary<string, object?> ReadExpected(string expectedRel)
            => (Dictionary<string, object?>)RepoPaths.ExpectedJson(expectedRel)!;

        [Theory]
        [MemberData(nameof(Cases))]
        public void DeriveMessageKey_逐字一致(string fixtureRel, string expectedRel)
        {
            var expected = (string)ReadExpected(expectedRel)["keyBase64"]!;
            Assert.Equal(expected, MessageSigner.DeriveMessageKey(ReadSessionToken(fixtureRel)));
        }

        [Theory]
        [MemberData(nameof(Cases))]
        public void Canonicalize_逐字一致(string fixtureRel, string expectedRel)
        {
            var expected = (string)ReadExpected(expectedRel)["canonical"]!;
            Assert.Equal(expected, MessageSigner.Canonicalize(ReadMessage(fixtureRel)));
        }

        [Theory]
        [MemberData(nameof(Cases))]
        public void Sign_逐字一致(string fixtureRel, string expectedRel)
        {
            var expected = ReadExpected(expectedRel);
            var key = MessageSigner.DeriveMessageKey(ReadSessionToken(fixtureRel));
            Assert.Equal((string)expected["signature"]!, MessageSigner.Sign(ReadMessage(fixtureRel), key));
        }

        [Theory]
        [MemberData(nameof(Cases))]
        public void Verify_时间窗内有效签名返回True(string fixtureRel, string expectedRel)
        {
            _ = ReadExpected(expectedRel); // 期望文件存在性一并锚定
            var key = MessageSigner.DeriveMessageKey(ReadSessionToken(fixtureRel));
            var fresh = new Dictionary<string, object?>(ReadMessage(fixtureRel))
            {
                ["timestamp"] = (double)DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            };
            var signature = MessageSigner.Sign(fresh, key);
            fresh["signature"] = signature;
            Assert.True(MessageSigner.Verify(fresh, key));
        }

        [Fact(DisplayName = "verify 拒绝篡改消息")]
        public void VerifyRejectsTamperedMessage()
        {
            var key = MessageSigner.DeriveMessageKey("session-x");
            var msg = new Dictionary<string, object?>
            {
                ["type"] = "save",
                ["timestamp"] = (double)DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                ["nonce"] = "n",
            };
            var signature = MessageSigner.Sign(msg, key);
            msg["type"] = "steal";
            msg["signature"] = signature;
            Assert.False(MessageSigner.Verify(msg, key));
        }

        [Fact(DisplayName = "不同 sessionToken 必派生不同 key")]
        public void DistinctTokensDeriveDistinctKeys()
        {
            Assert.NotEqual(MessageSigner.DeriveMessageKey("a"), MessageSigner.DeriveMessageKey("b"));
            Assert.NotEqual(
                MessageSigner.DeriveMessageKey("designer-session-token-fixture"),
                MessageSigner.DeriveMessageKey("another-token-✓"));
        }

        [Fact(DisplayName = "verify 拒绝超出 ±5 分钟时间窗的消息")]
        public void VerifyRejectsOutOfWindow()
        {
            var key = MessageSigner.DeriveMessageKey("session-x");
            var stale = new Dictionary<string, object?>
            {
                ["type"] = "save",
                ["timestamp"] = (double)(DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - 6 * 60 * 1000),
                ["nonce"] = "n",
            };
            stale["signature"] = MessageSigner.Sign(stale, key);
            Assert.False(MessageSigner.Verify(stale, key));
        }

        [Fact(DisplayName = "verify 拒绝缺失 signature/timestamp 的消息")]
        public void VerifyRejectsMissingFields()
        {
            var key = MessageSigner.DeriveMessageKey("session-x");
            var now = (double)DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            Assert.False(MessageSigner.Verify(new Dictionary<string, object?> { ["type"] = "save", ["timestamp"] = now }, key));
            Assert.False(MessageSigner.Verify(new Dictionary<string, object?> { ["type"] = "save", ["signature"] = "x" }, key));
        }

        [Fact(DisplayName = "canonicalize 剥离顶层 signature 且不影响嵌套")]
        public void CanonicalizeStripsTopLevelSignatureOnly()
        {
            var msg = new Dictionary<string, object?>
            {
                ["b"] = 1d,
                ["a"] = new Dictionary<string, object?>
                {
                    ["d"] = 2d,
                    ["c"] = new List<object?> { 3d, new Dictionary<string, object?> { ["f"] = 4d, ["e"] = 5d } },
                },
                ["signature"] = "ignored",
            };
            Assert.Equal("{\"a\":{\"c\":[3,{\"e\":5,\"f\":4}],\"d\":2},\"b\":1}", MessageSigner.Canonicalize(msg));
        }

        [Fact(DisplayName = "canonicalize 拒绝非 JSON-safe 值（DateTime/自定义类型；）")]
        public void CanonicalizeRejectsNonJsonSafe()
        {
            Assert.Throws<ArgumentException>(() =>
                MessageSigner.Canonicalize(new Dictionary<string, object?> { ["t"] = DateTime.UtcNow }));
            Assert.Throws<ArgumentException>(() =>
                MessageSigner.Canonicalize(new Dictionary<string, object?> { ["p"] = new object() }));
            Assert.Throws<ArgumentException>(() =>
                MessageSigner.Canonicalize(new Dictionary<string, object?> { ["list"] = new List<object?> { 1d, DateTime.UtcNow } }));
            Assert.Throws<ArgumentException>(() =>
                MessageSigner.Canonicalize(new Dictionary<string, object?> { ["nan"] = double.NaN }));
        }

        [Fact(DisplayName = "循环引用抛异常而非栈溢出")]
        public void CanonicalizeRejectsCycles()
        {
            var cyclic = new Dictionary<string, object?>();
            cyclic["a"] = cyclic;
            var ex = Assert.Throws<ArgumentException>(() => MessageSigner.Canonicalize(cyclic));
            Assert.Contains("循环引用", ex.Message);

            var msg = new Dictionary<string, object?>
            {
                ["type"] = "save",
                ["timestamp"] = (double)DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                ["nonce"] = "n",
                ["payload"] = cyclic,
            };
            var key = new string('x', 44);
            Assert.ThrowsAny<Exception>(() => MessageSigner.Sign(msg, key));
            msg["signature"] = new string('x', 44);
            Assert.False(MessageSigner.Verify(msg, key));
        }

        [Fact(DisplayName = "DAG 共享子对象（非循环）不误报循环引用（十轮遗留观察 1）")]
        public void CanonicalizeAllowsDagSharing()
        {
            var shared = new Dictionary<string, object?> { ["k"] = 1d };
            var dag = new Dictionary<string, object?>
            {
                ["a"] = shared,
                ["b"] = shared,
                ["list"] = new List<object?> { shared, shared },
            };
            Assert.Equal(
                "{\"a\":{\"k\":1},\"b\":{\"k\":1},\"list\":[{\"k\":1},{\"k\":1}]}",
                MessageSigner.Canonicalize(dag));

            var cyclic = new Dictionary<string, object?> { ["a"] = shared };
            cyclic["a"] = cyclic;
            var ex = Assert.Throws<ArgumentException>(() => MessageSigner.Canonicalize(cyclic));
            Assert.Contains("循环引用", ex.Message);
        }

        [Fact(DisplayName = "verify 拒绝浮点 timestamp 的消息")]
        public void VerifyRejectsFractionalTimestamp()
        {
            var msg = new Dictionary<string, object?>
            {
                ["type"] = "save",
                ["timestamp"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 0.5,
                ["nonce"] = "n",
                ["signature"] = new string('x', 44),
            };
            Assert.False(MessageSigner.Verify(msg, new string('x', 44)));
        }

        [Fact(DisplayName = "sign 对非 32 字节密钥显式抛错")]
        public void SignRejectsWrongLengthKey()
        {
            var msg = new Dictionary<string, object?>
            {
                ["type"] = "save",
                ["timestamp"] = (double)DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                ["nonce"] = "n",
            };
            Assert.Throws<ArgumentException>(() =>
                MessageSigner.Sign(msg, Convert.ToBase64String(System.Text.Encoding.UTF8.GetBytes("short"))));
        }

        [Fact(DisplayName = "verify 对畸形密钥返回 false 而非抛错")]
        public void VerifyReturnsFalseForMalformedKey()
        {
            var msg = new Dictionary<string, object?>
            {
                ["type"] = "save",
                ["timestamp"] = (double)DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                ["nonce"] = "n",
                ["signature"] = new string('x', 44),
            };
            Assert.False(MessageSigner.Verify(msg, "not-base64!!!"));
            Assert.False(MessageSigner.Verify(msg, Convert.ToBase64String(System.Text.Encoding.UTF8.GetBytes("short"))));
        }
    }
}
