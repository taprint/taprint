// SPDX-License-Identifier: Apache-2.0
// session fetch transport 模板 API 契约 对齐单测（真实接线）：
// R 信封 {code,message,result} 解包 / 结构化错误 errorCode 类型化（0607001-0607003）/
// check 422+0607003 = 401 同语义 / baseUrl 前缀拼接 / issue_code 平台 token Bearer /
// transport 切换工厂（VITE_SESSION_API_BASE 有值 → fetch，缺省 → mock）。
// 全程注入 fetch mock，不真连后端。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SESSION_BACKEND_ERROR_CODES,
  SESSION_CHECK_ENDPOINT,
  SESSION_ENDPOINT,
  SessionApiError,
  createFetchSessionTransport,
  createMockSessionTransport,
  getSessionTransport,
  sessionApi,
  setSessionTransport,
} from '../../src/shared/session-api';
import { initSessionTransport } from '../../src/full/bootstrap';
import { API_BASE_ENV_KEY, resolveApiBase } from '../../src/shared/env';

const BASE = 'http://localhost:8866';
const ORIGIN = 'http://localhost:3000';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** 后端 R 信封成功体 */
const okEnvelope = (result: unknown): unknown => ({ code: 0, message: 'success', result });
/** 后端结构化错误体（GlobalExceptionHandler.structured） */
const errEnvelope = (errorCode: string, message: string): unknown => ({
  code: 422,
  httpStatus: 422,
  errorCode,
  message,
  traceId: 't-1',
});

beforeEach(() => {
  setSessionTransport(createMockSessionTransport());
});
afterEach(() => {
  setSessionTransport(createMockSessionTransport());
  vi.unstubAllGlobals();
});

describe('fetch transport 模板 API 契约 协议形态（R 信封 + action 分流）', () => {
  it('issue/exchange/refresh 走 POST 单端点；成功体解包 result（{code:0,result:{...}}）', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const body = JSON.parse(String(init.body)) as { action: string };
      if (body.action === 'issue_code') {
        return jsonResponse(okEnvelope({ code: 'c1', expiresIn: 60 }));
      }
      if (body.action === 'exchange') {
        return jsonResponse(okEnvelope({ token: 't1', expiresIn: 600 }));
      }
      return jsonResponse(okEnvelope({ token: 't2', expiresIn: 600 }));
    });
    const transport = createFetchSessionTransport({
      baseUrl: BASE,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(await transport.issueCode({ userId: 'u1', origin: ORIGIN })).toEqual({
      code: 'c1',
      expiresIn: 60,
    });
    expect(await transport.exchange({ code: 'c1', origin: ORIGIN })).toEqual({
      token: 't1',
      expiresIn: 600,
    });
    expect(await transport.refresh({ token: 't1' })).toEqual({ token: 't2', expiresIn: 600 });

    expect(calls).toHaveLength(3);
    for (const c of calls) {
      expect(c.url).toBe(`${BASE}${SESSION_ENDPOINT}`); // /admin 契约路径 + baseUrl 前缀
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

  it('check 走 GET /check + Bearer；200 {result:"valid"} → valid:true（token 绝不进 URL）', async () => {
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe(`${BASE}${SESSION_CHECK_ENDPOINT}`);
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer t1');
      return jsonResponse(okEnvelope('valid'));
    });
    const transport = createFetchSessionTransport({
      baseUrl: BASE,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(await transport.check({ token: 't1' })).toEqual({ valid: true });
  });

  it('baseUrl 缺省 = 同源相对路径（部署反代口径）', async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      urls.push(url);
      return jsonResponse(okEnvelope('valid'));
    });
    const transport = createFetchSessionTransport({
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await transport.check({ token: 'x' });
    expect(urls[0]).toBe(SESSION_CHECK_ENDPOINT);
  });

  it('issue_code 附平台 token Bearer（getAuthToken）；exchange/refresh 不附鉴权头', async () => {
    const headers: Array<Record<string, string>> = [];
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      headers.push(init.headers as Record<string, string>);
      const body = JSON.parse(String(init.body)) as { action: string };
      if (body.action === 'issue_code') {
        return jsonResponse(okEnvelope({ code: 'c1', expiresIn: 60 }));
      }
      return jsonResponse(okEnvelope({ token: 't1', expiresIn: 600 }));
    });
    const transport = createFetchSessionTransport({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      getAuthToken: () => 'platform-token',
    });
    await transport.issueCode({ userId: 'u1', origin: ORIGIN });
    await transport.exchange({ code: 'c1', origin: ORIGIN });
    expect(headers[0].Authorization).toBe('Bearer platform-token');
    expect(headers[1].Authorization).toBeUndefined();
  });
});

describe('fetch transport 模板 API 契约 错误码类型化（0607001/0607002/0607003）', () => {
  async function failing(errorCode: string, status = 422): Promise<SessionApiError> {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(errEnvelope(errorCode, `msg-${errorCode}`), status),
    );
    const transport = createFetchSessionTransport({
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    try {
      await transport.exchange({ code: 'c', origin: ORIGIN });
      throw new Error('应当抛错');
    } catch (e) {
      return e as SessionApiError;
    }
  }

  it('0607001 → SESSION_CODE_INVALID（code 无效/已用）', async () => {
    const e = await failing('0607001');
    expect(e).toBeInstanceOf(SessionApiError);
    expect(e.code).toBe(SESSION_BACKEND_ERROR_CODES['0607001']);
    expect(e.status).toBe(422);
    expect(e.message).toContain('SESSION_CODE_INVALID');
  });

  it('0607002 → SESSION_ORIGIN_MISMATCH（origin 不匹配）', async () => {
    const e = await failing('0607002');
    expect(e.code).toBe(SESSION_BACKEND_ERROR_CODES['0607002']);
    expect(e.status).toBe(422);
  });

  it('0607003 → SESSION_TOKEN_INVALID（refresh 场景旧 token 作废）', async () => {
    const e = await failing('0607003');
    expect(e.code).toBe(SESSION_BACKEND_ERROR_CODES['0607003']);
  });

  it('未知 errorCode / 无错误体：保持 status 透传（不带类型化 code）', async () => {
    const e = await failing('9999999');
    expect(e.code).toBeUndefined();
    expect(e.status).toBe(422);
  });

  it('check：422 + 0607003 → valid:false（契约 = 401 同语义）；其他非 2xx → 抛错', async () => {
    const t603 = createFetchSessionTransport({
      fetchImpl: (async () =>
        jsonResponse(errEnvelope('0607003', 'token 无效'), 422)) as unknown as typeof fetch,
    });
    expect(await t603.check({ token: 'x' })).toEqual({ valid: false });

    const t500 = createFetchSessionTransport({
      fetchImpl: (async () =>
        jsonResponse({ code: 500, message: '内部错误' }, 500)) as unknown as typeof fetch,
    });
    await expect(t500.check({ token: 'x' })).rejects.toThrow(/SESSION_CHECK_FAILED:500/);
  });

  it('老式 R.error（200 + {code:500}，无 result）按错误处置', async () => {
    const transport = createFetchSessionTransport({
      fetchImpl: (async () =>
        jsonResponse({ code: 500, message: 'id 不能为空' })) as unknown as typeof fetch,
    });
    await expect(transport.exchange({ code: 'c', origin: ORIGIN })).rejects.toMatchObject({
      status: 500,
    });
  });

  it('网络失败（fetch 拒绝）→ SessionApiError（无 status）', async () => {
    const transport = createFetchSessionTransport({
      fetchImpl: (async () => {
        throw new TypeError('Failed to fetch');
      }) as unknown as typeof fetch,
    });
    await expect(transport.exchange({ code: 'c', origin: ORIGIN })).rejects.toThrow(
      /SESSION_REQUEST_FAILED:network/,
    );
    await expect(transport.check({ token: 'x' })).rejects.toThrow(/SESSION_CHECK_FAILED:network/);
  });
});

describe('session transport 切换工厂（initSessionTransport，模板 API 契约/C4）', () => {
  it('apiBase 有值 → fetch transport：sessionApi 全量路由真实 fetch（baseUrl 前缀）', async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        urls.push(String(url));
        return jsonResponse(okEnvelope('valid'));
      }),
    );
    expect(initSessionTransport(BASE)).toBe('fetch');
    await sessionApi.check({ token: 'real-token' });
    expect(urls).toEqual([`${BASE}${SESSION_CHECK_ENDPOINT}`]);
  });

  it('apiBase 缺省 → mock：不改动当前 transport（既有降级语义）', () => {
    const current = createMockSessionTransport();
    setSessionTransport(current);
    expect(initSessionTransport(null)).toBe('mock');
    expect(initSessionTransport('')).toBe('mock');
    // transport 未被替换（引用同一实例，mock 缺省语义不变）
    expect(getSessionTransport()).toBe(current);
  });
});

describe('resolveApiBase（env 读取归一）', () => {
  it('有值 → 原样（尾斜杠剥除）；空串/空白/缺失 → null', () => {
    expect(resolveApiBase({ [API_BASE_ENV_KEY]: 'http://localhost:8866' })).toBe(
      'http://localhost:8866',
    );
    expect(resolveApiBase({ [API_BASE_ENV_KEY]: 'http://localhost:8866/' })).toBe(
      'http://localhost:8866',
    );
    expect(resolveApiBase({ [API_BASE_ENV_KEY]: '' })).toBeNull();
    expect(resolveApiBase({ [API_BASE_ENV_KEY]: ' ' })).toBeNull();
    expect(resolveApiBase({})).toBeNull();
    expect(resolveApiBase(undefined)).toBeNull();
  });

  it('缺省读 import.meta.env（vitest 注入 VITE_* 生效）', () => {
    vi.stubEnv(API_BASE_ENV_KEY, 'http://env-base.test');
    expect(resolveApiBase()).toBe('http://env-base.test');
    vi.unstubAllEnvs();
    expect(resolveApiBase()).toBeNull();
  });
});
