// SPDX-License-Identifier: Apache-2.0
// full 模式启动鉴权（设计契约）。
// 调用挂点：main.ts full 分支，await ensureSession() 后再 createApp(FullApp)。
//
// transport 口径（模板 API 契约）：
// exchange/refresh/check 经 shared/session-api 注入式 transport。环境变量
// VITE_SESSION_API_BASE 有值 → fetch transport（真实后端）；缺省 → mock
// （内存 TTL 仿真，测试/离线语义不变，既有 e2e/单测全部走 mock）。
// 与 设计契约 示意稿的偏差（完工报告登记）：
// - 无 code 路径为 redirectToLogin 跳回宿主管理后台——降级期无真实
// 登录源可跳，改为 no-op（不阻断既有 full e2e）；真实接线挂账恢复 redirect。
// - sessionStore（pinia）在 createApp 前不可用——token 经 session-api 内存持有
// （setSessionToken/getSessionToken， 不落 storage），语义等价。
import {
  SESSION_REFRESH_TTL_FRACTION,
  SESSION_TOKEN_TTL_MS,
  createFetchSessionTransport,
  createTokenWatch,
  defaultCreateInterval,
  getSessionToken,
  sessionApi,
  setMockSessionTtl,
  setSessionToken,
  setSessionTransport,
  type CreateInterval,
  type TokenWatchHandle,
} from '../shared/session-api';
import { resolveApiBase } from '../shared/env';

/** transport 形态（initSessionTransport 返回值；测试/诊断用） */
export type SessionTransportKind = 'fetch' | 'mock';

/**
 * session transport 环境开关：VITE_SESSION_API_BASE 有值 →
 * setSessionTransport(createFetchSessionTransport({baseUrl}))；缺省保持当前
 * transport（默认 mock）。ensureSession 入口幂等调用；apiBase 可注入便于单测。
 */
export function initSessionTransport(
  apiBase: string | null = resolveApiBase(),
): SessionTransportKind {
  if (apiBase) {
    setSessionTransport(createFetchSessionTransport({ baseUrl: apiBase }));
    return 'fetch';
  }
  return 'mock';
}

/** redirect 中断信号（调用方 catch 后中止挂载） */
export class AuthRedirectError extends Error {
  constructor(reason: string) {
    super(`AUTH_REDIRECT:${reason}`);
    this.name = 'AuthRedirectError';
  }
}

/** 会话过期后的引导跳转域（宿主/登录源；部署域调整时此处与父页侧同步）。
 * 缺省为占位域，集成方构建时应以 VITE_ADMIN_ORIGIN 注入真实管理后台 origin。 */
export const DEFAULT_ADMIN_ORIGIN: string =
  (import.meta.env?.VITE_ADMIN_ORIGIN as string | undefined) || 'https://admin.example.com';

/** full 模式 token 监控周期（与 embed 侧 同口径 60s） */
export const FULL_SESSION_CHECK_INTERVAL_MS = 60_000;
/** 过期弹窗后延迟跳转（留出阅读时间；e2e 断言窗口内不真跳） */
const REDIRECT_DELAY_MS = 1_500;

// adminOrigin 覆盖值须在 replaceState 清 query 前捕获（过期跳转发生在其后）
let adminOriginOverride: string | null = null;

function resolveAdminOrigin(): string {
  return adminOriginOverride || DEFAULT_ADMIN_ORIGIN;
}

// 当前 token 实际 TTL（exchange/refresh 响应 expiresIn）——90% 阈值按此计算，
// 不用常量假定值（mock 缩短 TTL 场景下阈值随之收缩，口径才正确）。
let fullTokenTtlMs = SESSION_TOKEN_TTL_MS;

/**
 * full 模式启动鉴权（表格「Web full」行）：
 * transport 环境开关（VITE_SESSION_API_BASE 有值 → fetch）→
 * URL 一次性 code → POST session exchange → token 仅内存 → replaceState 清 code →
 * 启动 60s 周期 check 监控。无 code：降级期 no-op（见文件头偏差登记）。
 */
export async function ensureSession(): Promise<void> {
  // transport 环境开关（幂等）：真实接线 / mock 缺省在此决定，其后的 sessionApi 全量生效
  const transportKind = initSessionTransport();
  const params = new URLSearchParams(location.search);
  // adminOrigin 覆盖（e2e 注入同源跳转目标）——须在下方 replaceState 清 query 前捕获
  adminOriginOverride = params.get('adminOrigin');
  // e2e 调试钩子（生产 URL 不带该参数即 no-op）：缩短 mock transport token TTL，
  // 使过期/续期场景在 e2e 时间窗内可达
  const mockTtl = params.get('__sessionMockTtl');
  if (mockTtl) setMockSessionTtl(Number(mockTtl));
  const code = params.get('code');
  if (!code) {
    // 无 code 分支：
    // - fetch transport（真实后端，VITE_SESSION_API_BASE 有值）→ 无法取得会话 token，
    // 明确引导回管理后台登录源（生产口径；bootstrap.ts 文件头「无 code 路径」挂账收尾）。
    // - mock transport（e2e/离线缺省）→ no-op，保持既有 full e2e 直开语义不变。
    if (transportKind === 'fetch') {
      renderSessionExpired('会话未建立，请从管理后台进入打印设计器');
      scheduleRedirect();
      throw new AuthRedirectError('NO_CODE_REDIRECT');
    }
    return;
  }
  try {
    const { token, expiresIn } = await sessionApi.exchange({ code, origin: location.origin });
    setSessionToken(token);
    if (expiresIn > 0) fullTokenTtlMs = expiresIn * 1000;
    // 从 URL 清除 code（防残留/分享泄露， 要点）——调试钩子参数一并清除
    history.replaceState({}, '', location.pathname);
    const intervalOverride = params.get('__sessionCheckInterval');
    startFullSessionMonitor(intervalOverride ? { checkIntervalMs: Number(intervalOverride) } : {});
  } catch {
    // code 过期/伪造/网络失败——明确报错并引导回源，redirect 即抛中断启动
    renderSessionExpired('会话兑换失败，请从管理后台重新进入');
    scheduleRedirect();
    throw new AuthRedirectError('EXCHANGE_REDIRECT');
  }
}

// ── full 模式 token 主动监控（与 embed 同口径：60s check + ≤10% 主动 refresh）──

let watchHandle: TokenWatchHandle | null = null;
let redirectTimer: ReturnType<typeof setTimeout> | null = null;

export interface FullSessionMonitorOptions {
  checkIntervalMs?: number;
  /** 计时器工厂（测试可注入 fake） */
  createInterval?: CreateInterval;
}

/**
 * 启动 full 模式 session 监控。token 由 ensureSession 兑换后内存持有；
 * 无效/401 → 过期弹窗 + 引导回源；剩余 TTL ≤10% → 直连 refresh（旧 token 作废
 * TTL 重置，action:'refresh'）。
 */
export function startFullSessionMonitor(opts: FullSessionMonitorOptions = {}): void {
  stopFullSessionMonitor();
  watchHandle = createTokenWatch(
    () => void fullSessionTick(),
    opts.checkIntervalMs ?? FULL_SESSION_CHECK_INTERVAL_MS,
    opts.createInterval ?? defaultCreateInterval,
  );
}

export function stopFullSessionMonitor(): void {
  watchHandle?.clear();
  watchHandle = null;
}

async function fullSessionTick(): Promise<void> {
  const token = getSessionToken();
  if (!token) {
    stopFullSessionMonitor();
    return;
  }
  let result;
  try {
    result = await sessionApi.check({ token });
  } catch {
    return; // 网络异常不处置，等下次周期（catch 口径）
  }
  if (!result.valid) {
    sessionExpired('会话已过期，请重新进入设计器');
    return;
  }
  const remainingTtlMs = result.remainingTtlMs ?? fullTokenTtlMs;
  if (remainingTtlMs <= fullTokenTtlMs * SESSION_REFRESH_TTL_FRACTION) {
    try {
      const { token: next, expiresIn } = await sessionApi.refresh({ token });
      setSessionToken(next); // TTL 重置，仅内存
      if (expiresIn > 0) fullTokenTtlMs = expiresIn * 1000;
    } catch {
      sessionExpired('会话续期失败，请重新进入设计器');
    }
  }
}

/** 过期处置（表格 full 行）：弹窗「会话过期」+ 引导回源 */
function sessionExpired(message: string): void {
  stopFullSessionMonitor();
  setSessionToken(null);
  renderSessionExpired(message);
  scheduleRedirect();
}

function renderSessionExpired(message: string): void {
  if (document.querySelector('[data-testid="session-expired"]')) return;
  const box = document.createElement('div');
  box.dataset.testid = 'session-expired';
  box.style.cssText =
    'position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:9999;' +
    'padding:12px 20px;font-family:sans-serif;color:#b91c1c;background:#fef2f2;' +
    'border:1px solid #fecaca;border-radius:6px';
  box.textContent = message;
  document.body.appendChild(box);
}

function scheduleRedirect(): void {
  if (redirectTimer !== null) return;
  const adminOrigin = resolveAdminOrigin();
  redirectTimer = setTimeout(() => {
    redirectTimer = null;
    window.location.href = adminOrigin;
  }, REDIRECT_DELAY_MS);
}
