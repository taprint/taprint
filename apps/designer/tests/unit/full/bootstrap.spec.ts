// SPDX-License-Identifier: Apache-2.0
// full 模式 ensureSession + session 监控单测：
// code 兑换 → token 仅内存 → URL 清 code → 60s 监控启动；无 code 降级 no-op；
// 兑换失败弹窗 + AuthRedirectError 中断；监控 90% 主动 refresh / 401 过期弹窗。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AuthRedirectError,
  DEFAULT_ADMIN_ORIGIN,
  FULL_SESSION_CHECK_INTERVAL_MS,
  ensureSession,
  startFullSessionMonitor,
  stopFullSessionMonitor,
} from '../../../src/full/bootstrap';
import {
  createMockSessionTransport,
  getSessionToken,
  setMockSessionTtl,
  setSessionToken,
  setSessionTransport,
  type SessionTransport,
} from '../../../src/shared/session-api';

function goto(search: string): void {
  window.history.replaceState({}, '', `/${search}`);
}

beforeEach(() => {
  setSessionTransport(createMockSessionTransport());
  setMockSessionTtl(null);
  setSessionToken(null);
  goto('');
});

afterEach(() => {
  stopFullSessionMonitor();
  document.querySelector('[data-testid="session-expired"]')?.remove();
  setSessionToken(null);
  setMockSessionTtl(null);
  goto('');
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('ensureSession（兑换落地）', () => {
  it('带 code：exchange 换 token 仅内存 + URL 清除 code + 监控启动', async () => {
    vi.useFakeTimers();
    goto('?code=e2e-code&extra=keep');
    await ensureSession();
    expect(getSessionToken()).toBeTruthy();
    expect(window.location.search).toBe(''); // code（与钩子参数）经 replaceState 清除
    expect(window.location.pathname).toBe('/');
    // 监控已启动：60s 周期 check（spy transport 断言路由）
    const check = vi.fn(async () => ({ valid: true, remainingTtlMs: 590_000 }));
    setSessionTransport({
      issueCode: vi.fn(),
      exchange: vi.fn(),
      refresh: vi.fn(),
      check,
    } as unknown as SessionTransport);
    vi.advanceTimersByTime(FULL_SESSION_CHECK_INTERVAL_MS);
    await Promise.resolve();
    expect(check).toHaveBeenCalledWith({ token: getSessionToken() });
    stopFullSessionMonitor();
  });

  it('无 code：降级期 no-op（不 redirect 不阻断；设计契约 回源登录挂账真实接线）', async () => {
    goto('?templateId=1');
    await expect(ensureSession()).resolves.toBeUndefined();
    expect(getSessionToken()).toBeNull();
    expect(window.location.search).toBe('?templateId=1'); // 无 code 不动 URL
    expect(document.querySelector('[data-testid="session-expired"]')).toBeNull();
  });

  it('兑换失败：弹窗引导回源 + AuthRedirectError 中断启动（/）', async () => {
    setSessionTransport({
      issueCode: vi.fn(),
      exchange: vi.fn(async () => {
        throw new Error('EXCHANGE_FAILED:401');
      }),
      refresh: vi.fn(),
      check: vi.fn(),
    } as unknown as SessionTransport);
    goto('?code=bad-code&adminOrigin=http://localhost:3000');
    await expect(ensureSession()).rejects.toBeInstanceOf(AuthRedirectError);
    expect(getSessionToken()).toBeNull();
    const overlay = document.querySelector('[data-testid="session-expired"]');
    expect(overlay?.textContent).toContain('会话兑换失败');
    // code 未清除（兑换失败 URL 保留现场便于排查）——与 设计契约 成功路径才 replaceState 一致
  });

  it('adminOrigin 缺省为中性占位域（集成方以 VITE_ADMIN_ORIGIN 注入真实后台）', () => {
    expect(DEFAULT_ADMIN_ORIGIN).toBe('https://admin.example.com');
  });
});

describe('full session 监控（60s check + 剩余 ≤10% 主动 refresh + 401 过期弹窗）', () => {
  function spyTransport(overrides: Partial<SessionTransport>): SessionTransport {
    return {
      issueCode: vi.fn(),
      exchange: vi.fn(),
      refresh: vi.fn(),
      check: vi.fn(async () => ({ valid: true, remainingTtlMs: 590_000 })),
      ...overrides,
    } as unknown as SessionTransport;
  }

  it('剩余 TTL 充足：仅 check 不 refresh', async () => {
    setSessionToken('full-token');
    const spy = spyTransport({});
    setSessionTransport(spy);
    const interval = { fn: null as (() => void) | null, clear: vi.fn() };
    startFullSessionMonitor({
      createInterval: (fn) => {
        interval.fn = fn;
        return { clear: interval.clear };
      },
    });
    interval.fn?.();
    await Promise.resolve();
    expect(spy.check).toHaveBeenCalledWith({ token: 'full-token' });
    expect(spy.refresh).not.toHaveBeenCalled();
    expect(document.querySelector('[data-testid="session-expired"]')).toBeNull();
  });

  it('剩余 ≤10%：直连 refresh 成功 → 内存 token 换新（TTL 重置）', async () => {
    setSessionToken('old-full-token');
    const spy = spyTransport({
      check: vi.fn(async () => ({ valid: true, remainingTtlMs: 30_000 })), // ≤ 600s × 10%
      refresh: vi.fn(async () => ({ token: 'new-full-token', expiresIn: 600 })),
    });
    setSessionTransport(spy);
    const interval = { fn: null as (() => void) | null };
    startFullSessionMonitor({
      createInterval: (fn) => {
        interval.fn = fn;
        return { clear: vi.fn() };
      },
    });
    interval.fn?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(spy.refresh).toHaveBeenCalledWith({ token: 'old-full-token' });
    expect(getSessionToken()).toBe('new-full-token');
    expect(document.querySelector('[data-testid="session-expired"]')).toBeNull();
  });

  it('check 401（valid:false）：过期弹窗 + token 清空 + 监控停止', async () => {
    setSessionToken('expired-full-token');
    const spy = spyTransport({ check: vi.fn(async () => ({ valid: false })) });
    setSessionTransport(spy);
    const clear = vi.fn();
    const interval = { fn: null as (() => void) | null };
    startFullSessionMonitor({
      createInterval: (fn) => {
        interval.fn = fn;
        return { clear };
      },
    });
    interval.fn?.();
    await Promise.resolve();
    expect(document.querySelector('[data-testid="session-expired"]')?.textContent).toContain(
      '会话已过期',
    );
    expect(getSessionToken()).toBeNull();
    expect(clear).toHaveBeenCalled(); // 过期后停表，不再周期 check
    (spy.check as ReturnType<typeof vi.fn>).mockClear();
    interval.fn?.(); // 即便再触发也不 check（句柄已清为 null 守卫）
    await Promise.resolve();
    expect(spy.check).not.toHaveBeenCalled();
  });

  it('refresh 失败：过期弹窗（续期失败文案）', async () => {
    setSessionToken('full-token');
    const spy = spyTransport({
      check: vi.fn(async () => ({ valid: true, remainingTtlMs: 10_000 })),
      refresh: vi.fn(async () => {
        throw new Error('REFRESH_FAILED');
      }),
    });
    setSessionTransport(spy);
    const interval = { fn: null as (() => void) | null };
    startFullSessionMonitor({
      createInterval: (fn) => {
        interval.fn = fn;
        return { clear: vi.fn() };
      },
    });
    interval.fn?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(document.querySelector('[data-testid="session-expired"]')?.textContent).toContain(
      '会话续期失败',
    );
  });

  it('无 token：tick 自停（守卫）', async () => {
    setSessionToken(null);
    const spy = spyTransport({});
    setSessionTransport(spy);
    const clear = vi.fn();
    const interval = { fn: null as (() => void) | null };
    startFullSessionMonitor({
      createInterval: (fn) => {
        interval.fn = fn;
        return { clear };
      },
    });
    interval.fn?.();
    await Promise.resolve();
    expect(spy.check).not.toHaveBeenCalled();
    expect(clear).toHaveBeenCalled();
  });

  it('与 mock transport 全链：兑换 → 缩短 TTL → 周期 check 过期弹窗（fake timers）', async () => {
    vi.useFakeTimers();
    setMockSessionTtl(1_000);
    goto('?code=chain-code');
    await ensureSession();
    expect(getSessionToken()).toBeTruthy();
    vi.advanceTimersByTime(FULL_SESSION_CHECK_INTERVAL_MS); // 第 1 次 check：已过期（TTL 1s）
    await Promise.resolve();
    await Promise.resolve();
    expect(document.querySelector('[data-testid="session-expired"]')).not.toBeNull();
    stopFullSessionMonitor();
  });
});
