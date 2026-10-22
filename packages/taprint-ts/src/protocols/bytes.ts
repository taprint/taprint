// SPDX-License-Identifier: Apache-2.0
// 协议字节流小工具：拼接 / latin1-ASCII 落字节 / 子序列查找。
// 三协议编码器与测试共用（测试的「字节片段断言」即 indexOfBytes）。

/** 校验字符串可无损落为 latin1 字节（码元 > 0xFF 抛错，防静默截断）。 */
export function asciiBytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code > 0xff) {
      throw new RangeError(`asciiBytes 遇到超 latin1 码元 U+${code.toString(16).toUpperCase()}`);
    }
    out[i] = code;
  }
  return out;
}

/** 顺序拼接多段字节（零拷贝预分配）。 */
export function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/** 在 haystack 中查找 needle 首次出现的偏移；未找到返回 -1。 */
export function indexOfBytes(haystack: Uint8Array, needle: Uint8Array): number {
  if (needle.length === 0) return 0;
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

/** 字节流是否包含 needle 连续子序列。 */
export function containsBytes(haystack: Uint8Array, needle: Uint8Array): boolean {
  return indexOfBytes(haystack, needle) >= 0;
}
