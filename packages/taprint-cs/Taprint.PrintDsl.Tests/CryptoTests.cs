// SPDX-License-Identifier: Apache-2.0
using System;
using Taprint.PrintDsl.Internal;
using Xunit;

// 官方测试向量护栏：FIPS 180-4 / RFC 4231 / RFC 5869，
// 与 print-dsl-ts crypto.spec.ts 同源（期望值为标准文本给定值）。
namespace Taprint.PrintDsl.Tests
{
    public class CryptoTests
    {
        private static byte[] Hex(string s)
        {
            var bytes = new byte[s.Length / 2];
            for (var i = 0; i < bytes.Length; i++)
            {
                bytes[i] = Convert.ToByte(s.Substring(i * 2, 2), 16);
            }
            return bytes;
        }

        [Fact(DisplayName = "sha256：空输入（FIPS 180-4）")]
        public void Sha256Empty()
        {
            Assert.Equal(
                "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
                Crypto.ToHex(Crypto.Sha256(Array.Empty<byte>())));
        }

        [Fact(DisplayName = "sha256：\"abc\"（单块）")]
        public void Sha256Abc()
        {
            Assert.Equal(
                "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
                Crypto.ToHex(Crypto.Sha256(Crypto.Utf8("abc"))));
        }

        [Fact(DisplayName = "sha256：56 字节消息（跨双压缩块，> 55 字节路径）")]
        public void Sha256TwoBlocks()
        {
            Assert.Equal(
                "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
                Crypto.ToHex(Crypto.Sha256(Crypto.Utf8("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"))));
        }

        [Fact(DisplayName = "hmacSha256：RFC 4231 Test Case 1（key=20×0x0b, data=\"Hi There\"）")]
        public void HmacRfc4231Case1()
        {
            var key = new byte[20];
            for (var i = 0; i < key.Length; i++) key[i] = 0x0b;
            Assert.Equal(
                "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7",
                Crypto.ToHex(Crypto.HmacSha256(key, Crypto.Utf8("Hi There"))));
        }

        [Fact(DisplayName = "hkdfSha256：RFC 5869 Test Case 1 Extract（PRK）")]
        public void HkdfRfc5869Extract()
        {
            var ikm = new byte[22];
            for (var i = 0; i < ikm.Length; i++) ikm[i] = 0x0b;
            var salt = Hex("000102030405060708090a0b0c");
            Assert.Equal(
                "077709362c2e32df0ddc3f0dc47bba6390b6c73bb50f9c3122ec844ad7c2b3e5",
                Crypto.ToHex(Crypto.HmacSha256(salt, ikm)));
        }

        [Fact(DisplayName = "hkdfSha256：RFC 5869 Test Case 1 Expand（L=42 > 32，跨 T(1)/T(2) 双块）")]
        public void HkdfRfc5869Expand42()
        {
            var ikm = new byte[22];
            for (var i = 0; i < ikm.Length; i++) ikm[i] = 0x0b;
            var salt = Hex("000102030405060708090a0b0c");
            var info = Hex("f0f1f2f3f4f5f6f7f8f9");
            Assert.Equal(
                "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865",
                Crypto.ToHex(Crypto.HkdfSha256(ikm, salt, info, 42)));
        }

        [Fact(DisplayName = "hkdfSha256：协议固定 32 字节输出为 42 字节 OKM 前缀")]
        public void HkdfRfc5869Expand32IsPrefix()
        {
            var ikm = new byte[22];
            for (var i = 0; i < ikm.Length; i++) ikm[i] = 0x0b;
            var salt = Hex("000102030405060708090a0b0c");
            var info = Hex("f0f1f2f3f4f5f6f7f8f9");
            Assert.Equal(
                "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf",
                Crypto.ToHex(Crypto.HkdfSha256(ikm, salt, info, 32)));
        }

        [Fact(DisplayName = "hkdfSha256：超长输出请求拒绝（len > 32×255）")]
        public void HkdfRejectsTooLarge()
        {
            Assert.Throws<ArgumentOutOfRangeException>(
                () => Crypto.HkdfSha256(new byte[1], new byte[1], new byte[1], 32 * 255 + 1));
        }
    }
}
