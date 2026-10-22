// SPDX-License-Identifier: Apache-2.0
// sdk-core × session-monitor 接线单测：
// 远程路径回调装配——直连 refresh 成功写回 window.__TAPRINT_TOKEN__（换钥）、
// check 401 → notifyTokenExpired（token-expired 上行 + 致命态）、
// iframe 父页明文 taprint-token-expired 通知。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageSigner } from 'taprint';
import {
  destroyEmbed,
  embedState,
  notifyTokenExpired,
  startTokenExpiryWatch,
  stopTokenExpiryWatch,
  type TokenMonitorHandle,
} from '../../src/embed/sdk-core';
import { initHostBridge, resetHostBridge } from '../../src/embed/host-bridge';
import {
  createMockSessionTransport,
  sessionApi,
  setMockSessionTtl,
  setSessionTransport,
} from '../../src/shared/session-api';

const TOKEN = 'designer-session-token-fixture';
const KEY = MessageSigner.deriveMessageKey(TOKEN);
const PARENT = 'https://host.example.test';

interface WebviewMock {
  postMessage: ReturnType<typeof vi.fn>;
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
}

function mockWpf(): WebviewMock {
  const bridge: WebviewMock = {
    postMessage: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  (window as unknown as { chrome: unknown }).chrome = { webview: bridge };
  return bridge;
}

function captureInterval() {
  let tick: (() => void) | null = null;
  const createInterval = vi.fn((fn: () => void, _ms: number): TokenMonitorHandle => {
    tick = fn;
    return { clear: vi.fn() };
  });
  return {
    createInterval,
    fire: async () => {
      tick?.();
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

beforeEach(() => {
  setSessionTransport(createMockSessionTransport());
  setMockSessionTtl(null);
  delete window.__TAPRINT_TOKEN__;
});

afterEach(() => {
  destroyEmbed();
  resetHostBridge();
  delete (window as unknown as { chrome?: unknown }).chrome;
  delete window.__TAPRINT_TOKEN__;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('sdk-core 监控接线（远程 session-api 路径）', () => {
  it('剩余 TTL ≤10% 主动 refresh：新 token 写回 window.__TAPRINT_TOKEN__ + 派发注入事件', async () => {
    vi.useFakeTimers();
    window.__TAPRINT_TOKEN__ = TOKEN;
    // mock transport 登记 TOKEN：issue→exchange 得真 token（TTL 1s），逼近阈值
    setMockSessionTtl(1_000);
    const { code } = await sessionApi.issueCode({ userId: 'u1', origin: 'http://localhost:3000' });
    const { token } = await sessionApi.exchange({ code, origin: 'http://localhost:3000' });
    window.__TAPRINT_TOKEN__ = token;
    vi.advanceTimersByTime(950); // 剩余 50ms ≤ 10% × 1000ms

    const injected = vi.fn();
    window.addEventListener('taprint-token-injected', injected);
    const interval = captureInterval();
    startTokenExpiryWatch({ localEmbed: false, createInterval: interval.createInterval });
    await interval.fire();

    expect(window.__TAPRINT_TOKEN__).not.toBe(token); // 已换新 token
    expect(injected).toHaveBeenCalledTimes(1); // 刷新即换密钥：密钥按 getToken 现读自动生效
    expect(embedState.tokenStatus).not.toBe('expired');
    window.removeEventListener('taprint-token-injected', injected);
    stopTokenExpiryWatch();
  });

  it('check 401：notifyTokenExpired 链路——token-expired 上行（签名可复核）+ 致命态', async () => {
    vi.useFakeTimers();
    const bridge = mockWpf();
    window.__TAPRINT_TOKEN__ = TOKEN;
    initHostBridge({ parentOrigin: PARENT, getToken: () => window.__TAPRINT_TOKEN__ });

    setMockSessionTtl(1_000);
    const { code } = await sessionApi.issueCode({ userId: 'u1', origin: 'http://localhost:3000' });
    const { token } = await sessionApi.exchange({ code, origin: 'http://localhost:3000' });
    window.__TAPRINT_TOKEN__ = token;
    vi.advanceTimersByTime(1_001); // mock TTL 到期 → check 401

    const interval = captureInterval();
    startTokenExpiryWatch({ localEmbed: false, createInterval: interval.createInterval });
    await interval.fire();

    expect(embedState.tokenStatus).toBe('expired');
    expect(embedState.status).toBe('fatal');
    expect(embedState.fatalMessage).toContain('401');
    const expiredCalls = bridge.postMessage.mock.calls.filter(
      (c) => (c[0] as { type: string }).type === 'token-expired',
    );
    expect(expiredCalls.length).toBe(1);
    // 签名按触发时刻的 token 派生（签名链路零回归）
    expect(
      MessageSigner.verify(expiredCalls[0][0] as object, MessageSigner.deriveMessageKey(token)),
    ).toBe(true);
  });

  it('notifyTokenExpired：iframe 场景明文通知父页 taprint-token-expired', () => {
    const bridge = mockWpf();
    window.__TAPRINT_TOKEN__ = TOKEN;
    initHostBridge({ parentOrigin: PARENT, getToken: () => window.__TAPRINT_TOKEN__ });
    const postToParent = vi.fn();
    const originalParent = window.parent;
    Object.defineProperty(window, 'parent', {
      value: { postMessage: postToParent },
      configurable: true,
    });
    try {
      embedState.status = 'connected';
      notifyTokenExpired('测试触发');
      expect(postToParent).toHaveBeenCalledWith({ type: 'taprint-token-expired' }, PARENT);
      // 签名信封通道同步上行 token-expired（两通道并行，口径 ）
      const expiredCalls = bridge.postMessage.mock.calls.filter(
        (c) => (c[0] as { type: string }).type === 'token-expired',
      );
      expect(expiredCalls.length).toBe(1);
    } finally {
      Object.defineProperty(window, 'parent', { value: originalParent, configurable: true });
    }
  });

  it('本地路径接线：token-check 经 host-bridge 上行（签名链路零回归）', async () => {
    const bridge = mockWpf();
    window.__TAPRINT_TOKEN__ = TOKEN;
    initHostBridge({ parentOrigin: PARENT, getToken: () => window.__TAPRINT_TOKEN__ });
    const interval = captureInterval();
    startTokenExpiryWatch({ localEmbed: true, createInterval: interval.createInterval });
    await interval.fire();
    const tokenCheckCalls = bridge.postMessage.mock.calls.filter(
      (c) => (c[0] as { type: string }).type === 'token-check',
    );
    expect(tokenCheckCalls.length).toBe(1);
    expect(MessageSigner.verify(tokenCheckCalls[0][0] as object, KEY)).toBe(true);
    stopTokenExpiryWatch();
  });
});
