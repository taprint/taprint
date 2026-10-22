// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MessageSigner } from '../src/index';

// 跨语言一致性锚点：fixture 输入 → canonical/keyBase64/signature 与
// expected-output 逐字一致（期望值经独立实现按 RFC 5869/HMAC-SHA256 复算核对）
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const fixturesDir = resolve(repoRoot, 'fixtures/templates');
const expectedDir = resolve(repoRoot, 'fixtures/expected/parse-results');
const readInput = (rel: string): unknown =>
  JSON.parse(readFileSync(resolve(fixturesDir, rel), 'utf8')) as unknown;
const readExpected = (rel: string): unknown =>
  JSON.parse(readFileSync(resolve(expectedDir, rel), 'utf8')) as unknown;

const cases: Array<[string, string]> = [
  ['message-signer-v1.json', 'message-signer-result.json'],
  ['message-signer-v2.json', 'message-signer-result-v2.json'],
  ['message-signer-v3.json', 'message-signer-result-v3.json'],
  ['message-signer-v4.json', 'message-signer-result-v4.json'],
  ['message-signer-v5.json', 'message-signer-result-v5.json'],
];

describe('MessageSigner（fixture 锁定）', () => {
  describe.each(cases)('%s', (fixtureRel, expectedRel) => {
    const fixture = readInput(fixtureRel) as {
      sessionToken: string;
      message: Record<string, unknown>;
    };
    const expected = readExpected(expectedRel) as {
      canonical: string;
      keyBase64: string;
      signature: string;
    };

    it('deriveMessageKey 与期望 keyBase64 逐字一致', () => {
      expect(MessageSigner.deriveMessageKey(fixture.sessionToken)).toBe(expected.keyBase64);
    });

    it('canonicalize 与期望 canonical 逐字一致', () => {
      expect(MessageSigner.canonicalize(fixture.message)).toBe(expected.canonical);
    });

    it('sign 与期望 signature 逐字一致', () => {
      const key = MessageSigner.deriveMessageKey(fixture.sessionToken);
      expect(MessageSigner.sign(fixture.message, key)).toBe(expected.signature);
    });

    it('verify 对带有效签名与当前时间窗的消息返回 true', () => {
      const key = MessageSigner.deriveMessageKey(fixture.sessionToken);
      const fresh = { ...fixture.message, timestamp: Date.now() };
      const signature = MessageSigner.sign(fresh, key);
      expect(MessageSigner.verify({ ...fresh, signature }, key)).toBe(true);
    });
  });

  it('verify 拒绝篡改消息', () => {
    const key = MessageSigner.deriveMessageKey('session-x');
    const msg = { type: 'save', timestamp: Date.now(), nonce: 'n' };
    const signature = MessageSigner.sign(msg, key);
    expect(MessageSigner.verify({ ...msg, type: 'steal', signature }, key)).toBe(false);
  });

  it('不同 sessionToken 必派生不同 key', () => {
    expect(MessageSigner.deriveMessageKey('a')).not.toBe(MessageSigner.deriveMessageKey('b'));
    expect(MessageSigner.deriveMessageKey('designer-session-token-fixture')).not.toBe(
      MessageSigner.deriveMessageKey('another-token-✓'),
    );
  });

  it('verify 拒绝超出 ±5 分钟时间窗的消息', () => {
    const key = MessageSigner.deriveMessageKey('session-x');
    const stale = { type: 'save', timestamp: Date.now() - 6 * 60 * 1000, nonce: 'n' };
    const signature = MessageSigner.sign(stale, key);
    expect(MessageSigner.verify({ ...stale, signature }, key)).toBe(false);
  });

  it('verify 拒绝缺失 signature/timestamp 的消息', () => {
    const key = MessageSigner.deriveMessageKey('session-x');
    expect(MessageSigner.verify({ type: 'save', timestamp: Date.now() }, key)).toBe(false);
    expect(MessageSigner.verify({ type: 'save', signature: 'x' }, key)).toBe(false);
  });

  it('canonicalize 剥离顶层 signature 且不影响嵌套', () => {
    const msg = { b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] }, signature: 'ignored' };
    expect(MessageSigner.canonicalize(msg)).toBe('{"a":{"c":[3,{"e":5,"f":4}],"d":2},"b":1}');
  });
});

describe('canonicalize JSON-safe 防御', () => {
  it('拒绝 Date/Map/Set/function/undefined/bigint 等非 JSON-safe 值', () => {
    expect(() => MessageSigner.canonicalize({ t: new Date() })).toThrow(TypeError);
    expect(() => MessageSigner.canonicalize({ m: new Map() })).toThrow(TypeError);
    expect(() => MessageSigner.canonicalize({ s: new Set() })).toThrow(TypeError);
    expect(() => MessageSigner.canonicalize({ f: () => 1 })).toThrow(TypeError);
    expect(() => MessageSigner.canonicalize({ u: undefined })).toThrow(TypeError);
    expect(() => MessageSigner.canonicalize({ n: 1n })).toThrow(TypeError);
    expect(() => MessageSigner.canonicalize({ list: [1, new Date()] })).toThrow(TypeError);
  });

  it('循环引用抛 TypeError 而非栈溢出', () => {
    const cyclic: Record<string, unknown> = { a: {} };
    cyclic.a = cyclic;
    expect(() => MessageSigner.canonicalize(cyclic)).toThrow(TypeError);
    expect(() => MessageSigner.canonicalize(cyclic)).toThrow('循环引用');
    const msg = { type: 'save', timestamp: Date.now(), nonce: 'n', payload: cyclic };
    expect(() => MessageSigner.sign(msg, 'x'.repeat(44))).toThrow(TypeError);
    expect(MessageSigner.verify({ ...msg, signature: 'x'.repeat(44) }, 'x'.repeat(44))).toBe(false);
  });

  it('DAG 共享子对象（非循环）不误报循环引用', () => {
    const shared = { k: 1 };
    const dag = { a: shared, b: shared, list: [shared, shared] };
    expect(MessageSigner.canonicalize(dag)).toBe(
      '{"a":{"k":1},"b":{"k":1},"list":[{"k":1},{"k":1}]}',
    );
    const cyclic: Record<string, unknown> = { a: shared };
    cyclic.a = cyclic;
    expect(() => MessageSigner.canonicalize(cyclic)).toThrow('循环引用');
  });
});

describe('verify 整数时间戳（时间窗防御）', () => {
  it('拒绝浮点 timestamp 的消息', () => {
    const msg = { type: 'save', timestamp: Date.now() + 0.5, nonce: 'n' };
    expect(MessageSigner.verify({ ...msg, signature: 'x'.repeat(44) }, 'x'.repeat(44))).toBe(false);
  });
});

describe('畸形密钥', () => {
  const msg = { type: 'save', timestamp: Date.now(), nonce: 'n' };

  it('sign 对非 32 字节密钥显式抛错', () => {
    expect(() => MessageSigner.sign(msg, Buffer.from('short').toString('base64'))).toThrow(
      TypeError,
    );
  });

  it('verify 对畸形密钥返回 false 而非抛错', () => {
    expect(MessageSigner.verify({ ...msg, signature: 'x'.repeat(44) }, 'not-base64!!!')).toBe(
      false,
    );
    expect(
      MessageSigner.verify(
        { ...msg, signature: 'x'.repeat(44) },
        Buffer.from('short').toString('base64'),
      ),
    ).toBe(false);
  });
});
