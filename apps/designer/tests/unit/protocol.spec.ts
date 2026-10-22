// SPDX-License-Identifier: Apache-2.0
import Ajv from 'ajv';
import { describe, expect, it } from 'vitest';
import protocolSchema from '../../schemas/message-protocol.json';
import signerV1 from '../../../../fixtures/templates/message-signer-v1.json';
import signerV2 from '../../../../fixtures/templates/message-signer-v2.json';
import signerV3 from '../../../../fixtures/templates/message-signer-v3.json';
import { DESIGNER_MESSAGE_TYPES, HOST_MESSAGE_TYPES } from '../../src/shared/protocol';

// 三端一致性核验（设计契约）：protocol.ts 枚举常量必须与
// schema/message-protocol.json 的权威枚举逐字相等（含顺序）。
// 任一侧改动必须同步设计契约，否则本测试失败。
const designerEnum = (
  protocolSchema.definitions.DesignerMessage.properties.type as { enum: string[] }
).enum;
const hostEnum = (protocolSchema.definitions.HostMessage.properties.type as { enum: string[] })
  .enum;

describe('消息协议一致性', () => {
  it('DesignerMessage 枚举逐字一致', () => {
    expect([...DESIGNER_MESSAGE_TYPES]).toEqual(designerEnum);
  });

  it('HostMessage 枚举逐字一致', () => {
    expect([...HOST_MESSAGE_TYPES]).toEqual(hostEnum);
  });

  it('token 通道为 kebab-case（防 camelCase 回归）', () => {
    expect(designerEnum).toContain('token-expired');
    expect(designerEnum).toContain('token-check');
    expect(hostEnum).toContain('token-refreshed');
  });
});

// 协议 schema 编译 + fixture 驱动校验：此前只做枚举逐字比较，
// schema 内 typo/悬空 $ref/required 笔误无法被发现。v4 fixture 为浮点归一锚点，
// message 非协议形态，不参与本协议校验。TemplateDSL 在协议 schema 中是
// {type:"object"} 占位（v1.8 注释），DSL 深层校验归 DslValidator（暂不支持）。
describe('message-protocol.json ajv 编译与 fixture 校验', () => {
  const ajv = new Ajv({ allErrors: true });
  const validate = ajv.compile(protocolSchema as object);

  it('schema 可被 ajv（draft-07）编译', () => {
    expect(typeof validate).toBe('function');
  });

  it.each([
    ['v1 saveResult（Host）', signerV1],
    ['v2 save + dsl（Designer）', signerV2],
    ['v3 saveResult 含 null 键（Host）', signerV3],
  ])('fixture %s 的 message（补 signature 后）通过协议校验', (_label, fixture) => {
    const msg = { ...fixture.message, signature: 'fixture-signature-placeholder' };
    expect(validate(msg)).toBe(true);
  });

  it('非法消息被拒绝（未知 type / 缺必填键）', () => {
    expect(validate({ type: 'nope', timestamp: 1, nonce: 'n', signature: 's' })).toBe(false);
    expect(validate({ type: 'ready' })).toBe(false);
  });
});
