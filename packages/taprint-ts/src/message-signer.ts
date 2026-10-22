// SPDX-License-Identifier: Apache-2.0
// HostMessage/DesignerMessage HMAC 签名（与 C#/Dart/Java 同构）。
// 一致性由 tests/fixtures/message-signer-v1/v2/v3 + expected-output 锁定。
//
// 数字序列化契约：canonical 串经 JSON.stringify 产出，JS 语义下
// 1.0 → "1"、0.1 → "0.1"（ECMA-262 最短十进制）。多语言实现（TS/C#/Dart）构造消息时
// 必须使用同一数字文法——协议层数字一律为整数或显式小数，禁止依赖各端
// float→string 的本地差异（如 Dart jsonEncode(1.0) = "1.0"），否则签名不一致。
// 浮点规范化由 tests/fixtures/message-signer-v4.json 锁定（0.1/1.0/1e2/2.5 → 0.1/1/100/2.5）。
import { assertJsonSafe, sortKeysDeep } from './internal/canonical.ts';
import { fromBase64, hkdfSha256, hmacSha256, toBase64, utf8 } from './internal/crypto.ts';

const HKDF_SALT = 'taprint-designer-v1';
const HKDF_INFO = 'postmessage-hmac';
const KEY_BYTES = 32;
/** 验签时间窗 ±5 分钟 */
const TIMESTAMP_WINDOW_MS = 5 * 60 * 1000;

export class MessageSigner {
  /** HKDF-SHA256 派生；返回 base64(32 字节密钥)——多语言实现统一表示 */
  static deriveMessageKey(sessionToken: string): string {
    const okm = hkdfSha256(utf8(sessionToken), utf8(HKDF_SALT), utf8(HKDF_INFO), KEY_BYTES);
    return toBase64(okm);
  }

  /**
   * 规范化：顶层剥离 signature、全深度递归 key 字典序、
   * JSON 无多余空白（多语言实现同规则，fixture 锁定）
   */
  static canonicalize(msg: object): string {
    assertJsonSafe(msg, '$');
    const copy = { ...(msg as Record<string, unknown>) };
    delete copy.signature;
    return JSON.stringify(sortKeysDeep(copy));
  }

  /** HMAC-SHA256 → Base64；密钥须 base64 解码为 32 字节原始字节后计算 */
  static sign(msg: object, key: string): string {
    const mac = hmacSha256(MessageSigner.decodeKey(key), utf8(MessageSigner.canonicalize(msg)));
    return toBase64(mac);
  }

  /** 验签：时间窗 ±5 分钟 + 常量时间比较（与宿主侧一致） */
  static verify(msg: object, key: string): boolean {
    const record = msg as Record<string, unknown>;
    const signature = record.signature;
    const timestamp = record.timestamp;
    if (typeof signature !== 'string') return false;
    // 毫秒时间戳必须为整数（浮点时间戳视为伪造/跨端实现错误）
    if (typeof timestamp !== 'number' || !Number.isInteger(timestamp)) return false;
    if (Math.abs(Date.now() - timestamp) > TIMESTAMP_WINDOW_MS) return false;
    try {
      return constantTimeEquals(MessageSigner.sign(msg, key), signature);
    } catch {
      // 畸形密钥/消息不抛给宿主，直接判为验签失败
      return false;
    }
  }

  /** 密钥解码并校验长度（畸形密钥显式失败，避免静默产出错误签名；规范裁决d） */
  private static decodeKey(key: string): Uint8Array {
    const bytes = fromBase64(key);
    if (bytes.length !== KEY_BYTES) {
      throw new TypeError(`MessageSigner: 密钥必须为 ${KEY_BYTES} 字节的 base64`);
    }
    return bytes;
  }
}

// 入参必须 JSON-safe 且无循环引用（assertJsonSafe，internal/canonical.ts）：
// Date/Map/Set/function/undefined/bigint 等会被 JSON.stringify 静默丢弃或变形，
// 导致多语言实现 canonical 串不一致——显式拒绝。

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
