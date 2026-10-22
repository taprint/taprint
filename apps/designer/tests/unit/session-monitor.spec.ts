// SPDX-License-Identifier: Apache-2.0
// embed token 主动监控 caller 单测（设计契约口径）：
// 60s check 周期 / 剩余 TTL ≤10% 主动 refresh / 401 过期事件 / transport 注入切换 /
// 本地（host-bridge 委托）与远程（session-api 直连）双路径 / 防重入与停止语义。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TOKEN_CHECK_INTERVAL_MS,
  TOKEN_TTL_EXPIRY_THRESHOLD,
  TOKEN_TTL_MS_DEFAULT,
  getTokenMonitorOptions,
  isLocalEmbedDefault,
  markTokenRefreshed,
  resetTokenMonitor,
  setLocalCheckHook,
  startTokenExpiryWatch,
  stopTokenExpiryWatch,
  type TokenMonitorHandle,
} from '../../src/embed/session-monitor';
import {
  createMockSessionTransport,
  sessionApi,
  setMockSessionTtl,
  setSessionTransport,
  type SessionTransport,
} from '../../src/shared/session-api';

const ORIGIN = 'http://localhost:3000';

/** 注入式计时器：捕获 tick 回调，测试手动触发（不真等 60s） */
function captureInterval() {
  let tick: (() => void) | null = null;
  const clear = vi.fn();
  const createInterval = vi.fn((fn: () => void, _ms: number): TokenMonitorHandle => {
    tick = fn;
    return { clear };
  });
  return {
    createInterval,
    clear,
    fire: async () => {
      tick?.();
      await Promise.resolve(); // flush 远程路径微任务
      await Promise.resolve();
    },
  };
}

async function issueToken(ttlMs: number): Promise<string> {
  setMockSessionTtl(ttlMs);
  const { code } = await sessionApi.issueCode({ userId: 'u1', origin: ORIGIN });
  const { token } = await sessionApi.exchange({ code, origin: ORIGIN });
  return token;
}

beforeEach(() => {
  setSessionTransport(createMockSessionTransport());
  setMockSessionTtl(null);
  delete window.__TAPRINT_TOKEN__;
  setLocalCheckHook(() => {});
});

afterEach(() => {
  resetTokenMonitor();
  setMockSessionTtl(null);
  delete window.__TAPRINT_TOKEN__;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('常量与启发式', () => {
  it('口径常量：周期 60s / TTL 10min / 阈值 0.9（+ ）', () => {
    expect(TOKEN_CHECK_INTERVAL_MS).toBe(60_000);
    expect(TOKEN_TTL_MS_DEFAULT).toBe(600_000);
    expect(TOKEN_TTL_EXPIRY_THRESHOLD).toBe(0.9);
  });

  it('isLocalEmbedDefault：jsdom http://localhost:3000 判定为本地 embed', () => {
    expect(isLocalEmbedDefault()).toBe(true);
  });
});

describe('本地路径（WPF/Flutter localhost：token-check 委托宿主 + TTL 90% 兜底）', () => {
  it('每周期经 localCheckHook 上行 token-check（host-bridge 通道由 sdk-core 装配）', async () => {
    const hook = vi.fn();
    setLocalCheckHook(hook);
    const interval = captureInterval();
    startTokenExpiryWatch({ localEmbed: true, createInterval: interval.createInterval });
    await interval.fire();
    await interval.fire();
    expect(hook).toHaveBeenCalledTimes(2);
  });

  it('TTL 90% 兜底：elapsed ≥ 阈值 → onTokenExpired；markTokenRefreshed 复位基准', async () => {
    vi.useFakeTimers();
    const onTokenExpired = vi.fn();
    const interval = captureInterval();
    startTokenExpiryWatch({
      localEmbed: true,
      tokenTtlMs: 100,
      ttlThreshold: 0.9,
      createInterval: interval.createInterval,
      onTokenExpired,
    });
    vi.advanceTimersByTime(95);
    await interval.fire();
    expect(onTokenExpired).toHaveBeenCalledTimes(1);
    expect(onTokenExpired.mock.calls[0][0]).toContain('90%');

    // 复位基准后同口径不再触发
    onTokenExpired.mockClear();
    markTokenRefreshed();
    vi.advanceTimersByTime(50);
    await interval.fire();
    expect(onTokenExpired).not.toHaveBeenCalled();
  });
});

describe('远程路径（session-api 直连 GET /session/check，默认 mock transport）', () => {
  it('默认 60s 周期：createInterval 收到 TOKEN_CHECK_INTERVAL_MS', () => {
    const interval = captureInterval();
    startTokenExpiryWatch({ localEmbed: false, createInterval: interval.createInterval });
    expect(interval.createInterval).toHaveBeenCalledWith(
      expect.any(Function),
      TOKEN_CHECK_INTERVAL_MS,
    );
    expect(getTokenMonitorOptions()?.checkIntervalMs).toBe(TOKEN_CHECK_INTERVAL_MS);
  });

  it('check 200 且剩余 TTL 充足：不触发过期也不 refresh', async () => {
    vi.useFakeTimers();
    window.__TAPRINT_TOKEN__ = await issueToken(10_000);
    const onTokenExpired = vi.fn();
    const interval = captureInterval();
    startTokenExpiryWatch({
      localEmbed: false,
      createInterval: interval.createInterval,
      onTokenExpired,
    });
    vi.advanceTimersByTime(1_000); // 剩余 9s ≫ 10% 阈值（1s）
    await interval.fire();
    expect(onTokenExpired).not.toHaveBeenCalled();
    expect(window.__TAPRINT_TOKEN__).toBeTruthy();
  });

  it('check 401（token 已过期）→ onTokenExpired 走既有 token-expired 链路', async () => {
    vi.useFakeTimers();
    window.__TAPRINT_TOKEN__ = await issueToken(1_000);
    vi.advanceTimersByTime(1_001); // mock TTL 到期 → check valid:false
    const onTokenExpired = vi.fn();
    const interval = captureInterval();
    startTokenExpiryWatch({
      localEmbed: false,
      createInterval: interval.createInterval,
      onTokenExpired,
    });
    await interval.fire();
    expect(onTokenExpired).toHaveBeenCalledTimes(1);
    expect(onTokenExpired.mock.calls[0][0]).toContain('401');
  });

  it('剩余 TTL ≤10% → 主动 refresh：新 token 经 onTokenRefreshed 回写 + TTL 基准重置', async () => {
    vi.useFakeTimers();
    const oldToken = await issueToken(1_000); // 阈值 = 100ms
    window.__TAPRINT_TOKEN__ = oldToken;
    vi.advanceTimersByTime(950); // 剩余 50ms ≤ 100ms
    const onTokenExpired = vi.fn();
    const onTokenRefreshed = vi.fn();
    const interval = captureInterval();
    startTokenExpiryWatch({
      localEmbed: false,
      createInterval: interval.createInterval,
      onTokenExpired,
      onTokenRefreshed,
    });
    await interval.fire();
    expect(onTokenRefreshed).toHaveBeenCalledTimes(1);
    const newToken = onTokenRefreshed.mock.calls[0][0] as string;
    expect(newToken).not.toBe(oldToken);
    expect(onTokenExpired).not.toHaveBeenCalled();
    // 旧 token 已作废、新 token 有效（refresh 语义）
    expect(await sessionApi.check({ token: oldToken })).toEqual({ valid: false });
    expect((await sessionApi.check({ token: newToken })).valid).toBe(true);
  });

  it('refresh 失败 → 回落 onTokenExpired（交宿主兜底刷新）', async () => {
    vi.useFakeTimers();
    window.__TAPRINT_TOKEN__ = await issueToken(1_000);
    vi.advanceTimersByTime(950);
    // 注入 spy transport：check 有效但临近阈值，refresh 拒绝
    const spy: SessionTransport = {
      issueCode: vi.fn(),
      exchange: vi.fn(),
      refresh: vi.fn(async () => {
        throw new Error('backend offline');
      }),
      check: vi.fn(async () => ({ valid: true, remainingTtlMs: 50 })),
    };
    setSessionTransport(spy);
    const onTokenExpired = vi.fn();
    const interval = captureInterval();
    startTokenExpiryWatch({
      localEmbed: false,
      createInterval: interval.createInterval,
      onTokenExpired,
    });
    await interval.fire();
    await Promise.resolve();
    expect(onTokenExpired).toHaveBeenCalledTimes(1);
    expect(onTokenExpired.mock.calls[0][0]).toContain('refresh');
  });

  it('check 未回带剩余 TTL：回退客户端 elapsed 启发式（同 90% 阈值语义）', async () => {
    vi.useFakeTimers();
    window.__TAPRINT_TOKEN__ = 'opaque-token';
    const spy: SessionTransport = {
      issueCode: vi.fn(),
      exchange: vi.fn(),
      refresh: vi.fn(),
      check: vi.fn(async () => ({ valid: true })), // 无 remainingTtlMs
    };
    setSessionTransport(spy);
    const onTokenExpired = vi.fn();
    const interval = captureInterval();
    startTokenExpiryWatch({
      localEmbed: false,
      tokenTtlMs: 100,
      createInterval: interval.createInterval,
      onTokenExpired,
    });
    vi.advanceTimersByTime(95); // elapsed 95 → remaining 推断 5 ≤ 10% × 100
    await interval.fire();
    // 剩余 ≤10% → 尝试主动 refresh（spy refresh 返回 undefined 会抛 → onTokenExpired）
    expect(onTokenExpired).toHaveBeenCalledTimes(1);
  });

  it('transport 注入切换：check 路由到当前注入 transport（spy 断言）', async () => {
    window.__TAPRINT_TOKEN__ = 'spy-route-token';
    const check = vi.fn(async () => ({ valid: true, remainingTtlMs: 99_999 }));
    setSessionTransport({
      issueCode: vi.fn(),
      exchange: vi.fn(),
      refresh: vi.fn(),
      check,
    } as unknown as SessionTransport);
    const interval = captureInterval();
    startTokenExpiryWatch({ localEmbed: false, createInterval: interval.createInterval });
    await interval.fire();
    expect(check).toHaveBeenCalledWith({ token: 'spy-route-token' });
  });

  it('网络异常：不触发过期、不抛（等下次周期，catch 口径）', async () => {
    window.__TAPRINT_TOKEN__ = 'any-token';
    setSessionTransport({
      issueCode: vi.fn(),
      exchange: vi.fn(),
      refresh: vi.fn(),
      check: vi.fn(async () => {
        throw new Error('network down');
      }),
    } as unknown as SessionTransport);
    const onTokenExpired = vi.fn();
    const interval = captureInterval();
    startTokenExpiryWatch({
      localEmbed: false,
      createInterval: interval.createInterval,
      onTokenExpired,
    });
    await expect(interval.fire()).resolves.toBeUndefined();
    expect(onTokenExpired).not.toHaveBeenCalled();
  });

  it('无 token：tick no-op（不调 check）', async () => {
    const check = vi.fn();
    setSessionTransport({
      issueCode: vi.fn(),
      exchange: vi.fn(),
      refresh: vi.fn(),
      check,
    } as unknown as SessionTransport);
    const interval = captureInterval();
    startTokenExpiryWatch({ localEmbed: false, createInterval: interval.createInterval });
    await interval.fire();
    expect(check).not.toHaveBeenCalled();
  });

  it('防重入：check 未决时下一周期跳过（避免叠加请求）', async () => {
    window.__TAPRINT_TOKEN__ = 'busy-token';
    const pending: { resolve: ((v: { valid: boolean }) => void) | null } = { resolve: null };
    const check = vi.fn(
      () =>
        new Promise<{ valid: boolean }>((resolve) => {
          pending.resolve = resolve;
        }),
    );
    setSessionTransport({
      issueCode: vi.fn(),
      exchange: vi.fn(),
      refresh: vi.fn(),
      check,
    } as unknown as SessionTransport);
    const interval = captureInterval();
    startTokenExpiryWatch({ localEmbed: false, createInterval: interval.createInterval });
    await interval.fire(); // 第 1 次 tick：check 挂起
    await interval.fire(); // 第 2 次 tick：应跳过
    expect(check).toHaveBeenCalledTimes(1);
    pending.resolve?.({ valid: true });
    await Promise.resolve();
    await interval.fire(); // 已决：恢复执行
    expect(check).toHaveBeenCalledTimes(2);
  });
});

describe('生命周期', () => {
  it('stopTokenExpiryWatch：clear 计时器句柄', () => {
    const interval = captureInterval();
    startTokenExpiryWatch({ localEmbed: false, createInterval: interval.createInterval });
    stopTokenExpiryWatch();
    expect(interval.clear).toHaveBeenCalledTimes(1);
  });

  it('重启语义：旧句柄先 clear 再建新（避免双计时器叠加）', () => {
    const a = captureInterval();
    const b = captureInterval();
    startTokenExpiryWatch({ localEmbed: false, createInterval: a.createInterval });
    startTokenExpiryWatch({ localEmbed: false, createInterval: b.createInterval });
    expect(a.clear).toHaveBeenCalledTimes(1);
    expect(b.clear).not.toHaveBeenCalled();
  });

  it('resetTokenMonitor：卸除全部状态（destroyEmbed 纪律）', () => {
    const interval = captureInterval();
    startTokenExpiryWatch({ localEmbed: false, createInterval: interval.createInterval });
    resetTokenMonitor();
    expect(interval.clear).toHaveBeenCalled();
    expect(getTokenMonitorOptions()).toBeNull();
  });
});
