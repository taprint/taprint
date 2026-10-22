// SPDX-License-Identifier: Apache-2.0
// embed SDK bootstrap：init 序列 + token 注入三通道；
// preview/testPrint 通道 + readOnly 完整编辑锁。
// token 主动监控：caller 实装在 ./session-monitor.ts
// （60s 周期 check + 剩余 TTL ≤10% 主动 refresh + 过期走 token-expired 链路），
// HTTP 层经 ../shared/session-api.ts 注入式 transport（后端未实装期默认 mock）；
// 本文件仅最小接线（startEmbed 启动 / destroyEmbed 卸除 / token-refreshed 复位）。
// init 顺序：token 注入 → 注册宿主消息监听 → store 挂载 → ready 上报 →
// token 过期检测启动。
// token 刷新：无显式换钥动作——签名密钥按 getToken 每次派生，
// window.__TAPRINT_TOKEN__ 更新即自动生效；token-refreshed 消息仅语义确认 +
// 监控复位（链路最后一跳：notifyTokenExpired 已 stopTokenExpiryWatch，
// 收到 token-refreshed 必须重启监控，否则刷新后过期检测永久停摆）。
import { createApp, reactive, watch, type App } from 'vue';
import { createPinia } from 'pinia';
import EmbedApp from './App.vue';
import {
  getParentOrigin,
  initHostBridge,
  onMessageFromHost,
  postMessageToHost,
  resetHostBridge,
  type SignedHostMessage,
} from './host-bridge';
import {
  markTokenRefreshed,
  resetTokenMonitor,
  setLocalCheckHook,
  startTokenExpiryWatch as startSessionMonitor,
  stopTokenExpiryWatch as stopSessionMonitor,
  type TokenMonitorOptions,
} from './session-monitor';
import { useDesignerStore } from '../canvas/store';

export const TOKEN_INJECTION_TIMEOUT = 'TOKEN_INJECTION_TIMEOUT';
const TOKEN_INJECTION_TIMEOUT_MS = 10_000;

// token 主动监控常量/类型/入口实装在 ./session-monitor.ts；
// 此处重导出保持既有导入面（单测自 sdk-core 导入）不变。
export {
  TOKEN_CHECK_INTERVAL_MS,
  TOKEN_TTL_MS_DEFAULT,
  TOKEN_TTL_EXPIRY_THRESHOLD,
  getTokenMonitorOptions,
  type TokenMonitorHandle,
  type TokenMonitorOptions,
} from './session-monitor';

/** embed 连接态（App.vue 顶栏 chip 与回执展示的数据源） */
export const embedState = reactive({
  /** waiting-host = 已握手等待宿主下发模板；connected = 模板已挂载 */
  status: 'booting' as 'booting' | 'waiting-host' | 'connected' | 'fatal',
  fatalMessage: null as string | null,
  saveResult: null as { success: boolean; errorMessage?: string } | null,
  /** save 已上行、等待宿主回执（超时兜底见 beginSavePending） */
  saving: false,
  /** 预览回执（previewResult 下行） */
  previewResult: null as { previewUrl?: string; errorMessage?: string } | null,
  /** 预览已上行、等待宿主回执（与 save 同口径超时兜底） */
  previewing: false,
  /** 测试打印回执（printResult 下行） */
  printResult: null as { success?: boolean; errorMessage?: string } | null,
  /** 测试打印已上行、等待宿主回执 */
  testingPrint: false,
  /** token 主动监控状态：expired = 已上行 token-expired，
   * 进入致命态等宿主刷新（token-refreshed 复位为 healthy） */
  tokenStatus: 'pending' as 'pending' | 'healthy' | 'expired',
});

function resetEmbedState(): void {
  embedState.status = 'booting';
  embedState.fatalMessage = null;
  embedState.saveResult = null;
  embedState.saving = false;
  embedState.previewResult = null;
  embedState.previewing = false;
  embedState.printResult = null;
  embedState.testingPrint = false;
  embedState.tokenStatus = 'pending';
  clearSaveReceiptTimer();
  clearPreviewReceiptTimer();
  clearPrintReceiptTimer();
  stopTokenExpiryWatch();
}

declare global {
  interface Window {
    /** 宿主注入的会话 token（仅内存，不落 storage；/） */
    __TAPRINT_TOKEN__?: string;
    /** 宿主注入的运行配置（parentOrigin 白名单；，严禁 '*'） */
    __TAPRINT_DESIGNER_CONFIG__?: { parentOrigin?: string };
  }
}

function tryParseJson(s: string): unknown {
  try {
    return JSON.parse(s) as unknown;
  } catch {
    return null;
  }
}

// ── token 注入三通道──────────────────────────────────────────
//① 直读 window.__TAPRINT_TOKEN__（宿主挂载前注入）
//② taprint-token-injected 事件（WPF/Flutter：宿主执行 JS 写 token 后派发）
//③ iframe 通道 B：父页 postMessage {type:'taprint-token', token}，origin 白名单校验
// ②③ 在 embed 生命周期内持续监听（支持 token 刷新推送，刷新即换密钥）；
// destroyEmbed 时经 stopTokenListeners 真移除（重启用按新 parentOrigin 重建）。

let tokenListenersStarted = false;
// channel B 持续监听器引用——stopTokenListeners 必须真移除（重启用场景：
// 不存引用则 destroyEmbed 后旧 parentOrigin 闭包残留，新 origin 的 token 推送被拒）
let tokenMessageListener: ((ev: MessageEvent) => void) | null = null;

function extractTokenMessage(ev: MessageEvent, parentOrigin: string): string | null {
  if (ev.origin !== parentOrigin) return null;
  const data: unknown = typeof ev.data === 'string' ? tryParseJson(ev.data) : ev.data;
  if (!data || typeof data !== 'object') return null;
  const msg = data as { type?: unknown; token?: unknown };
  if (msg.type !== 'taprint-token' || typeof msg.token !== 'string') return null;
  return msg.token;
}

function startTokenListeners(parentOrigin: string): void {
  if (tokenListenersStarted) return;
  tokenListenersStarted = true;
  // taprint-token-injected 事件本身无需常驻监听——awaitTokenInjection 自带
  // onInjected；token 刷新推送由下方 channel B 监听器写 token 后 dispatch，
  // 密钥按 getToken 现读自动更换，设计器无需感知刷新事件。
  tokenMessageListener = (ev: MessageEvent) => {
    const token = extractTokenMessage(ev, parentOrigin);
    if (token) {
      window.__TAPRINT_TOKEN__ = token;
      window.dispatchEvent(new Event('taprint-token-injected'));
    }
  };
  window.addEventListener('message', tokenMessageListener);
}

/** 卸除 channel B 持续监听并复位（destroyEmbed 调用；重启用时按新 origin 重建） */
export function stopTokenListeners(): void {
  if (tokenMessageListener) {
    window.removeEventListener('message', tokenMessageListener);
    tokenMessageListener = null;
  }
  tokenListenersStarted = false;
}

/**
 * 等待宿主 token 注入（先于 store 初始化；超时 10s 显式错误 UI）。
 * 超时 reject Error(TOKEN_INJECTION_TIMEOUT)。
 */
export function awaitTokenInjection(
  parentOrigin: string,
  timeoutMs: number = TOKEN_INJECTION_TIMEOUT_MS,
): Promise<string> {
  startTokenListeners(parentOrigin);
  return new Promise((resolve, reject) => {
    if (window.__TAPRINT_TOKEN__) {
      resolve(window.__TAPRINT_TOKEN__);
      return;
    }
    const onInjected = (): void => {
      const t = window.__TAPRINT_TOKEN__;
      if (typeof t === 'string' && t) settle(t);
    };
    const onMessage = (ev: MessageEvent): void => {
      const token = extractTokenMessage(ev, parentOrigin);
      if (token) settle(token);
    };
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        cleanup();
        reject(new Error(TOKEN_INJECTION_TIMEOUT));
      }
    }, timeoutMs);
    function cleanup(): void {
      window.removeEventListener('taprint-token-injected', onInjected);
      window.removeEventListener('message', onMessage);
    }
    function settle(token: string): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      resolve(token);
    }
    window.addEventListener('taprint-token-injected', onInjected);
    window.addEventListener('message', onMessage);
  });
}

// ── save 回执等待态 + 超时兜底────────────────────────────
// 设计契约 要求宿主失败必回执，但宿主异常时可能静默——设计器侧 15s 兜底，
// 避免保存按钮点击后界面永久无反馈。

export const SAVE_RECEIPT_TIMEOUT_MS = 15_000;
let saveReceiptTimer: ReturnType<typeof setTimeout> | null = null;

export function clearSaveReceiptTimer(): void {
  if (saveReceiptTimer !== null) {
    clearTimeout(saveReceiptTimer);
    saveReceiptTimer = null;
  }
}

/** save 上行后进入等待态；宿主 15s 未回执即翻失败回执（超时兜底） */
export function beginSavePending(): void {
  embedState.saving = true;
  clearSaveReceiptTimer();
  saveReceiptTimer = setTimeout(() => {
    saveReceiptTimer = null;
    embedState.saving = false;
    embedState.saveResult = {
      success: false,
      errorMessage: `宿主回执超时（${SAVE_RECEIPT_TIMEOUT_MS / 1000}s）`,
    };
  }, SAVE_RECEIPT_TIMEOUT_MS);
}

/** 宿主 saveResult 到达：清超时计时器，落回执 */
export function settleSaveReceipt(result: { success: boolean; errorMessage?: string }): void {
  clearSaveReceiptTimer();
  embedState.saving = false;
  embedState.saveResult = result;
}

// ── preview/testPrint 回执等待态 + 超时兜底──────────────
// 与 save 同口径：宿主异常静默时设计器侧 15s 兜底，避免点击后界面永久无反馈。

export const PREVIEW_RECEIPT_TIMEOUT_MS = SAVE_RECEIPT_TIMEOUT_MS;
let previewReceiptTimer: ReturnType<typeof setTimeout> | null = null;

export function clearPreviewReceiptTimer(): void {
  if (previewReceiptTimer !== null) {
    clearTimeout(previewReceiptTimer);
    previewReceiptTimer = null;
  }
}

/** preview 上行后进入等待态；宿主 15s 未回执即翻失败回执（超时兜底） */
export function beginPreviewPending(): void {
  embedState.previewing = true;
  clearPreviewReceiptTimer();
  previewReceiptTimer = setTimeout(() => {
    previewReceiptTimer = null;
    embedState.previewing = false;
    embedState.previewResult = {
      errorMessage: `宿主回执超时（${PREVIEW_RECEIPT_TIMEOUT_MS / 1000}s）`,
    };
  }, PREVIEW_RECEIPT_TIMEOUT_MS);
}

/** 宿主 previewResult 到达：清超时计时器，落回执 */
export function settlePreviewReceipt(result: { previewUrl?: string; errorMessage?: string }): void {
  clearPreviewReceiptTimer();
  embedState.previewing = false;
  embedState.previewResult = result;
}

export const PRINT_RECEIPT_TIMEOUT_MS = SAVE_RECEIPT_TIMEOUT_MS;
let printReceiptTimer: ReturnType<typeof setTimeout> | null = null;

export function clearPrintReceiptTimer(): void {
  if (printReceiptTimer !== null) {
    clearTimeout(printReceiptTimer);
    printReceiptTimer = null;
  }
}

/** testPrint 上行后进入等待态；宿主 15s 未回执即翻失败回执（超时兜底） */
export function beginPrintPending(): void {
  embedState.testingPrint = true;
  clearPrintReceiptTimer();
  printReceiptTimer = setTimeout(() => {
    printReceiptTimer = null;
    embedState.testingPrint = false;
    embedState.printResult = {
      success: false,
      errorMessage: `宿主回执超时（${PRINT_RECEIPT_TIMEOUT_MS / 1000}s）`,
    };
  }, PRINT_RECEIPT_TIMEOUT_MS);
}

/** 宿主 printResult 到达：清超时计时器，落回执 */
export function settlePrintReceipt(result: { success?: boolean; errorMessage?: string }): void {
  clearPrintReceiptTimer();
  embedState.testingPrint = false;
  embedState.printResult = result;
}

// ── preview / testPrint 上行入口──────────────────────────
// 设计契约 上行 dsl + deviceClass；本地仿真 PNG 经 PreviewPane 渲染
// （过渡能力，边界不变）；schema additionalProperties:false 禁止附 PNG。

/** 上行 preview（previewResult 回执写入 embedState.previewResult） */
export function requestPreview(dsl: Record<string, unknown>, deviceClass: Device): boolean {
  embedState.previewResult = null;
  beginPreviewPending();
  return postMessageToHost({ type: 'preview', dsl, deviceClass });
}

/** 上行 testPrint（printResult 回执写入 embedState.printResult） */
export function requestTestPrint(dsl: Record<string, unknown>, deviceClass: Device): boolean {
  embedState.printResult = null;
  beginPrintPending();
  return postMessageToHost({ type: 'testPrint', dsl, deviceClass });
}

// ── token 主动监控接线────
// caller 实装在 ./session-monitor.ts（60s 周期 check + 剩余 TTL ≤10% 主动 refresh）；
// 本段仅装配 embed 语义回调：过期 → notifyTokenExpired（token-expired 上行 + 致命态），
// 直连 refresh 成功 → 写回 window.__TAPRINT_TOKEN__（刷新即换密钥 ，
// host-bridge deriveKey 按 getToken 现读自动生效）。

type Device = 'doc' | 'receipt' | 'label';

// 本地路径（WPF/Flutter localhost）token-check 上行钩子：host-bridge 未就绪时
// postMessageToHost 返回 false 无副作用，下次周期重试。
setLocalCheckHook(() => {
  postMessageToHost({ type: 'token-check' });
});

/** 最近一次监控启动 opts——token-refreshed 重启时保持原配置 */
let lastWatchOpts: TokenMonitorOptions = {};

/**
 * 启动 token 过期检测（startTokenExpiryWatch；实装 ./session-monitor.ts）。
 * 已运行时按「重启」语义：先 stop 再 start，重置 60s 计时与 TTL 基准。
 */
export function startTokenExpiryWatch(opts: TokenMonitorOptions = {}): void {
  lastWatchOpts = opts;
  startSessionMonitor({
    ...opts,
    onTokenExpired: (reason) => notifyTokenExpired(reason),
    onTokenRefreshed: (token) => {
      window.__TAPRINT_TOKEN__ = token;
      window.dispatchEvent(new Event('taprint-token-injected'));
    },
  });
}

/** token-refreshed 重启监控入口（保持最近一次 opts） */
function restartTokenWatch(): void {
  startTokenExpiryWatch(lastWatchOpts);
}

/** 停止 token 过期检测（destroyEmbed / notifyTokenExpired / 重启前调用） */
export function stopTokenExpiryWatch(): void {
  stopSessionMonitor();
}

/**
 * 主动上行 token-expired 并翻致命态（notifyTokenExpired）。
 * 调用即停止监控——重启动作在收到 token-refreshed 时由 handleHostMessage 触发。
 */
export function notifyTokenExpired(reason: string = 'token 已失效'): void {
  stopTokenExpiryWatch();
  embedState.tokenStatus = 'expired';
  embedState.status = 'fatal';
  embedState.fatalMessage = `会话 token 失效：${reason}。请通知宿主刷新 token（token-refreshed）后重新操作。`;
  postMessageToHost({ type: 'token-expired' });
  // notifyTokenExpired + ：iframe 场景额外明文通知父页
  // （与 host-bridge 签名信封分离——父页监听端做 origin+source 双校验后刷新）
  if (window.parent !== window) {
    const origin = getParentOrigin();
    if (origin && origin !== '*') {
      window.parent.postMessage({ type: 'taprint-token-expired' }, origin);
    }
  }
}

// ── 宿主消息分发 ──────────────────────────────────────────────────────

/** loadTemplate 期间抑制 dirty 上报（加载复位 dirty=false 非用户编辑） */
let suppressDirtyEmit = false;

type DesignerStore = ReturnType<typeof useDesignerStore>;

export function handleHostMessage(store: DesignerStore, msg: SignedHostMessage): void {
  // 顶层兜底：任何未预期异常上行宿主，不冒泡到 message dispatcher 静默吞错
  try {
    switch (msg.type) {
      case 'loadTemplate': {
        suppressDirtyEmit = true;
        const ok = store.loadTemplate(msg.dsl);
        suppressDirtyEmit = false;
        // 失败保留旧模板口径：已有模板挂载时状态不降级（画布仍显示旧模板，
        // 失败原因经 loadNote + error 上行），避免状态条与画布矛盾
        embedState.status = ok || store.dsl ? 'connected' : 'waiting-host';
        if (!ok) {
          postMessageToHost({ type: 'error', errorMessage: store.loadNote ?? '模板加载失败' });
        }
        break;
      }
      case 'saveResult':
        settleSaveReceipt({ success: msg.success, errorMessage: msg.errorMessage });
        break;
      case 'setReadOnly':
        // 完整编辑锁由各组件读 store.readOnly 各自门禁
        store.setReadOnly(msg.readonly);
        break;
      case 'closeRequest':
        // 宿主确认关窗前先取设计器应答（beforeunload 拦截在宿主侧）
        postMessageToHost({ type: 'close' });
        break;
      case 'previewResult':
        // 宿主预览回执（previewUrl 或 errorMessage）
        settlePreviewReceipt({ previewUrl: msg.previewUrl, errorMessage: msg.errorMessage });
        break;
      case 'printResult':
        // 宿主测试打印回执（success/errorMessage）
        settlePrintReceipt({ success: msg.success, errorMessage: msg.errorMessage });
        break;
      case 'token-refreshed':
        // ：无显式换钥动作（密钥按 getToken 现读自动生效）。
        // 宿主 ：notifyTokenExpired 已 stopTokenExpiryWatch，此处必须重启，
        // 否则刷新后过期检测永久停摆；tokenStatus 复位为 healthy。
        markTokenRefreshed();
        embedState.tokenStatus = 'healthy';
        if (embedState.status === 'fatal' && embedState.fatalMessage?.includes('token')) {
          embedState.status = store.dsl ? 'connected' : 'waiting-host';
          embedState.fatalMessage = null;
        }
        restartTokenWatch();
        break;
      default:
        break;
    }
  } catch (e) {
    suppressDirtyEmit = false; // 异常路径防 flag 泄漏
    postMessageToHost({
      type: 'error',
      errorMessage: `消息处理异常：${e instanceof Error ? e.message : String(e)}`,
    });
  }
}

/** dirty 追踪：编辑动作经 store 置脏 → 上行 {type:'dirty', dirty}（布尔上报） */
export function watchStoreDirty(store: DesignerStore): () => void {
  return watch(
    () => store.dirty,
    (dirty) => {
      if (suppressDirtyEmit) return;
      postMessageToHost({ type: 'dirty', dirty });
    },
    { flush: 'sync' },
  );
}

// ── bootstrap ────────────────────────────────────────────────────────

let app: App | null = null;
let unbindHostMessages: (() => void) | null = null;
let stopDirtyWatch: (() => void) | null = null;

// 宿主消息监听先于 store 实例化注册（顺序）；事件分发必在同步注册段之后，
// 此处经闭包引用延迟取 store。
let storeRefImpl: DesignerStore | null = null;
function storeRef(): DesignerStore {
  if (!storeRefImpl) throw new Error('designer embed: store 未初始化即分发宿主消息');
  return storeRefImpl;
}

/** 启动前致命错误（token 超时/配置缺失）：不挂载 Vue，静态错误 UI（显式错误 UI） */
function renderFatal(root: Element, message: string): void {
  embedState.status = 'fatal';
  embedState.fatalMessage = message;
  root.textContent = '';
  const box = document.createElement('div');
  box.dataset.testid = 'embed-fatal';
  box.style.cssText =
    'padding:16px;font-family:sans-serif;color:#b91c1c;border:1px solid #fecaca;background:#fef2f2;border-radius:6px';
  box.textContent = message;
  root.appendChild(box);
}

function currentEmbedMode(): string | null {
  return new URLSearchParams(window.location.search).get('embedMode');
}

/**
 * parentOrigin 白名单解析（宿主注入面，严禁 '*'）：
 *① window.__TAPRINT_DESIGNER_CONFIG__.parentOrigin（宿主文档注入，如
 * WPF AddScriptToExecuteOnDocumentCreated / 同源预置）；
 *② iframe URL query parentOrigin=<origin> 兜底——URL 由宿主拼接，origin 即宿主自身
 * origin（宿主控制 URL，无伪造面；浏览器跨文档导航会替换 window，本地注入在 iframe
 * 通道无法可靠先于应用脚本生效，故保留②）。
 * 两者等价可信：origin 白名单只是纵深防御，信任锚是 HMAC token（威胁模型）。
 */
function resolveParentOrigin(): string | undefined {
  const injected = window.__TAPRINT_DESIGNER_CONFIG__?.parentOrigin;
  const fromQuery = new URLSearchParams(window.location.search).get('parentOrigin') ?? undefined;
  return injected || fromQuery;
}

/**
 * embed 启动（init 序列）：origin 校验 → token 注入 → 注册宿主监听 →
 * 挂载 store/UI → ready 上报。web-iframe 缺 parentOrigin 配置拒绝启动消息层。
 */
export async function startEmbed(selector: string): Promise<void> {
  resetEmbedState();
  const root = document.querySelector(selector);
  if (!root) {
    throw new Error(`designer embed: root element "${selector}" not found`);
  }
  const configOrigin = resolveParentOrigin();
  if (currentEmbedMode() === 'web-iframe' && (!configOrigin || configOrigin === '*')) {
    renderFatal(
      root,
      '宿主配置缺失：parentOrigin 未注入（__TAPRINT_DESIGNER_CONFIG__ 或 iframe URL query），消息层拒绝启动（严禁 "*"，设计契约）',
    );
    return;
  }
  // webview 桥（WPF/Flutter）无 origin 语义，占位取自身 origin；防伪造由 HMAC 承担
  const parentOrigin = configOrigin || window.location.origin;

  try {
    await awaitTokenInjection(parentOrigin);
  } catch {
    renderFatal(root, '会话 token 注入超时（10s）：请确认宿主已按 注入 __TAPRINT_TOKEN__');
    return;
  }

  // token 就绪 → 注册宿主消息监听（先于 store 实例化）
  initHostBridge({ parentOrigin, getToken: () => window.__TAPRINT_TOKEN__ });
  unbindHostMessages = onMessageFromHost((msg) => handleHostMessage(storeRef(), msg));

  const pinia = createPinia();
  const store = useDesignerStore(pinia);
  storeRefImpl = store;
  stopDirtyWatch = watchStoreDirty(store);

  app = createApp(EmbedApp).use(pinia);
  app.mount(root);

  embedState.status = store.dsl ? 'connected' : 'waiting-host';
  embedState.tokenStatus = 'healthy';
  postMessageToHost({ type: 'ready' });
  // 宿主 ：ready 后启动 token 主动监控（60s 周期 check + TTL 90% 阈值）
  startTokenExpiryWatch();
}

/** SDK destroy：卸载监听与应用（window.TaprintDesigner.destroy） */
export function destroyEmbed(): void {
  stopTokenListeners();
  resetTokenMonitor();
  stopDirtyWatch?.();
  stopDirtyWatch = null;
  unbindHostMessages?.();
  unbindHostMessages = null;
  clearSaveReceiptTimer();
  clearPreviewReceiptTimer();
  clearPrintReceiptTimer();
  app?.unmount();
  app = null;
  storeRefImpl = null;
  resetHostBridge();
  resetEmbedState();
}
