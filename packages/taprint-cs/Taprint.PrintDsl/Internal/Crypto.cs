// SPDX-License-Identifier: Apache-2.0
using System;
using System.Security.Cryptography;
using System.Text;

// 加密原语（C# 端；与 print-dsl-ts internal/crypto.ts 同构， fixture 为唯一真值）。
// netstandard2.0 BCL 已含 SHA-256（FIPS 180-4）与 HMAC-SHA256（RFC 2104），直接复用；
// HKDF（RFC 5869）与常量时间比较在 netstandard2.0 无 BCL API，自实现（与 TS 同算法）。
namespace Taprint.PrintDsl.Internal
{
    internal static class Crypto
    {
        public static byte[] Sha256(byte[] data)
        {
            using (var sha = SHA256.Create())
            {
                return sha.ComputeHash(data);
            }
        }

        public static byte[] HmacSha256(byte[] key, byte[] msg)
        {
            using (var hmac = new HMACSHA256(key))
            {
                return hmac.ComputeHash(msg);
            }
        }

        /// <summary>RFC 5869 HKDF-SHA256（与 TS hkdfSha256 逐行同构）。</summary>
        public static byte[] HkdfSha256(byte[] ikm, byte[] salt, byte[] info, int len)
        {
            if (len > 32 * 255) throw new ArgumentOutOfRangeException(nameof(len), "hkdf: length too large");
            var prk = HmacSha256(salt.Length > 0 ? salt : new byte[32], ikm);
            var okm = new byte[len];
            var t = Array.Empty<byte>();
            var filled = 0;
            for (var i = 1; filled < len; i++)
            {
                var block = new byte[t.Length + info.Length + 1];
                Array.Copy(t, 0, block, 0, t.Length);
                Array.Copy(info, 0, block, t.Length, info.Length);
                block[block.Length - 1] = (byte)i;
                t = HmacSha256(prk, block);
                Array.Copy(t, 0, okm, filled, Math.Min(32, len - filled));
                filled += t.Length;
            }
            return okm;
        }

        public static byte[] Utf8(string s) => Encoding.UTF8.GetBytes(s);

        public static string ToHex(byte[] bytes)
        {
            var sb = new StringBuilder(bytes.Length * 2);
            foreach (var b in bytes) sb.Append(b.ToString("x2"));
            return sb.ToString();
        }

        public static string ToBase64(byte[] bytes) => Convert.ToBase64String(bytes);

        /// <summary>base64 解码；非法输入抛 FormatException（TS atob 抛错语义对齐）。</summary>
        public static byte[] FromBase64(string s) => Convert.FromBase64String(s);
    }

    /// <summary>
    /// 常量时间比较（netstandard2.0 无 CryptographicOperations.FixedTimeEquals，自实现；
    /// 语义与  参考代码及 TS constantTimeEquals 一致：先长度比较再逐字节异或累积）。
    /// </summary>
    internal static class FixedTime
    {
        public static bool Equals(byte[] a, byte[] b)
        {
            if (a.Length != b.Length) return false;
            var diff = 0;
            for (var i = 0; i < a.Length; i++) diff |= a[i] ^ b[i];
            return diff == 0;
        }
    }
}
