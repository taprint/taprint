// SPDX-License-Identifier: Apache-2.0
// session HTTP 层接口化（设计契约）。
//
// 后端已实装（模板 API 契约）：
// fetch transport 逐字对齐契约（R 信封 {code,message,result} / 结构化错误 errorCode /
// 0607001-0607003 类型化），由 full 模式 bootstrap 按环境变量 VITE_SESSION_API_BASE
// 注入启用（shared/env.ts）；缺省保持 mock transport（内存 TTL 仿真，测试/离线语义不变）。
//
// 端点（模板 API 契约 锁定；/admin 前缀来自后端 context-path）：
// - POST /admin/print/designer/session body.action ∈ {issue_code, exchange, refresh}
// - GET /admin/print/designer/session/check（Authorization: Bearer <token>）
// 安全约束：token 绝不进 URL——exchange/refresh 走 POST body，check 走
// Authorization 头；token 仅内存持有（getSessionToken/setSessionToken），不落 storage。

// ── 端点常量（模板 API 契约 锁定，真实接线不得漂移）──────────────────
export const SESSION_ENDPOINT = '/admin/print/designer/session';
export const SESSION_CHECK_ENDPOINT = '/admin/print/designer/session/check';

/** 会话 token TTL：600s（expiresIn: 600；与 TOKEN_TTL_MS_DEFAULT 同值） */
export const SESSION_TOKEN_TTL_MS = 600_000;
/** 一次性 code TTL：60s（expiresIn: 60） */
export const SESSION_CODE_TTL_MS = 60_000;
/** 剩余 TTL ≤30%（即 70% 已过）时主动 refresh（2026-10-12 由 0.1 放宽：60s check
 * 周期 vs 10% 窗口=60s 存在 tick 竞态——边界错过一次即过期被踢；30%=180s 窗口必覆盖）。 */
export const SESSION_REFRESH_TTL_FRACTION = 0.3;

/**
 * 后端 session 域错误码（模板 API 契约的结构化 PrintErrorCode）→ 类型化错误码。
 * - 0607001 SESSION_CODE_INVALID：一次性 code 无效或已使用（含 issue_code 缺登录态）
 * - 0607002 SESSION_ORIGIN_MISMATCH：兑换方 origin 与 code 绑定不一致
 * - 0607003 SESSION_TOKEN_INVALID：会话 token 无效或已过期（check 422 语义）
 */
export const SESSION_BACKEND_ERROR_CODES = {
  '0607001': 'SESSION_CODE_INVALID',
  '0607002': 'SESSION_ORIGIN_MISMATCH',
  '0607003': 'SESSION_TOKEN_INVALID',
} as const;
export type SessionErrorCode =
  (typeof SESSION_BACKEND_ERROR_CODES)[keyof typeof SESSION_BACKEND_ERROR_CODES];

/** 后端 errorCode → 类型化错误码安全查找（未知码返回 undefined；避免 string 直接索引字面量表） */
export function typedSessionErrorCode(
  backendCode: string | undefined,
): SessionErrorCode | undefined {
  if (backendCode && backendCode in SESSION_BACKEND_ERROR_CODES) {
    return SESSION_BACKEND_ERROR_CODES[backendCode as keyof typeof SESSION_BACKEND_ERROR_CODES];
  }
  return undefined;
}

// ── 类型 ─────────────────────────────────────────────────────────────
export interface SessionIssueCodeRequest {
  userId: string;
  /** 实际执行 exchange 的一方：full=设计器目标域；iframe=父页域 */
  origin: string;
}
export interface SessionExchangeRequest {
  code: string;
  /** 兑换方 location.origin，必须与 issue_code 绑定的 origin 一致才兑付 */
  origin: string;
}
export interface SessionRefreshRequest {
  /** 旧 token（POST body 传递，绝不进 URL） */
  token: string;
}
export interface SessionCheckRequest {
  token: string;
}

export interface SessionCodeResult {
  code: string;
  /** 秒（响应口径） */
  expiresIn: number;
}
export interface SessionTokenResult {
  token: string;
  /** 秒（响应口径） */
  expiresIn: number;
}
export interface SessionCheckResult {
  /** false = 401 语义（过期/无效），监控侧走 token-expired 链路 */
  valid: boolean;
  /** 剩余 TTL（毫秒）；有效时必带（监控 90% 阈值判定的数据源） */
  remainingTtlMs?: number;
}

/**
 * 注入式 transport 接口（降级口径核心）：后端未实装期默认 mock；
 * 真实接线时 setSessionTransport(createFetchSessionTransport()) 即切换。
 */
export interface SessionTransport {
  issueCode(req: SessionIssueCodeRequest): Promise<SessionCodeResult>;
  exchange(req: SessionExchangeRequest): Promise<SessionTokenResult>;
  refresh(req: SessionRefreshRequest): Promise<SessionTokenResult>;
  check(req: SessionCheckRequest): Promise<SessionCheckResult>;
}

export class SessionApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    /**
     * 类型化错误码（模板 API 契约）：后端 0607001/0607002/0607003 分别映射
     * SESSION_CODE_INVALID / SESSION_ORIGIN_MISMATCH / SESSION_TOKEN_INVALID；
     * 网络失败/未知错误为 undefined（原始后端码见 fetch transport 日志口径）。
     */
    readonly code?: SessionErrorCode,
  ) {
    super(message);
    this.name = 'SessionApiError';
  }
}

// ── mock transport（默认）：内存 TTL 仿真 ────────────────────────────
// 语义逐条对齐 ：code 绑定 origin + userId + 60s TTL + 一次性使用；
// token TTL 600s；refresh 旧 token 作废 + TTL 重置；check 200/401 语义。
// 注意：mock **接受任意 code 兑换**（真实后端才校验 code 是否由其签发）——
// 降级期 e2e/单测闭环够用，真实接线后以 fetch transport 为权威。

interface MockCodeEntry {
  origin: string;
  userId: string;
  issuedAt: number;
  used: boolean;
}
interface MockTokenEntry {
  issuedAt: number;
  ttlMs: number;
}

/** mock TTL 测试钩子：生产恒为 null（真实 TTL 600s）；单测/e2e 可缩短加速过期场景 */
let mockTtlOverrideMs: number | null = null;
export function setMockSessionTtl(ms: number | null): void {
  mockTtlOverrideMs = ms;
}

export function createMockSessionTransport(): SessionTransport {
  const codes = new Map<string, MockCodeEntry>();
  const tokens = new Map<string, MockTokenEntry>();

  const tokenTtl = (): number => mockTtlOverrideMs ?? SESSION_TOKEN_TTL_MS;
  const remaining = (entry: MockTokenEntry, now: number): number =>
    Math.max(0, entry.issuedAt + entry.ttlMs - now);

  return {
    async issueCode({ userId, origin }) {
      const code = `mock-code-${Math.random().toString(36).slice(2)}-${Date.now()}`;
      codes.set(code, { origin, userId, issuedAt: Date.now(), used: false });
      return { code, expiresIn: SESSION_CODE_TTL_MS / 1000 };
    },
    async exchange({ code, origin }) {
      const entry = codes.get(code);
      if (entry) {
        // 本 mock 自签 code：执行 全量校验（一次性 / origin 绑定 / 60s TTL）
        if (entry.used) throw new SessionApiError('EXCHANGE_FAILED: code 无效或已使用', 401);
        if (entry.origin !== origin) throw new SessionApiError('EXCHANGE_FAILED: origin 不符', 403);
        if (Date.now() - entry.issuedAt > SESSION_CODE_TTL_MS) {
          throw new SessionApiError('EXCHANGE_FAILED: code 已过期（60s）', 401);
        }
        entry.used = true; // 一次性使用
      }
      // 未登记 code：视为真实后端签发（full 模式 code 来自宿主管理后台，mock
      // 无从验真，降级口径照兑；origin/一次性/TTL 校验权威归真实接线的后端）。
      const token = `mock-token-${Math.random().toString(36).slice(2)}-${Date.now()}`;
      tokens.set(token, { issuedAt: Date.now(), ttlMs: tokenTtl() });
      return { token, expiresIn: Math.round(tokenTtl() / 1000) };
    },
    async refresh({ token }) {
      const entry = tokens.get(token);
      if (!entry || remaining(entry, Date.now()) <= 0) {
        tokens.delete(token);
        throw new SessionApiError('REFRESH_FAILED: token 已过期', 401);
      }
      tokens.delete(token); // 旧 token 作废
      const next = `mock-token-${Math.random().toString(36).slice(2)}-${Date.now()}`;
      tokens.set(next, { issuedAt: Date.now(), ttlMs: tokenTtl() }); // TTL 重置
      return { token: next, expiresIn: Math.round(tokenTtl() / 1000) };
    },
    async check({ token }) {
      const entry = tokens.get(token);
      if (!entry) return { valid: false };
      const left = remaining(entry, Date.now());
      if (left <= 0) {
        tokens.delete(token);
        return { valid: false };
      }
      return { valid: true, remainingTtlMs: left };
    },
  };
}

// ── fetch transport（真实接线，模板 API 契约 逐字对齐）──────────────
// POST 单端点 action 分流 + GET check Bearer；token 仅出现在 body/请求头，绝不进 URL。
// 响应口径（后端统一 R 信封）：成功 {code:0, message, result:{...}}；
// 失败为结构化错误体 {code, httpStatus, errorCode:"0607xxx", message, traceId}
// （BusinessException → 422；check 无效 → 422 + 0607003）；老式 R.error 可能以
// 200 + {code:500, message} 返回，一并按错误处置。

export interface FetchSessionTransportOptions {
  /** 后端 origin（如 http://localhost:8866）；缺省 = 同源相对路径（部署反代口径） */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /**
   * 平台 token 供给（仅 issue_code 用，Authorization: Bearer；契约偏差：userId
   * 由后端从平台 token 派生，不信任 body）。designer-web 自身无 issue_code 调用方
   * （签发方为宿主管理后台），缺省不附鉴权头。
   */
  getAuthToken?: () => string | null;
}

/** 兼容旧签名：createFetchSessionTransport(fetchImpl) */
export function createFetchSessionTransport(
  optsOrFetch?: FetchSessionTransportOptions | typeof fetch,
): SessionTransport {
  const opts: FetchSessionTransportOptions =
    typeof optsOrFetch === 'function' ? { fetchImpl: optsOrFetch } : (optsOrFetch ?? {});
  const fetchImpl = opts.fetchImpl ?? fetch;
  const endpoint = joinBase(opts.baseUrl, SESSION_ENDPOINT);
  const checkEndpoint = joinBase(opts.baseUrl, SESSION_CHECK_ENDPOINT);

  const safeJson = async (resp: Response): Promise<Record<string, unknown>> => {
    try {
      return (await resp.json()) as Record<string, unknown>;
    } catch {
      return {};
    }
  };

  /** 结构化错误体 → 类型化 SessionApiError（0607001/0607002/0607003） */
  const failFromResponse = (status: number, data: Record<string, unknown>): SessionApiError => {
    const backendCode = typeof data.errorCode === 'string' ? data.errorCode : undefined;
    const typed = typedSessionErrorCode(backendCode);
    const detail =
      typeof data.message === 'string' && data.message.trim() ? `：${data.message}` : '';
    return new SessionApiError(
      `SESSION_REQUEST_FAILED:${status}${typed ? ` ${typed}` : ''}${detail}`,
      status,
      typed,
    );
  };

  const post = async (
    body: Record<string, unknown>,
    auth: boolean,
  ): Promise<Record<string, unknown>> => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    // 仅 issue_code 需要调用方平台 token（Bearer）；exchange/refresh 的凭据在 body
    const platformToken = auth ? opts.getAuthToken?.() : null;
    if (platformToken) headers.Authorization = `Bearer ${platformToken}`;
    let resp: Response;
    try {
      resp = await fetchImpl(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
    } catch {
      throw new SessionApiError('SESSION_REQUEST_FAILED:network');
    }
    const data = await safeJson(resp);
    if (!resp.ok) throw failFromResponse(resp.status, data);
    // 老式 R.error：200 + {code:500, message}（无 result）——按信封逻辑码报错
    if (typeof data.code === 'number' && data.code !== 0 && data.result === undefined) {
      throw failFromResponse(data.code, data);
    }
    // R 信封解包：result 优先（真实后端），裸负载兜底（旧协议形态测试口径）
    const payload = (data.result ?? data) as Record<string, unknown>;
    return payload;
  };

  return {
    async issueCode({ userId, origin }) {
      const data = await post({ action: 'issue_code', userId, origin }, true);
      return { code: String(data.code), expiresIn: Number(data.expiresIn) };
    },
    async exchange({ code, origin }) {
      const data = await post({ action: 'exchange', code, origin }, false);
      return { token: String(data.token), expiresIn: Number(data.expiresIn) };
    },
    async refresh({ token }) {
      const data = await post({ action: 'refresh', token }, false);
      return { token: String(data.token), expiresIn: Number(data.expiresIn) };
    },
    async check({ token }) {
      let resp: Response;
      try {
        resp = await fetchImpl(checkEndpoint, {
          headers: { Authorization: `Bearer ${token}` },
        });
      } catch {
        throw new SessionApiError('SESSION_CHECK_FAILED:network');
      }
      if (resp.status === 401) return { valid: false };
      const data = await safeJson(resp);
      if (!resp.ok) {
        const backendCode = typeof data.errorCode === 'string' ? data.errorCode : undefined;
        // 模板 API 契约：check 无效 = 422 + SESSION_TOKEN_INVALID(0607003) → 401 同语义
        if (backendCode === '0607003') return { valid: false };
        const typed = typedSessionErrorCode(backendCode);
        throw new SessionApiError(`SESSION_CHECK_FAILED:${resp.status}`, resp.status, typed);
      }
      return {
        valid: true,
        remainingTtlMs: typeof data.remainingTtlMs === 'number' ? data.remainingTtlMs : undefined,
      };
    },
  };
}

/** baseUrl（origin 前缀）+ 契约路径常量拼接；baseUrl 缺省 = 同源相对路径 */
function joinBase(baseUrl: string | undefined, path: string): string {
  if (!baseUrl) return path;
  return baseUrl.replace(/\/+$/, '') + path;
}

// ── transport 注入点（默认 mock；真实接线 setSessionTransport(fetch)）──

let activeTransport: SessionTransport = createMockSessionTransport();

export function setSessionTransport(transport: SessionTransport): void {
  activeTransport = transport;
}
export function getSessionTransport(): SessionTransport {
  return activeTransport;
}

/** session API 门面：方法调用经当前注入 transport（测试可整体替换断言） */
export const sessionApi = {
  issueCode: (req: SessionIssueCodeRequest) => activeTransport.issueCode(req),
  exchange: (req: SessionExchangeRequest) => activeTransport.exchange(req),
  refresh: (req: SessionRefreshRequest) => activeTransport.refresh(req),
  check: (req: SessionCheckRequest) => activeTransport.check(req),
};

// ── 内存 token 持有（不落 storage）────────────────────────────
// full 模式 ensureSession 兑换后写入；监控/未来 api.ts Bearer 注入（挂账）读取。

let memoryToken: string | null = null;
export function setSessionToken(token: string | null): void {
  memoryToken = token;
}
export function getSessionToken(): string | null {
  return memoryToken;
}

// ── 监控周期计时器工厂（embed/full 监控共用；计时器可注入便于单测）────

export interface TokenWatchHandle {
  clear(): void;
}
export type CreateInterval = (fn: () => void, ms: number) => TokenWatchHandle;

/** 默认计时器工厂：包装 setInterval 返回带 clear() 的句柄 */
export function defaultCreateInterval(fn: () => void, ms: number): TokenWatchHandle {
  const id = setInterval(fn, ms);
  return { clear: () => clearInterval(id) };
}

/** 启动周期 watch；返回句柄，clear() 即停 */
export function createTokenWatch(
  tick: () => void,
  intervalMs: number,
  create: CreateInterval,
): TokenWatchHandle {
  return create(tick, intervalMs);
}
