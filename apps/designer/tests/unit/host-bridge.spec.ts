// SPDX-License-Identifier: Apache-2.0
// 宿主通信传输层单测（块 A）：签名挂接 + 三通道分支 + origin 白名单 + 验签拒收。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageSigner } from 'taprint';
import {
  initHostBridge,
  isHostBridgeReady,
  onMessageFromHost,
  postMessageToHost,
  resetHostBridge,
  type SignedHostMessage,
} from '../../src/embed/host-bridge';

const TOKEN = 'designer-session-token-fixture';
const KEY = MessageSigner.deriveMessageKey(TOKEN);
const PARENT = 'https://host.example.test';

interface WebviewMock {
  postMessage: ReturnType<typeof vi.fn>;
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
  listeners: Map<string, (ev: MessageEvent) => void>;
}

function mockWpf(): WebviewMock {
  const listeners = new Map<string, (ev: MessageEvent) => void>();
  const bridge: WebviewMock = {
    postMessage: vi.fn(),
    listeners,
    addEventListener: vi.fn((type: string, fn: (ev: MessageEvent) => void) => {
      listeners.set(type, fn);
    }),
    removeEventListener: vi.fn((type: string) => {
      listeners.delete(type);
    }),
  };
  (window as unknown as { chrome: unknown }).chrome = { webview: bridge };
  return bridge;
}

function mockFlutter(): { postMessage: ReturnType<typeof vi.fn> } {
  const host = { postMessage: vi.fn() };
  (window as unknown as { designerHost: unknown }).designerHost = host;
  return host;
}

function mockIframe(): { postMessage: ReturnType<typeof vi.fn> } {
  const parent = { postMessage: vi.fn() };
  Object.defineProperty(window, 'parent', { value: parent, configurable: true });
  return parent;
}

function clearMocks(): void {
  delete (window as unknown as { chrome?: unknown }).chrome;
  delete (window as unknown as { designerHost?: unknown }).designerHost;
  Object.defineProperty(window, 'parent', { value: window, configurable: true });
}

function signedHostMessage(over: Record<string, unknown> = {}): Record<string, unknown> {
  const msg: Record<string, unknown> = {
    type: 'saveResult',
    success: true,
    timestamp: Date.now(),
    nonce: crypto.randomUUID(),
    ...over,
  };
  msg.signature = MessageSigner.sign(msg, KEY);
  return msg;
}

beforeEach(() => {
  clearMocks();
  window.__TAPRINT_TOKEN__ = TOKEN;
  initHostBridge({ parentOrigin: PARENT, getToken: () => window.__TAPRINT_TOKEN__ });
});

afterEach(() => {
  resetHostBridge();
  clearMocks();
  delete window.__TAPRINT_TOKEN__;
  vi.restoreAllMocks();
});

describe('initHostBridge 安全门禁', () => {
  it('parentOrigin 为 "*" 或空时拒绝初始化', () => {
    expect(() => initHostBridge({ parentOrigin: '*', getToken: () => TOKEN })).toThrow(
      'HOST_BRIDGE_ORIGIN_INVALID',
    );
    expect(() => initHostBridge({ parentOrigin: '', getToken: () => TOKEN })).toThrow();
    expect(isHostBridgeReady()).toBe(true); // beforeEach 的合法配置仍生效
  });
});

describe('postMessageToHost（上行）', () => {
  it('信封四要素齐备且签名可被 MessageSigner.verify 复核（WPF 通道）', () => {
    const bridge = mockWpf();
    const sent = postMessageToHost({ type: 'ready' });
    expect(sent).toBe(true);
    expect(bridge.postMessage).toHaveBeenCalledTimes(1);
    const msg = bridge.postMessage.mock.calls[0][0] as Record<string, unknown>;
    expect(msg.type).toBe('ready');
    expect(Number.isInteger(msg.timestamp)).toBe(true);
    expect(typeof msg.nonce).toBe('string');
    expect((msg.nonce as string).length).toBeGreaterThanOrEqual(32);
    expect(typeof msg.signature).toBe('string');
    expect(MessageSigner.verify(msg, KEY)).toBe(true);
  });

  it('save 消息携带 dsl 平铺字段（无 payload 包装）', () => {
    const bridge = mockWpf();
    postMessageToHost({ type: 'save', dsl: { code: 'T1' }, deviceClass: 'doc' });
    const msg = bridge.postMessage.mock.calls[0][0] as Record<string, unknown>;
    expect(msg.dsl).toEqual({ code: 'T1' });
    expect(msg.deviceClass).toBe('doc');
    expect('payload' in msg).toBe(false);
  });

  it('三通道分支：WPF 对象 / Flutter JSON 字符串 / iframe parent.postMessage + targetOrigin', () => {
    const bridge = mockWpf();
    postMessageToHost({ type: 'ready' });
    expect(typeof bridge.postMessage.mock.calls[0][0]).toBe('object');
    clearMocks();

    const flutter = mockFlutter();
    postMessageToHost({ type: 'ready' });
    expect(typeof flutter.postMessage.mock.calls[0][0]).toBe('string');
    expect(JSON.parse(flutter.postMessage.mock.calls[0][0] as string).type).toBe('ready');
    clearMocks();

    const parent = mockIframe();
    postMessageToHost({ type: 'ready' });
    expect(parent.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'ready' }),
      PARENT,
    );
  });

  it('未初始化 / 无 token / 无通道 时降级为 false（不抛错）', () => {
    resetHostBridge();
    expect(postMessageToHost({ type: 'ready' })).toBe(false);
    initHostBridge({ parentOrigin: PARENT, getToken: () => window.__TAPRINT_TOKEN__ });

    delete window.__TAPRINT_TOKEN__;
    expect(postMessageToHost({ type: 'ready' })).toBe(false);
    window.__TAPRINT_TOKEN__ = TOKEN;

    expect(postMessageToHost({ type: 'ready' })).toBe(false); // jsdom 无桥且 parent===window
  });

  it('token 刷新后按新 token 派生密钥（刷新即换密钥）', () => {
    const bridge = mockWpf();
    window.__TAPRINT_TOKEN__ = 'refreshed-token';
    postMessageToHost({ type: 'ready' });
    const msg = bridge.postMessage.mock.calls[0][0] as Record<string, unknown>;
    expect(MessageSigner.verify(msg, KEY)).toBe(false);
    expect(MessageSigner.verify(msg, MessageSigner.deriveMessageKey('refreshed-token'))).toBe(true);
  });
});

describe('onMessageFromHost（下行验签）', () => {
  function emit(data: unknown, origin = 'https://other.test'): void {
    window.dispatchEvent(new MessageEvent('message', { data, origin }));
  }

  it('验签通过的宿主消息被分发', async () => {
    const received: SignedHostMessage[] = [];
    onMessageFromHost((m) => received.push(m));
    emit(signedHostMessage());
    await Promise.resolve();
    expect(received).toHaveLength(1);
    expect(received[0].type).toBe('saveResult');
  });

  it('string 形态 data 经 tryParseJson 解析后同样分发（Flutter runJavaScript 口径）', async () => {
    const received: SignedHostMessage[] = [];
    onMessageFromHost((m) => received.push(m));
    emit(JSON.stringify(signedHostMessage()));
    await Promise.resolve();
    expect(received).toHaveLength(1);
  });

  it('篡改消息被静默丢弃（签名不匹配）', async () => {
    const received: SignedHostMessage[] = [];
    onMessageFromHost((m) => received.push(m));
    const tampered = signedHostMessage();
    tampered.success = false;
    emit(tampered);
    await Promise.resolve();
    expect(received).toHaveLength(0);
  });

  it('超窗 timestamp 被拒收（±5min）', async () => {
    const received: SignedHostMessage[] = [];
    onMessageFromHost((m) => received.push(m));
    emit(signedHostMessage({ timestamp: Date.now() - 6 * 60 * 1000 }));
    await Promise.resolve();
    expect(received).toHaveLength(0);
  });

  it('无 type / 无 token 时丢弃', async () => {
    const received: SignedHostMessage[] = [];
    onMessageFromHost((m) => received.push(m));
    emit({ foo: 1 });
    delete window.__TAPRINT_TOKEN__;
    emit(signedHostMessage());
    window.__TAPRINT_TOKEN__ = TOKEN;
    await Promise.resolve();
    expect(received).toHaveLength(0);
  });

  it('iframe 分支：origin 不匹配拒收、匹配放行（白名单）', async () => {
    mockIframe();
    const received: SignedHostMessage[] = [];
    onMessageFromHost((m) => received.push(m));
    emit(signedHostMessage(), 'https://evil.test');
    await Promise.resolve();
    expect(received).toHaveLength(0);
    emit(signedHostMessage(), PARENT);
    await Promise.resolve();
    expect(received).toHaveLength(1);
  });

  it('WPF 分支监听 chrome.webview message 事件且解绑函数生效', () => {
    const bridge = mockWpf();
    const received: SignedHostMessage[] = [];
    const unbind = onMessageFromHost((m) => received.push(m));
    expect(bridge.addEventListener).toHaveBeenCalledWith('message', expect.any(Function));
    const listener = bridge.listeners.get('message');
    expect(listener).toBeDefined();
    listener?.(new MessageEvent('message', { data: signedHostMessage() }));
    expect(received).toHaveLength(1);
    unbind();
    expect(bridge.removeEventListener).toHaveBeenCalled();
  });
});
