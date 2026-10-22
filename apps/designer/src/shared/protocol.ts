// SPDX-License-Identifier: Apache-2.0
// HostMessage/DesignerMessage 消息契约类型（设计契约）
//
// 安全模型：四要素 type/timestamp/nonce/signature；HMAC-SHA256；
// 密钥由会话 token 经 HKDF（salt=taprint-designer-v1, info=postmessage-hmac）派生；
// 时间窗 ±5 分钟；signature 覆盖全深度递归 key 字典序规范化 JSON。
//
// ⚠️ 消息对象规定 additionalProperties: false——不得附加 payload 等 schema
// 外字段；各消息的业务数据走 schema 内定名字段（dsl/deviceClass/templateId/...）。
//
// postMessage 收发、window.__TAPRINT_TOKEN__ 读取、MessageSigner sign/verify
// 挂接由 src/embed/host-bridge.ts 与 src/embed/sdk-core.ts 承接（本文件仍无运行时
// 逻辑，仅类型）。

/** 设计器 → 宿主 消息基座（四要素签名） */
export interface DesignerMessage {
  type: DesignerMessageType;
  timestamp: number;
  nonce: string;
  signature: string;
}

/** 宿主 → 设计器 消息基座（四要素签名） */
export interface HostMessage {
  type: HostMessageType;
  timestamp: number;
  nonce: string;
  signature: string;
}

/**
 * 设计器 → 宿主 消息类型（权威枚举）：
 * token 通道为 kebab-case（'token-expired'/'token-check'），与 SDK、
 * C# switch case、C# 模型注释一致——camelCase 会被宿主拒绝。
 */
export type DesignerMessageType =
  | 'ready'
  | 'save'
  | 'preview'
  | 'testPrint'
  | 'dirty'
  | 'close'
  | 'error'
  | 'token-expired'
  | 'token-check';

/** 宿主 → 设计器 消息类型（权威枚举；closeRequest 重新注册） */
export type HostMessageType =
  | 'loadTemplate'
  | 'saveResult'
  | 'setReadOnly'
  | 'previewResult'
  | 'printResult'
  | 'token-refreshed'
  | 'closeRequest';

/** 与 schema/message-protocol.json 一致性自检的常量镜像（测试断言其相等） */
export const DESIGNER_MESSAGE_TYPES: readonly DesignerMessageType[] = [
  'ready',
  'save',
  'preview',
  'testPrint',
  'dirty',
  'close',
  'error',
  'token-expired',
  'token-check',
];

export const HOST_MESSAGE_TYPES: readonly HostMessageType[] = [
  'loadTemplate',
  'saveResult',
  'setReadOnly',
  'previewResult',
  'printResult',
  'token-refreshed',
  'closeRequest',
];

// ── 消息 payload 具名接口（镜像 schema/message-protocol.json 定名字段） ──
// 发送侧不含 timestamp/nonce/signature——由 host-bridge.postMessageToHost 统一补齐后签名。

/** DSL 载荷：协议层不耦合内核类型，深层校验归 DslValidator（schema TemplateDSL 占位 object 同口径） */
export type MessageDsl = Record<string, unknown>;

// preview/testPrint 上行携带 dsl + deviceClass（schema/message-protocol.json
// DesignerMessage.properties 允许 dsl/deviceClass 字段，additionalProperties:false 范围内；
// receipt/label 附本地仿真 PNG 经 previewPng base64 字段——schema additionalProperties:
// false 禁止此键，故仿真 PNG 改走「同 token 通道 B」父页直推或宿主本地路径直连的口子
// 暂未启用；当前 previewPng 不进 message 信封，仅作为 design state 透传给本地预览面板）。
// 经核实 schema 锁定：previewPng 不能进 message——本轮 preview 上行只带 dsl/deviceClass；
// 本地仿真 PNG 仍由设计器自身 PreviewPane 渲染（过渡能力）。
export type DesignerOutgoingPayload =
  | { type: 'ready' }
  | { type: 'save'; dsl: MessageDsl; deviceClass?: 'doc' | 'receipt' | 'label' }
  | { type: 'preview'; dsl: MessageDsl; deviceClass: 'doc' | 'receipt' | 'label' }
  | { type: 'testPrint'; dsl: MessageDsl; deviceClass: 'doc' | 'receipt' | 'label' }
  | { type: 'dirty'; dirty: boolean }
  | { type: 'close' }
  | { type: 'error'; errorMessage: string }
  | { type: 'token-expired' }
  | { type: 'token-check' };

/** 验签后的宿主消息（可选字段按 schema 定义；null 形态归 C# 端，Web 发送端省略键） */
export type HostIncomingPayload =
  | { type: 'loadTemplate'; dsl: MessageDsl; templateId?: string; version?: number }
  | { type: 'saveResult'; success: boolean; errorMessage?: string }
  | { type: 'setReadOnly'; readonly: boolean }
  | { type: 'previewResult'; previewUrl?: string; errorMessage?: string }
  | { type: 'printResult'; success?: boolean; errorMessage?: string }
  | { type: 'token-refreshed' }
  | { type: 'closeRequest' };
