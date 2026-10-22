// SPDX-License-Identifier: Apache-2.0
// embed token 主动监控 caller（设计契约）。
//
// 监控口径：token 签发/刷新后启动 60s 周期检查；剩余 TTL ≤10%
// （90% 已过）主动 refresh；401/过期 → 既有 token-expired 链路（仅补 caller，
// 协议类型零改动）。检查路径按 场景分支：
// - **本地 embed（WPF/Flutter localhost 主路径）**：上行 token-check 委托宿主调
// 后端 /check（宿主代查的权威路径；相对 URL 直连会打到本地静态 server），
// TTL 90% 阈值为客户端兜底（宿主静默时不永久停摆）。
// - **远程同域（iframe web）**：经 shared/session-api 注入式 transport 直连
// GET /session/check——后端未实装期默认 mock transport（内存 TTL 仿真，降级
// 口径已批准）；真实接线挂账。
//
// 依赖方向单向：sdk-core.ts → 本模块（本模块不 import sdk-core，状态回写经
// onTokenExpired/onTokenRefreshed 回调，避免循环依赖）。
import {
  SESSION_REFRESH_TTL_FRACTION,
  createTokenWatch,
  defaultCreateInterval,
  sessionApi,
  type TokenWatchHandle,
} from '../shared/session-api';

export const TOKEN_CHECK_INTERVAL_MS = 60_000;
/** token TTL 10 分钟（设计器会话 token 默认生命周期） */
export const TOKEN_TTL_MS_DEFAULT = 10 * 60 * 1000;
/** TTL 90% 阈值（本地路径兜底触发线；剩余 ≤10% = 同值另一侧表述） */
export const TOKEN_TTL_EXPIRY_THRESHOLD = 0.9;

export interface TokenMonitorHandle {
  /** 清理函数：调用即停止计时器 */
  clear(): void;
}

export interface TokenMonitorOptions {
  /** 60s 周期 check 的间隔（默认 TOKEN_CHECK_INTERVAL_MS） */
  checkIntervalMs?: number;
  /** token TTL（默认 10 分钟） */
  tokenTtlMs?: number;
  /** TTL 阈值（默认 0.9 = 90% 已过） */
  ttlThreshold?: number;
  /** 计时器工厂（默认 setInterval；测试可注入 fake 计时器直接控制触发） */
  createInterval?: (fn: () => void, ms: number) => TokenMonitorHandle;
  /** 本地 embed 判定（默认按 启发式：http://localhost:<port>）；
   * 测试可注入 false 强制走 session-api 直连路径 */
  localEmbed?: boolean;
  /** 401/过期处置回调（sdk-core 接 notifyTokenExpired：token-expired 上行 + 致命态） */
  onTokenExpired?: (reason: string) => void;
  /** 主动 refresh 成功回调（sdk-core 写回 window.__TAPRINT_TOKEN__——刷新即换密钥 ） */
  onTokenRefreshed?: (newToken: string) => void;
}

/** 本地 embed 启发式：WPF/Flutter 本地资源主入口（localhost + 显式端口） */
export function isLocalEmbedDefault(): boolean {
  return (
    window.location.protocol === 'http:' &&
    window.location.hostname === 'localhost' &&
    window.location.port !== ''
  );
}

// ── 模块级监控状态（单实例；destroyEmbed/token-refreshed 复位）────────

let watchHandle: TokenWatchHandle | null = null;
let monitorOpts: Required<TokenMonitorOptions> | null = null;
let lastTokenRefreshAt = 0;
/** 远程路径 tick 异步防重入（check/refresh 未决时下一周期跳过，避免叠加请求） */
let remoteTickInFlight = false;

/** 当前监控配置（测试只读，便于断言） */
export function getTokenMonitorOptions(): Required<TokenMonitorOptions> | null {
  return monitorOpts;
}

/** token-refreshed 到达（宿主回推或远程主动 refresh 成功）：重置 TTL 计时基准 */
export function markTokenRefreshed(): void {
  lastTokenRefreshAt = Date.now();
}

/**
 * 启动 token 过期检测（startTokenExpiryWatch）。
 * 已运行时按「重启」语义：先 stop 再 start，重置 60s 计时与 lastTokenRefreshAt。
 */
export function startTokenExpiryWatch(opts: TokenMonitorOptions = {}): void {
  // 重启语义：先停旧 handle，避免双计时器叠加（设计契约）
  stopTokenExpiryWatch();
  monitorOpts = {
    checkIntervalMs: opts.checkIntervalMs ?? TOKEN_CHECK_INTERVAL_MS,
    tokenTtlMs: opts.tokenTtlMs ?? TOKEN_TTL_MS_DEFAULT,
    ttlThreshold: opts.ttlThreshold ?? TOKEN_TTL_EXPIRY_THRESHOLD,
    createInterval: opts.createInterval ?? defaultCreateInterval,
    localEmbed: opts.localEmbed ?? isLocalEmbedDefault(),
    onTokenExpired: opts.onTokenExpired ?? (() => {}),
    onTokenRefreshed: opts.onTokenRefreshed ?? (() => {}),
  };
  lastTokenRefreshAt = Date.now();
  remoteTickInFlight = false;
  const resolved = monitorOpts;
  watchHandle = createTokenWatch(
    () => void runTokenCheckTick(),
    resolved.checkIntervalMs,
    resolved.createInterval,
  );
}

/** 停止 token 过期检测（destroyEmbed / 过期处置 / 重启前调用） */
export function stopTokenExpiryWatch(): void {
  watchHandle?.clear();
  watchHandle = null;
}

/** 卸除监控全部状态（destroyEmbed 调用） */
export function resetTokenMonitor(): void {
  stopTokenExpiryWatch();
  monitorOpts = null;
  lastTokenRefreshAt = 0;
  remoteTickInFlight = false;
}

/**
 * 单次 check 周期（拆出独立函数便于单测直接调用，不真等 60s）。
 * 本地路径同步语义（既有单测 fake timers 依赖）；远程路径异步。
 */
export async function runTokenCheckTick(): Promise<void> {
  const opts = monitorOpts;
  if (!opts) return;
  if (opts.localEmbed) {
    tickLocal(opts);
  } else {
    await tickRemote(opts);
  }
}

/**
 * 本地 embed 路径（既有权威口径）：上行 token-check 委托宿主 + 客户端 TTL 90%
 * 兜底——宿主仅在过期时回推 token-refreshed，超时未回推即主动 token-expired。
 */
function tickLocal(opts: Required<TokenMonitorOptions>): void {
  // 上行回调由 sdk-core 注入（postMessageToHost token-check）——经 onTokenExpired
  // 之外的专用通道：此处直接走 opts 闭包外的注入点（见 sdk-core 装配）。
  localCheckHook();
  const elapsed = Date.now() - lastTokenRefreshAt;
  if (elapsed >= opts.tokenTtlMs * opts.ttlThreshold) {
    opts.onTokenExpired(
      `token TTL ${opts.ttlThreshold * 100}% 阈值触发（elapsed ${Math.round(elapsed / 1000)}s）`,
    );
  }
}

// 本地路径 token-check 上行钩子：sdk-core 装配时注入（postMessageToHost），
// 单测未装配时为 no-op——保持本模块对 host-bridge 零依赖。
let localCheckHook: () => void = () => {};
export function setLocalCheckHook(fn: () => void): void {
  localCheckHook = fn;
}

/**
 * 远程同域路径（新增 caller）：GET /session/check（经注入式 transport）。
 * - 无效/401 → onTokenExpired（既有 token-expired 链路）
 * - 有效且剩余 TTL ≤10% → 主动 refresh（直连）；成功写回新 token + 重置基准，
 * 失败 → onTokenExpired（宿主兜底刷新）
 * - 网络异常不处置，等下次周期（catch 口径）
 */
async function tickRemote(opts: Required<TokenMonitorOptions>): Promise<void> {
  if (remoteTickInFlight) return;
  const token = window.__TAPRINT_TOKEN__;
  if (!token) return;
  remoteTickInFlight = true;
  try {
    const result = await sessionApi.check({ token });
    if (!result.valid) {
      opts.onTokenExpired('session/check 返回 401（token 已过期）');
      return;
    }
    const remainingTtlMs =
      result.remainingTtlMs ??
      // check 未回带剩余 TTL 时回退客户端 elapsed 启发式（与本地路径同阈值）
      Math.max(0, opts.tokenTtlMs - (Date.now() - lastTokenRefreshAt));
    if (remainingTtlMs <= opts.tokenTtlMs * SESSION_REFRESH_TTL_FRACTION) {
      await proactiveRefresh(opts, token);
    }
  } catch {
    // 网络/transport 异常：不主动通知，等下次检查
  } finally {
    remoteTickInFlight = false;
  }
}

/** 剩余 TTL ≤10%：直连 refresh（action:'refresh'，旧 token 作废 TTL 重置） */
async function proactiveRefresh(
  opts: Required<TokenMonitorOptions>,
  oldToken: string,
): Promise<void> {
  try {
    const { token } = await sessionApi.refresh({ token: oldToken });
    opts.onTokenRefreshed(token);
    markTokenRefreshed();
  } catch {
    // 直连刷新失败（后端未实装/网络）→ 走既有 token-expired 链路交宿主刷新
    opts.onTokenExpired('剩余 TTL ≤10% 主动 refresh 失败，转交宿主刷新');
  }
}
