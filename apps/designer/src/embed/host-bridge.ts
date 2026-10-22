// SPDX-License-Identifier: Apache-2.0
// 宿主通信传输层（，设计契约 三通道 + 签名挂接）。
// 上行：postMessageToHost 统一补 timestamp/nonce 并签名（密钥按当前 token 每次派生，
// token 刷新即换密钥 ）；下行：onMessageFromHost 纵深验签，失败静默丢弃。
// origin 白名单由宿主经 window.__TAPRINT_DESIGNER_CONFIG__ 注入（严禁 '*'）；
// webview 桥（WPF/Flutter）无 origin 语义，防伪造由 HMAC 承担（威胁模型）。
import { MessageSigner } from 'taprint';
import type { DesignerOutgoingPayload, HostIncomingPayload } from '../shared/protocol';

export interface HostBridgeConfig {
  /**
   * 父页 origin 白名单（iframe 分支校验用；严禁 '*'）。
   * web-iframe 通道：宿主拼接 iframe URL query parentOrigin=<origin>（宿主注入面——
   * URL 由宿主控制，origin 即其自身 origin，无伪造面）；WPF/Flutter webview 桥无 origin
   * 语义，防伪造由 HMAC 承担（威胁模型）。
   */
  parentOrigin: string;
  /** 读取当前会话 token（window.__TAPRINT_TOKEN__） */
  getToken: () => string | undefined;
}

/** 验签通过后分发给 handler 的完整宿主消息 */
export type SignedHostMessage = HostIncomingPayload & {
  timestamp: number;
  nonce: string;
  signature: string;
};

interface WebviewBridge {
  postMessage(msg: unknown): void;
  addEventListener(type: 'message', fn: (ev: MessageEvent) => void): void;
  removeEventListener(type: 'message', fn: (ev: MessageEvent) => void): void;
}

interface HostWindow extends Window {
  chrome?: { webview?: WebviewBridge };
  designerHost?: { postMessage(json: string): void };
}

const win = (): HostWindow => window as HostWindow;

let config: HostBridgeConfig | null = null;

/** 初始化桥配置；parentOrigin 必填且严禁 '*'。重复调用覆写（token 刷新场景无需重配） */
export function initHostBridge(cfg: HostBridgeConfig): void {
  if (!cfg.parentOrigin || cfg.parentOrigin === '*') {
    throw new Error('HOST_BRIDGE_ORIGIN_INVALID: parentOrigin 必填且严禁 "*"');
  }
  config = cfg;
}

export function isHostBridgeReady(): boolean {
  return config !== null;
}

/** 已配置的 parentOrigin（未初始化返回 null）——iframe 明文 token 通道用 */
export function getParentOrigin(): string | null {
  return config?.parentOrigin ?? null;
}

/** 测试隔离用 */
export function resetHostBridge(): void {
  config = null;
}

type Channel = 'wpf' | 'flutter' | 'iframe' | 'none';

/** 通道判定：chrome.webview（WPF）→ designerHost（Flutter）→ parent（iframe） */
function detectChannel(): Channel {
  const w = win();
  if (w.chrome?.webview?.postMessage) return 'wpf';
  if (w.designerHost?.postMessage) return 'flutter';
  if (window.parent !== window) return 'iframe';
  return 'none';
}

function deriveKey(): string | null {
  const token = config?.getToken();
  if (!token) return null;
  return MessageSigner.deriveMessageKey(token);
}

/**
 * 上行消息：补 timestamp/nonce → 签名 → 三通道发送。
 * 返回 false = 未发送（桥未初始化 / 无 token / 无可用通道），调用方自行降级。
 */
export function postMessageToHost(payload: DesignerOutgoingPayload): boolean {
  if (!config) {
    console.warn('[host-bridge] 未初始化即发送，消息丢弃：', payload.type);
    return false;
  }
  const key = deriveKey();
  if (!key) {
    console.warn('[host-bridge] 无会话 token，消息丢弃：', payload.type);
    return false;
  }
  // JSON 往返转纯：payload 可能携带 Vue 响应式代理（store.dsl），postMessage 结构化
  // 克隆拒绝 Proxy（DataCloneError）；往返亦与 canonicalize 的 JSON 语义一致
  const msg: Record<string, unknown> = {
    ...(JSON.parse(JSON.stringify(payload)) as Record<string, unknown>),
    timestamp: Date.now(),
    nonce: crypto.randomUUID(),
  };
  msg.signature = MessageSigner.sign(msg, key);

  const channel = detectChannel();
  const w = win();
  if (channel === 'wpf') {
    w.chrome?.webview?.postMessage(msg);
    return true;
  }
  if (channel === 'flutter') {
    w.designerHost?.postMessage(JSON.stringify(msg));
    return true;
  }
  if (channel === 'iframe') {
    window.parent.postMessage(msg, config.parentOrigin);
    return true;
  }
  console.warn('[host-bridge] 无可用宿主通道，消息丢弃：', payload.type);
  return false;
}

function tryParseJson(s: string): unknown {
  try {
    return JSON.parse(s) as unknown;
  } catch {
    return null;
  }
}

/**
 * 下行监听：WPF 监听 chrome.webview message 事件，其余 window message；
 * iframe 分支校验 ev.origin === parentOrigin；一律 MessageSigner.verify 纵深验签，
 * 失败静默丢弃。返回解绑函数（SDK destroy 用）。
 */
export function onMessageFromHost(handler: (msg: SignedHostMessage) => void): () => void {
  const handle = (ev: MessageEvent): void => {
    if (!config) return;
    // iframe 分支 origin 白名单（webview 桥事件无 origin 语义，HMAC 承担防伪造）
    if (detectChannel() === 'iframe' && ev.origin !== config.parentOrigin) return;
    const data: unknown = typeof ev.data === 'string' ? tryParseJson(ev.data) : ev.data;
    if (!data || typeof data !== 'object' || !('type' in data)) return;
    const key = deriveKey();
    if (!key) return;
    // 验签失败静默丢弃（纵深防御：宿主可信进程被劫持/消息篡改）
    if (!MessageSigner.verify(data as object, key)) return;
    handler(data as SignedHostMessage);
  };

  const w = win();
  if (detectChannel() === 'wpf' && w.chrome?.webview?.addEventListener) {
    w.chrome.webview.addEventListener('message', handle);
    return () => w.chrome?.webview?.removeEventListener('message', handle);
  }
  window.addEventListener('message', handle);
  return () => window.removeEventListener('message', handle);
}
