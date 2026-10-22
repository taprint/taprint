// SPDX-License-Identifier: Apache-2.0
// session HTTP 层接口化单测：
// 端点常量锁定 / mock transport 内存 TTL 仿真语义 / fetch transport 协议形态 /
// transport 注入切换 / 内存 token 持有（不落 storage）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SESSION_CHECK_ENDPOINT,
  SESSION_CODE_TTL_MS,
  SESSION_ENDPOINT,
  SESSION_REFRESH_TTL_FRACTION,
  SESSION_TOKEN_TTL_MS,
  SessionApiError,
  createFetchSessionTransport,
  createMockSessionTransport,
  createTokenWatch,
  defaultCreateInterval,
  getSessionToken,
  getSessionTransport,
  sessionApi,
  setMockSessionTtl,
  setSessionToken,
  setSessionTransport,
  type SessionTransport,
} from '../../src/shared/session-api';

const ORIGIN = 'http://localhost:3000';

beforeEach(() => {
  setSessionTransport(createMockSessionTransport());
  setMockSessionTtl(null);
  setSessionToken(null);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('端点常量（模板 API 契约 锁定；/admin = 后端 context-path）', () => {
  it('单端点 + check 端点 / TTL / 阈值常量逐字对齐契约', () => {
    expect(SESSION_ENDPOINT).toBe('/admin/print/designer/session');
    expect(SESSION_CHECK_ENDPOINT).toBe('/admin/print/designer/session/check');
    expect(SESSION_TOKEN_TTL_MS).toBe(600_000); // expiresIn: 600
    expect(SESSION_CODE_TTL_MS).toBe(60_000); // expiresIn: 60
    expect(SESSION_REFRESH_TTL_FRACTION).toBe(0.3); // 剩余 ≤30% 主动 refresh（60s check 周期下 10% 窗口有 tick 竞态，已放宽）
  });
});

describe('mock transport（默认降级口径：内存 TTL 仿真）', () => {
  it('issue_code → exchange 往返：code 60s / token 600s TTL 口径', async () => {
    const { code, expiresIn } = await sessionApi.issueCode({ userId: 'u1', origin: ORIGIN });
    expect(expiresIn).toBe(60);
    const { token, expiresIn: tokenTtl } = await sessionApi.exchange({ code, origin: ORIGIN });
    expect(token).toBeTruthy();
    expect(tokenTtl).toBe(600);
  });

  it('code 一次性使用：二次 exchange 拒绝（防第三方盗用）', async () => {
    const { code } = await sessionApi.issueCode({ userId: 'u1', origin: ORIGIN });
    await sessionApi.exchange({ code, origin: ORIGIN });
    await expect(sessionApi.exchange({ code, origin: ORIGIN })).rejects.toThrow(SessionApiError);
  });

  it('code 绑定 origin：兑换方 origin 不符拒绝', async () => {
    const { code } = await sessionApi.issueCode({ userId: 'u1', origin: ORIGIN });
    await expect(sessionApi.exchange({ code, origin: 'https://evil.test' })).rejects.toThrow(
      /origin/,
    );
  });

  it('code 60s TTL：过期后 exchange 拒绝（fake timers）', async () => {
    vi.useFakeTimers();
    const { code } = await sessionApi.issueCode({ userId: 'u1', origin: ORIGIN });
    vi.advanceTimersByTime(SESSION_CODE_TTL_MS + 1);
    await expect(sessionApi.exchange({ code, origin: ORIGIN })).rejects.toThrow(/过期/);
  });

  it('check 有效返回剩余 TTL；refresh 旧 token 作废 + TTL 重置', async () => {
    vi.useFakeTimers();
    const { code } = await sessionApi.issueCode({ userId: 'u1', origin: ORIGIN });
    const { token } = await sessionApi.exchange({ code, origin: ORIGIN });

    vi.advanceTimersByTime(100_000);
    const checked = await sessionApi.check({ token });
    expect(checked.valid).toBe(true);
    expect(checked.remainingTtlMs).toBe(SESSION_TOKEN_TTL_MS - 100_000);

    const { token: next } = await sessionApi.refresh({ token });
    expect(next).not.toBe(token);
    // 旧 token 作废
    expect(await sessionApi.check({ token })).toEqual({ valid: false });
    // 新 token TTL 重置
    const after = await sessionApi.check({ token: next });
    expect(after.valid).toBe(true);
    expect(after.remainingTtlMs).toBe(SESSION_TOKEN_TTL_MS);
  });

  it('token 过期：check 返回 401 语义（valid:false）；过期 token refresh 拒绝', async () => {
    vi.useFakeTimers();
    const { code } = await sessionApi.issueCode({ userId: 'u1', origin: ORIGIN });
    const { token } = await sessionApi.exchange({ code, origin: ORIGIN });
    vi.advanceTimersByTime(SESSION_TOKEN_TTL_MS + 1);
    expect(await sessionApi.check({ token })).toEqual({ valid: false });
    await expect(sessionApi.refresh({ token })).rejects.toThrow(SessionApiError);
  });

  it('未知 token：check valid:false（不抛）', async () => {
    expect(await sessionApi.check({ token: 'unknown-token' })).toEqual({ valid: false });
  });

  it('setMockSessionTtl 缩短 TTL（e2e/单测加速钩子；null 恢复生产值）', async () => {
    vi.useFakeTimers();
    setMockSessionTtl(1_000);
    const { code } = await sessionApi.issueCode({ userId: 'u1', origin: ORIGIN });
    const { token, expiresIn } = await sessionApi.exchange({ code, origin: ORIGIN });
    expect(expiresIn).toBe(1);
    vi.advanceTimersByTime(1_001);
    expect(await sessionApi.check({ token })).toEqual({ valid: false });
    setMockSessionTtl(null);
  });
});

describe('fetch transport（裸负载协议形态兼容口径；模板 API 契约 信封/错误码见 session-fetch-wiring.spec）', () => {
  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  it('issue_code/exchange/refresh 走 POST 单端点 action 分流；token 仅入 body 不进 URL', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const body = JSON.parse(String(init.body)) as { action: string };
      if (body.action === 'issue_code') return jsonResponse({ code: 'c1', expiresIn: 60 });
      if (body.action === 'exchange') return jsonResponse({ token: 't1', expiresIn: 600 });
      return jsonResponse({ token: 't2', expiresIn: 600 });
    });
    const transport = createFetchSessionTransport(fetchImpl as unknown as typeof fetch);

    await transport.issueCode({ userId: 'u1', origin: ORIGIN });
    await transport.exchange({ code: 'c1', origin: ORIGIN });
    await transport.refresh({ token: 't1' });

    expect(calls).toHaveLength(3);
    for (const c of calls) {
      expect(c.url).toBe(SESSION_ENDPOINT); // URL 恒定——token/code 只在 body
      expect(c.init.method).toBe('POST');
    }
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      action: 'issue_code',
      userId: 'u1',
      origin: ORIGIN,
    });
    expect(JSON.parse(String(calls[1].init.body))).toEqual({
      action: 'exchange',
      code: 'c1',
      origin: ORIGIN,
    });
    expect(JSON.parse(String(calls[2].init.body))).toEqual({ action: 'refresh', token: 't1' });
  });

  it('check 走 GET /session/check + Authorization: Bearer（token 绝不进 URL）', async () => {
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe(SESSION_CHECK_ENDPOINT);
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer t1');
      return jsonResponse({ remainingTtlMs: 123_000 });
    });
    const transport = createFetchSessionTransport(fetchImpl as unknown as typeof fetch);
    expect(await transport.check({ token: 't1' })).toEqual({
      valid: true,
      remainingTtlMs: 123_000,
    });
  });

  it('check 401 → valid:false；非 200/401 → SessionApiError', async () => {
    const t401 = createFetchSessionTransport(
      (async () => new Response(null, { status: 401 })) as unknown as typeof fetch,
    );
    expect(await t401.check({ token: 'x' })).toEqual({ valid: false });

    const t500 = createFetchSessionTransport(
      (async () => new Response(null, { status: 500 })) as unknown as typeof fetch,
    );
    await expect(t500.check({ token: 'x' })).rejects.toThrow(/SESSION_CHECK_FAILED:500/);
  });

  it('POST 非 2xx → SessionApiError 带 status', async () => {
    const t = createFetchSessionTransport(
      (async () => new Response(null, { status: 403 })) as unknown as typeof fetch,
    );
    await expect(t.exchange({ code: 'c', origin: ORIGIN })).rejects.toMatchObject({
      status: 403,
    });
  });
});

describe('transport 注入切换（降级口径核心）', () => {
  it('默认 mock；setSessionTransport 切换后 sessionApi 全量路由新 transport', async () => {
    expect(getSessionTransport()).toBeTruthy();
    const spy: SessionTransport = {
      issueCode: vi.fn(async () => ({ code: 'spy-code', expiresIn: 60 })),
      exchange: vi.fn(async () => ({ token: 'spy-token', expiresIn: 600 })),
      refresh: vi.fn(async () => ({ token: 'spy-next', expiresIn: 600 })),
      check: vi.fn(async () => ({ valid: true, remainingTtlMs: 1 })),
    };
    setSessionTransport(spy);
    expect(getSessionTransport()).toBe(spy);

    await sessionApi.issueCode({ userId: 'u', origin: ORIGIN });
    await sessionApi.exchange({ code: 'c', origin: ORIGIN });
    await sessionApi.refresh({ token: 't' });
    await sessionApi.check({ token: 't' });
    expect(spy.issueCode).toHaveBeenCalledTimes(1);
    expect(spy.exchange).toHaveBeenCalledTimes(1);
    expect(spy.refresh).toHaveBeenCalledTimes(1);
    expect(spy.check).toHaveBeenCalledTimes(1);
  });
});

describe('内存 token 持有（不落 storage）', () => {
  it('setSessionToken/getSessionToken 往返；默认 null', () => {
    expect(getSessionToken()).toBeNull();
    setSessionToken('mem-token');
    expect(getSessionToken()).toBe('mem-token');
    setSessionToken(null);
    expect(getSessionToken()).toBeNull();
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });
});

describe('createTokenWatch（监控周期计时器工厂）', () => {
  it('默认工厂走 setInterval；clear() 即停（fake timers）', () => {
    vi.useFakeTimers();
    const tick = vi.fn();
    const handle = createTokenWatch(tick, 60_000, defaultCreateInterval);
    vi.advanceTimersByTime(60_000);
    expect(tick).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60_000);
    expect(tick).toHaveBeenCalledTimes(2);
    handle.clear();
    vi.advanceTimersByTime(600_000);
    expect(tick).toHaveBeenCalledTimes(2);
  });

  it('计时器可注入：自定义 createInterval 接管触发', () => {
    const tick = vi.fn();
    const holder: { fn: (() => void) | null } = { fn: null };
    const clear = vi.fn();
    const handle = createTokenWatch(tick, 123, (fn, ms) => {
      holder.fn = fn;
      expect(ms).toBe(123);
      return { clear };
    });
    holder.fn?.();
    expect(tick).toHaveBeenCalledTimes(1);
    handle.clear();
    expect(clear).toHaveBeenCalled();
  });
});
