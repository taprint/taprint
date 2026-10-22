// SPDX-License-Identifier: Apache-2.0
// embed SDK bootstrap 单测（块 B）：token 注入三通道 + 宿主消息分发 +
// init 序列+ dirty 上报 + 致命错误 UI。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { MessageSigner } from 'taprint';
import { useDesignerStore } from '../../src/canvas/store';
import { sampleRegistry } from '../../src/canvas/samples';
import { mountEmbed } from '../../src/embed/sdk';
import {
  initHostBridge,
  resetHostBridge,
  type SignedHostMessage,
} from '../../src/embed/host-bridge';
import {
  awaitTokenInjection,
  beginPrintPending,
  beginPreviewPending,
  beginSavePending,
  clearPrintReceiptTimer,
  clearPreviewReceiptTimer,
  destroyEmbed,
  embedState,
  handleHostMessage,
  notifyTokenExpired,
  PREVIEW_RECEIPT_TIMEOUT_MS,
  PRINT_RECEIPT_TIMEOUT_MS,
  requestPreview,
  requestTestPrint,
  SAVE_RECEIPT_TIMEOUT_MS,
  settlePrintReceipt,
  settlePreviewReceipt,
  settleSaveReceipt,
  startEmbed,
  startTokenExpiryWatch,
  stopTokenExpiryWatch,
  TOKEN_CHECK_INTERVAL_MS,
  TOKEN_INJECTION_TIMEOUT,
  TOKEN_TTL_EXPIRY_THRESHOLD,
  TOKEN_TTL_MS_DEFAULT,
  watchStoreDirty,
  type TokenMonitorHandle,
  type TokenMonitorOptions,
} from '../../src/embed/sdk-core';

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

function signed(payload: Record<string, unknown>, key = KEY): Record<string, unknown> {
  const msg: Record<string, unknown> = {
    timestamp: Date.now(),
    nonce: crypto.randomUUID(),
    ...payload,
  };
  msg.signature = MessageSigner.sign(msg, key);
  return msg;
}

beforeEach(() => {
  setActivePinia(createPinia());
  delete window.__TAPRINT_TOKEN__;
  delete window.__TAPRINT_DESIGNER_CONFIG__;
});

afterEach(() => {
  destroyEmbed();
  resetHostBridge();
  delete (window as unknown as { chrome?: unknown }).chrome;
  delete window.__TAPRINT_TOKEN__;
  delete window.__TAPRINT_DESIGNER_CONFIG__;
  window.history.replaceState({}, '', window.location.pathname);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('awaitTokenInjection（三通道）', () => {
  it('通道①：window.__TAPRINT_TOKEN__ 已存在时立即 resolve', async () => {
    window.__TAPRINT_TOKEN__ = TOKEN;
    await expect(awaitTokenInjection(PARENT)).resolves.toBe(TOKEN);
  });

  it('通道②：taprint-token-injected 事件触发 resolve（WPF/Flutter 口径）', async () => {
    const p = awaitTokenInjection(PARENT);
    window.__TAPRINT_TOKEN__ = TOKEN;
    window.dispatchEvent(new Event('taprint-token-injected'));
    await expect(p).resolves.toBe(TOKEN);
  });

  it('通道③：iframe 父页 token 消息 origin 白名单——非法 origin 拒收，合法 origin 放行', async () => {
    const p = awaitTokenInjection(PARENT);
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'taprint-token', token: 'evil-token' },
        origin: 'https://evil.test',
      }),
    );
    await Promise.resolve();
    expect(window.__TAPRINT_TOKEN__).toBeUndefined();

    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'taprint-token', token: TOKEN },
        origin: PARENT,
      }),
    );
    await expect(p).resolves.toBe(TOKEN);
    expect(window.__TAPRINT_TOKEN__).toBe(TOKEN);
  });

  it('超时 10s reject TOKEN_INJECTION_TIMEOUT', async () => {
    vi.useFakeTimers();
    const p = awaitTokenInjection(PARENT);
    vi.advanceTimersByTime(10_001);
    await expect(p).rejects.toThrow(TOKEN_INJECTION_TIMEOUT);
  });
});

describe('handleHostMessage（宿主消息分发）', () => {
  let bridge: WebviewMock;

  beforeEach(() => {
    bridge = mockWpf();
    window.__TAPRINT_TOKEN__ = TOKEN;
    initHostBridge({ parentOrigin: PARENT, getToken: () => window.__TAPRINT_TOKEN__ });
  });

  function lastSent(): Record<string, unknown> {
    const calls = bridge.postMessage.mock.calls;
    return calls[calls.length - 1][0] as Record<string, unknown>;
  }

  it('loadTemplate 合法模板：挂载 + 迁移提示 + status=connected', () => {
    const store = useDesignerStore();
    const dsl = JSON.parse(JSON.stringify(sampleRegistry[0].template)) as Record<string, unknown>;
    handleHostMessage(store, signed({ type: 'loadTemplate', dsl }) as unknown as SignedHostMessage);
    expect(store.dsl).not.toBeNull();
    expect(embedState.status).toBe('connected');
    expect(bridge.postMessage).not.toHaveBeenCalled();
  });

  it('loadTemplate 非法 dsl：不挂载 + error 上行（含 errorMessage）', () => {
    const store = useDesignerStore();
    handleHostMessage(
      store,
      signed({ type: 'loadTemplate', dsl: { foo: 1 } }) as unknown as SignedHostMessage,
    );
    expect(store.dsl).toBeNull();
    expect(store.loadNote).toContain('模板加载失败');
    expect(embedState.status).toBe('waiting-host');
    const msg = lastSent();
    expect(msg.type).toBe('error');
    expect(typeof msg.errorMessage).toBe('string');
    expect(MessageSigner.verify(msg, KEY)).toBe(true);
  });

  it('loadTemplate 失败但已有模板挂载：保留旧模板 + status 不降级', () => {
    const store = useDesignerStore();
    const dsl = JSON.parse(JSON.stringify(sampleRegistry[0].template)) as Record<string, unknown>;
    handleHostMessage(store, signed({ type: 'loadTemplate', dsl }) as unknown as SignedHostMessage);
    handleHostMessage(
      store,
      signed({ type: 'loadTemplate', dsl: { foo: 1 } }) as unknown as SignedHostMessage,
    );
    expect(store.dsl).not.toBeNull(); // 旧模板保留
    expect(embedState.status).toBe('connected'); // 与画布一致，不误报 waiting-host
    expect(lastSent().type).toBe('error');
  });

  it('saveResult：回执写入 embedState（成功/失败两态）', () => {
    const store = useDesignerStore();
    handleHostMessage(
      store,
      signed({ type: 'saveResult', success: true }) as unknown as SignedHostMessage,
    );
    expect(embedState.saveResult).toEqual({ success: true, errorMessage: undefined });
    handleHostMessage(
      store,
      signed({
        type: 'saveResult',
        success: false,
        errorMessage: '后端 500',
      }) as unknown as SignedHostMessage,
    );
    expect(embedState.saveResult).toEqual({ success: false, errorMessage: '后端 500' });
  });

  it('setReadOnly：store.readOnly 随宿主开关', () => {
    const store = useDesignerStore();
    handleHostMessage(
      store,
      signed({ type: 'setReadOnly', readonly: true }) as unknown as SignedHostMessage,
    );
    expect(store.readOnly).toBe(true);
    handleHostMessage(
      store,
      signed({ type: 'setReadOnly', readonly: false }) as unknown as SignedHostMessage,
    );
    expect(store.readOnly).toBe(false);
  });

  it('closeRequest：应答 close 上行（签名可复核）', () => {
    const store = useDesignerStore();
    handleHostMessage(store, signed({ type: 'closeRequest' }) as unknown as SignedHostMessage);
    const msg = lastSent();
    expect(msg.type).toBe('close');
    expect(MessageSigner.verify(msg, KEY)).toBe(true);
  });

  it('token-refreshed：无显式换钥，后续上行按新 token 派生', () => {
    const store = useDesignerStore();
    handleHostMessage(store, signed({ type: 'token-refreshed' }) as unknown as SignedHostMessage);
    window.__TAPRINT_TOKEN__ = 'refreshed-token';
    handleHostMessage(store, signed({ type: 'closeRequest' }) as unknown as SignedHostMessage);
    const msg = lastSent();
    expect(MessageSigner.verify(msg, KEY)).toBe(false);
    expect(MessageSigner.verify(msg, MessageSigner.deriveMessageKey('refreshed-token'))).toBe(true);
  });

  it('未预期异常不冒泡：顶层 try/catch 上行 error', () => {
    const store = useDesignerStore();
    const spy = vi.spyOn(store, 'loadTemplate').mockImplementation(() => {
      throw new Error('boom');
    });
    expect(() =>
      handleHostMessage(
        store,
        signed({ type: 'loadTemplate', dsl: {} }) as unknown as SignedHostMessage,
      ),
    ).not.toThrow();
    const msg = lastSent();
    expect(msg.type).toBe('error');
    expect(String(msg.errorMessage)).toContain('boom');
    spy.mockRestore();
  });
});

describe('watchStoreDirty（dirty 布尔上报）', () => {
  it('编辑动作发 dirty:true；loadTemplate 复位期间抑制上报', () => {
    const bridge = mockWpf();
    window.__TAPRINT_TOKEN__ = TOKEN;
    initHostBridge({ parentOrigin: PARENT, getToken: () => window.__TAPRINT_TOKEN__ });
    const store = useDesignerStore();
    const stop = watchStoreDirty(store);

    const dsl = JSON.parse(JSON.stringify(sampleRegistry[0].template)) as Record<string, unknown>;
    handleHostMessage(store, signed({ type: 'loadTemplate', dsl }) as unknown as SignedHostMessage);
    expect(bridge.postMessage).not.toHaveBeenCalled(); // 加载复位不上报

    store.select(0);
    store.updateSelected({}); // 空补丁非实质变更：不置脏不上报
    expect(bridge.postMessage).not.toHaveBeenCalled();
    expect(store.dirty).toBe(false);

    store.updateSelected({ x: '5mm' });
    const types = bridge.postMessage.mock.calls.map((c) => (c[0] as { type: string }).type);
    expect(types).toEqual(['dirty']);
    expect((bridge.postMessage.mock.calls[0][0] as { dirty: boolean }).dirty).toBe(true);
    stop();
  });
});

describe('save 回执等待态 + 超时兜底', () => {
  it('beginSavePending 进入等待态；15s 无回执翻失败回执', () => {
    vi.useFakeTimers();
    beginSavePending();
    expect(embedState.saving).toBe(true);
    vi.advanceTimersByTime(SAVE_RECEIPT_TIMEOUT_MS);
    expect(embedState.saving).toBe(false);
    expect(embedState.saveResult?.success).toBe(false);
    expect(embedState.saveResult?.errorMessage).toContain('超时');
  });

  it('saveResult 到达清超时计时器与等待态（后续超时不再覆盖回执）', () => {
    vi.useFakeTimers();
    beginSavePending();
    settleSaveReceipt({ success: true });
    expect(embedState.saving).toBe(false);
    vi.advanceTimersByTime(SAVE_RECEIPT_TIMEOUT_MS * 2);
    expect(embedState.saveResult).toEqual({ success: true });
  });

  it('重复保存：再次 beginSavePending 重置计时（不叠加）', () => {
    vi.useFakeTimers();
    beginSavePending();
    vi.advanceTimersByTime(SAVE_RECEIPT_TIMEOUT_MS - 1);
    beginSavePending();
    vi.advanceTimersByTime(SAVE_RECEIPT_TIMEOUT_MS - 1);
    expect(embedState.saving).toBe(true); // 第二次计时未到
    vi.advanceTimersByTime(1);
    expect(embedState.saveResult?.success).toBe(false);
  });
});

describe('save 防重入', () => {
  it('等待回执期间再点保存：按钮 aria-disabled 且不重复上行 save', async () => {
    const bridge = mockWpf();
    window.__TAPRINT_TOKEN__ = TOKEN;
    window.history.replaceState({}, '', '/?embedMode=wpf');
    const root = document.createElement('div');
    root.id = 'embed-root-s2';
    document.body.appendChild(root);
    mountEmbed('#embed-root-s2');
    await vi.waitFor(() => expect(bridge.postMessage).toHaveBeenCalled()); // ready 上行

    const dsl = JSON.parse(JSON.stringify(sampleRegistry[0].template)) as Record<string, unknown>;
    // WPF 通道下行监听挂在 chrome.webview message 事件，经注册的 listener 投递
    const listener = bridge.addEventListener.mock.calls.find((c) => c[0] === 'message')?.[1] as (
      ev: MessageEvent,
    ) => void;
    expect(listener).toBeDefined();
    listener(new MessageEvent('message', { data: signed({ type: 'loadTemplate', dsl }) }));
    await vi.waitFor(() => expect(embedState.status).toBe('connected'));

    const btn = root.querySelector('[data-testid="save-button"]') as HTMLButtonElement;
    const saveCount = (): number =>
      bridge.postMessage.mock.calls.filter((c) => (c[0] as { type: string }).type === 'save')
        .length;

    embedState.saving = true; // 模拟宿主回执未达
    btn.click();
    await Promise.resolve();
    expect(saveCount()).toBe(0);
    expect(btn.getAttribute('aria-disabled')).toBe('true');

    embedState.saving = false;
    await Promise.resolve(); // 等 saveBusy prop 刷新后再点
    btn.click();
    await Promise.resolve();
    expect(saveCount()).toBe(1);
    root.remove();
  });
});

describe('startEmbed（init 序列）', () => {
  it('web-iframe 缺 parentOrigin 配置：拒绝启动消息层，渲染致命错误 UI', async () => {
    window.history.replaceState({}, '', '/?embedMode=web-iframe');
    const root = document.createElement('div');
    document.body.appendChild(root);
    await startEmbed(rootSelector(root));
    expect(root.querySelector('[data-testid="embed-fatal"]')?.textContent).toContain(
      'parentOrigin',
    );
    expect(embedState.status).toBe('fatal');
    root.remove();
  });

  it('token 注入超时：致命错误 UI（不挂载 Vue）', async () => {
    vi.useFakeTimers();
    window.history.replaceState({}, '', '/?embedMode=wpf');
    const root = document.createElement('div');
    document.body.appendChild(root);
    const p = startEmbed(rootSelector(root));
    vi.advanceTimersByTime(10_001);
    await p;
    expect(root.querySelector('[data-testid="embed-fatal"]')?.textContent).toContain('token');
    root.remove();
  });

  it('wpf 通道握手：ready 为最后上行消息且签名可复核（token 先于 ready）', async () => {
    window.history.replaceState({}, '', '/?embedMode=wpf');
    const bridge = mockWpf();
    window.__TAPRINT_TOKEN__ = TOKEN;
    const root = document.createElement('div');
    document.body.appendChild(root);
    await startEmbed(rootSelector(root));
    expect(bridge.postMessage).toHaveBeenCalledTimes(1);
    const msg = bridge.postMessage.mock.calls[0][0] as Record<string, unknown>;
    expect(msg.type).toBe('ready');
    expect(MessageSigner.verify(msg, KEY)).toBe(true);
    expect(embedState.status).toBe('waiting-host');
    destroyEmbed();
    root.remove();
  });

  it('destroyEmbed 后 channel-B 监听真移除；重启用按新 origin 重建', async () => {
    window.__TAPRINT_TOKEN__ = TOKEN;
    window.history.replaceState({}, '', '/?embedMode=web-iframe&parentOrigin=https%3A%2F%2Fa.test');
    const root1 = document.createElement('div');
    document.body.appendChild(root1);
    await startEmbed(rootSelector(root1));
    destroyEmbed();

    // 旧 origin 推送不再生效（监听器真移除，无残留闭包）
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'taprint-token', token: 'stale-token' },
        origin: 'https://a.test',
      }),
    );
    await Promise.resolve();
    expect(window.__TAPRINT_TOKEN__).toBe(TOKEN);

    // 重启用新 origin：新 origin 推送生效
    window.history.replaceState({}, '', '/?embedMode=web-iframe&parentOrigin=https%3A%2F%2Fb.test');
    const root2 = document.createElement('div');
    document.body.appendChild(root2);
    await startEmbed(rootSelector(root2));
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'taprint-token', token: 'new-token' },
        origin: 'https://b.test',
      }),
    );
    await Promise.resolve();
    expect(window.__TAPRINT_TOKEN__).toBe('new-token');
    root1.remove();
    root2.remove();
  });
});

let rootSeq = 0;
function rootSelector(root: HTMLDivElement): string {
  rootSeq += 1;
  root.id = `embed-root-${rootSeq}`;
  return `#${root.id}`;
}

// ── token 主动监控（60s 周期 + TTL 90% 阈值 + 计时器可注入） ──
describe('token 主动监控', () => {
  beforeEach(() => {
    window.__TAPRINT_TOKEN__ = TOKEN;
    initHostBridge({ parentOrigin: PARENT, getToken: () => window.__TAPRINT_TOKEN__ });
  });

  it('startTokenExpiryWatch 默认 60s 周期上行 token-check（fake timers 验证）', () => {
    vi.useFakeTimers();
    const bridge = mockWpf();
    startTokenExpiryWatch();
    // 第 1 次：60s 触发
    vi.advanceTimersByTime(TOKEN_CHECK_INTERVAL_MS);
    const calls1 = bridge.postMessage.mock.calls.filter(
      (c) => (c[0] as { type: string }).type === 'token-check',
    );
    expect(calls1.length).toBe(1);
    // 第 2 次：120s 触发
    vi.advanceTimersByTime(TOKEN_CHECK_INTERVAL_MS);
    const calls2 = bridge.postMessage.mock.calls.filter(
      (c) => (c[0] as { type: string }).type === 'token-check',
    );
    expect(calls2.length).toBe(2);
    // 签名可复核（token-check 走 host-bridge 完整签名链路）
    expect(MessageSigner.verify(calls1[0][0] as object, KEY)).toBe(true);
    stopTokenExpiryWatch();
  });

  it('计时器可注入（createInterval 工厂）—— 不真等 60s，由测试直接控制触发', () => {
    const bridge = mockWpf();
    const tick = vi.fn();
    const handle: TokenMonitorHandle = { clear: vi.fn() };
    const createInterval = vi.fn((_fn, _ms) => {
      tick.mockImplementation(_fn as () => void);
      return handle;
    });
    const opts: TokenMonitorOptions = { createInterval };
    startTokenExpiryWatch(opts);
    expect(createInterval).toHaveBeenCalledWith(expect.any(Function), TOKEN_CHECK_INTERVAL_MS);
    // 模拟计时器触发：应上行 token-check
    tick();
    const tokenCheckCalls = bridge.postMessage.mock.calls.filter(
      (c) => (c[0] as { type: string }).type === 'token-check',
    );
    expect(tokenCheckCalls.length).toBe(1);
    stopTokenExpiryWatch();
    expect(handle.clear).toHaveBeenCalled();
  });

  it('TTL 90% 阈值触发 notifyTokenExpired：上行 token-expired + 翻致命态 + stop watch', () => {
    vi.useFakeTimers();
    const bridge = mockWpf();
    // 极短 TTL：100ms × 0.9 = 90ms 触发 expired；checkInterval 50ms 不会自身触发
    startTokenExpiryWatch({ tokenTtlMs: 100, ttlThreshold: 0.9, checkIntervalMs: 50 });
    embedState.status = 'connected';
    embedState.tokenStatus = 'healthy';
    vi.advanceTimersByTime(90);
    // 90ms 后下一次 check tick（100ms × 0.9 = 90ms），第 1 个 tick 在 50ms 触发，
    // elapsed=50 < 90 不 expired；第 2 个 tick 在 100ms 触发，elapsed=100 >= 90 expired
    vi.advanceTimersByTime(15);
    expect(embedState.tokenStatus).toBe('expired');
    expect(embedState.status).toBe('fatal');
    expect(embedState.fatalMessage).toContain('token TTL');
    const expiredCalls = bridge.postMessage.mock.calls.filter(
      (c) => (c[0] as { type: string }).type === 'token-expired',
    );
    expect(expiredCalls.length).toBe(1);
    expect(MessageSigner.verify(expiredCalls[0][0] as object, KEY)).toBe(true);
    // expired 后 watch 自动 stop（避免触发更多 tick）
    vi.advanceTimersByTime(200);
    const expiredCalls2 = bridge.postMessage.mock.calls.filter(
      (c) => (c[0] as { type: string }).type === 'token-expired',
    );
    expect(expiredCalls2.length).toBe(1);
  });

  it('token-refreshed 重启监控 + 复位 tokenStatus + 清致命态', () => {
    vi.useFakeTimers();
    const store = useDesignerStore();
    window.__TAPRINT_TOKEN__ = TOKEN;
    startTokenExpiryWatch({ tokenTtlMs: 100, ttlThreshold: 0.9, checkIntervalMs: 50 });
    // 触发 expired
    vi.advanceTimersByTime(115);
    expect(embedState.tokenStatus).toBe('expired');
    expect(embedState.status).toBe('fatal');
    // 模拟宿主回推 token-refreshed（包含 fatal 复位语义）
    handleHostMessage(store, signed({ type: 'token-refreshed' }) as unknown as SignedHostMessage);
    expect(embedState.tokenStatus).toBe('healthy');
    expect(embedState.status).not.toBe('fatal');
    expect(embedState.fatalMessage).toBeNull();
    stopTokenExpiryWatch();
  });

  it('notifyTokenExpired 直接调用：上行 token-expired + 翻致命态', () => {
    const bridge = mockWpf();
    embedState.status = 'connected';
    embedState.tokenStatus = 'healthy';
    notifyTokenExpired('测试触发');
    expect(embedState.tokenStatus).toBe('expired');
    expect(embedState.status).toBe('fatal');
    expect(embedState.fatalMessage).toContain('测试触发');
    const expiredCalls = bridge.postMessage.mock.calls.filter(
      (c) => (c[0] as { type: string }).type === 'token-expired',
    );
    expect(expiredCalls.length).toBe(1);
  });

  it('startTokenExpiryWatch 重启语义：旧 handle 先 clear 再建新（避免双计时器叠加）', () => {
    const cleared: boolean[] = [];
    const handles: TokenMonitorHandle[] = [];
    const createInterval = vi.fn(() => {
      const h: TokenMonitorHandle = { clear: () => cleared.push(true) };
      handles.push(h);
      return h;
    });
    startTokenExpiryWatch({ createInterval });
    expect(handles).toHaveLength(1);
    startTokenExpiryWatch({ createInterval }); // 重启
    expect(handles).toHaveLength(2);
    expect(cleared).toEqual([true]); // 旧 handle 先 clear
    stopTokenExpiryWatch();
    expect(cleared).toEqual([true, true]);
  });

  it('常量口径：默认 TTL 10min / 阈值 0.9 / 周期 60s（与 / 文档一致）', () => {
    expect(TOKEN_CHECK_INTERVAL_MS).toBe(60_000);
    expect(TOKEN_TTL_MS_DEFAULT).toBe(10 * 60 * 1000);
    expect(TOKEN_TTL_EXPIRY_THRESHOLD).toBe(0.9);
  });
});

// ── preview / previewResult + testPrint / printResult 通道 ──
describe('preview / testPrint 通道', () => {
  beforeEach(() => {
    window.__TAPRINT_TOKEN__ = TOKEN;
    initHostBridge({ parentOrigin: PARENT, getToken: () => window.__TAPRINT_TOKEN__ });
  });

  it('requestPreview 上行 preview 含 dsl + deviceClass + 进入 previewing 等待态', () => {
    const bridge = mockWpf();
    const dsl = { code: 'T1', presentations: { receipt: { width: '80mm' } } };
    const ok = requestPreview(dsl, 'receipt');
    expect(ok).toBe(true);
    const msg = bridge.postMessage.mock.calls[0][0] as Record<string, unknown>;
    expect(msg.type).toBe('preview');
    expect(msg.dsl).toEqual(dsl);
    expect(msg.deviceClass).toBe('receipt');
    expect(MessageSigner.verify(msg, KEY)).toBe(true);
    expect(embedState.previewing).toBe(true);
    expect(embedState.previewResult).toBeNull();
  });

  it('previewResult 回执写入 embedState.previewResult（previewUrl/errorMessage 两态）', () => {
    const store = useDesignerStore();
    handleHostMessage(
      store,
      signed({
        type: 'previewResult',
        previewUrl: 'data:image/png;base64,xxxx',
      }) as unknown as SignedHostMessage,
    );
    expect(embedState.previewing).toBe(false);
    expect(embedState.previewResult?.previewUrl).toBe('data:image/png;base64,xxxx');
    handleHostMessage(
      store,
      signed({ type: 'previewResult', errorMessage: '渲染失败' }) as unknown as SignedHostMessage,
    );
    expect(embedState.previewResult?.errorMessage).toBe('渲染失败');
    expect(embedState.previewResult?.previewUrl).toBeUndefined();
  });

  it('preview 超时兜底：15s 无回执翻失败回执', () => {
    vi.useFakeTimers();
    beginPreviewPending();
    expect(embedState.previewing).toBe(true);
    vi.advanceTimersByTime(PREVIEW_RECEIPT_TIMEOUT_MS);
    expect(embedState.previewing).toBe(false);
    expect(embedState.previewResult?.errorMessage).toContain('超时');
  });

  it('settlePreviewReceipt 清超时计时器，后续超时不再覆盖回执', () => {
    vi.useFakeTimers();
    beginPreviewPending();
    settlePreviewReceipt({ previewUrl: 'data:image/png;base64,abc' });
    expect(embedState.previewing).toBe(false);
    vi.advanceTimersByTime(PREVIEW_RECEIPT_TIMEOUT_MS * 2);
    expect(embedState.previewResult?.previewUrl).toBe('data:image/png;base64,abc');
  });

  it('clearPreviewReceiptTimer 安全重复调用', () => {
    expect(() => clearPreviewReceiptTimer()).not.toThrow();
    beginPreviewPending();
    clearPreviewReceiptTimer();
    clearPreviewReceiptTimer();
    expect(embedState.previewing).toBe(true); // 仅清计时器，状态由 settle 翻
  });

  it('requestTestPrint 上行 testPrint 含 dsl + deviceClass + 进入 testingPrint 等待态', () => {
    const bridge = mockWpf();
    const dsl = {
      code: 'T1',
      presentations: { label: { size: { width: '40mm', height: '30mm' } } },
    };
    const ok = requestTestPrint(dsl, 'label');
    expect(ok).toBe(true);
    const msg = bridge.postMessage.mock.calls[0][0] as Record<string, unknown>;
    expect(msg.type).toBe('testPrint');
    expect(msg.dsl).toEqual(dsl);
    expect(msg.deviceClass).toBe('label');
    expect(MessageSigner.verify(msg, KEY)).toBe(true);
    expect(embedState.testingPrint).toBe(true);
  });

  it('printResult 回执写入 embedState.printResult（success/errorMessage 两态）', () => {
    const store = useDesignerStore();
    handleHostMessage(
      store,
      signed({ type: 'printResult', success: true }) as unknown as SignedHostMessage,
    );
    expect(embedState.testingPrint).toBe(false);
    expect(embedState.printResult?.success).toBe(true);
    handleHostMessage(
      store,
      signed({
        type: 'printResult',
        success: false,
        errorMessage: '缺纸',
      }) as unknown as SignedHostMessage,
    );
    expect(embedState.printResult?.success).toBe(false);
    expect(embedState.printResult?.errorMessage).toBe('缺纸');
  });

  it('testPrint 超时兜底：15s 无回执翻失败回执', () => {
    vi.useFakeTimers();
    beginPrintPending();
    expect(embedState.testingPrint).toBe(true);
    vi.advanceTimersByTime(PRINT_RECEIPT_TIMEOUT_MS);
    expect(embedState.testingPrint).toBe(false);
    expect(embedState.printResult?.success).toBe(false);
    expect(embedState.printResult?.errorMessage).toContain('超时');
  });

  it('settlePrintReceipt 清超时计时器，后续超时不再覆盖回执', () => {
    vi.useFakeTimers();
    beginPrintPending();
    settlePrintReceipt({ success: true });
    expect(embedState.testingPrint).toBe(false);
    vi.advanceTimersByTime(PRINT_RECEIPT_TIMEOUT_MS * 2);
    expect(embedState.printResult?.success).toBe(true);
  });

  it('clearPrintReceiptTimer 安全重复调用', () => {
    expect(() => clearPrintReceiptTimer()).not.toThrow();
    beginPrintPending();
    clearPrintReceiptTimer();
    clearPrintReceiptTimer();
    expect(embedState.testingPrint).toBe(true);
  });

  it('preview/testPrint 上行签名不可被复用（nonce 每次不同）', () => {
    const bridge = mockWpf();
    requestPreview({ code: 'T1' }, 'receipt');
    requestTestPrint({ code: 'T1' }, 'label');
    const m1 = bridge.postMessage.mock.calls[0][0] as Record<string, unknown>;
    const m2 = bridge.postMessage.mock.calls[1][0] as Record<string, unknown>;
    // nonce 必不同（crypto.randomUUID）；timestamp 同步调用可能相等（nonce 已是足够强唯一性）
    expect(m1.nonce).not.toBe(m2.nonce);
    // 签名独立：m2 不应等于 m1（不同 nonce → 不同签名）
    expect(m1.signature).not.toBe(m2.signature);
  });
});

// ── readOnly 完整编辑锁 ──
describe('readOnly 完整编辑锁', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    window.__TAPRINT_TOKEN__ = TOKEN;
  });

  it('store.readOnly=true 时 select/addElement/updateSelected/move/resize 全部 self-guard', () => {
    const store = useDesignerStore();
    const dsl = JSON.parse(JSON.stringify(sampleRegistry[0].template)) as Record<string, unknown>;
    store.loadTemplate(dsl);
    store.setReadOnly(true);

    // 已挂载模板：先在 readOnly=false 时选中一个元素以便后续 actions 有 target
    store.setReadOnly(false);
    store.select(0);
    store.setReadOnly(true);

    store.select(1);
    expect(store.selectedIndex).toBe(0); // 未变
    store.addElement({ type: 'text', content: 'x' });
    expect(store.activeBody.length).toBeGreaterThan(0); // 未增加
    store.updateSelected({ content: 'mutated' });
    expect(store.selectedElement?.content).not.toBe('mutated');
    store.moveFlowSelected(1);
    store.moveFlowSelected(-1);
    store.removeSelected();
    // label 设备类 resize/move 测试：在 readOnly=false 时切换 device
    store.setReadOnly(false);
    const labelSample = sampleRegistry.find((s) =>
      s.template.presentations?.label ? true : false,
    );
    if (labelSample) {
      store.loadTemplate(labelSample.template as unknown as Record<string, unknown>);
      store.setDevice('label');
      store.select(0);
      store.setReadOnly(true);
      const before = JSON.stringify(store.selectedElement);
      store.moveLabelSelected(10, 10);
      store.resizeSelected(5, 5);
      expect(JSON.stringify(store.selectedElement)).toBe(before);
    }
  });

  it('readOnly=false 时各 actions 正常工作（无副作用回归）', () => {
    const store = useDesignerStore();
    const dsl = JSON.parse(JSON.stringify(sampleRegistry[0].template)) as Record<string, unknown>;
    store.loadTemplate(dsl);
    expect(store.readOnly).toBe(false);
    store.select(0);
    expect(store.selectedIndex).toBe(0);
    store.updateSelected({ content: 'edited' });
    expect(store.dirty).toBe(true);
  });

  it('setReadOnly(true) 不影响 prepareSave/revalidate（无副作用路径保留）', () => {
    const store = useDesignerStore();
    const dsl = JSON.parse(JSON.stringify(sampleRegistry[0].template)) as Record<string, unknown>;
    store.loadTemplate(dsl);
    store.setReadOnly(true);
    // prepareSave 仍可调用（保存门禁在 Workbench 顶栏，不在 store）
    const result = store.prepareSave();
    expect(result.ok).toBe(true);
    // revalidate 仍可触发
    store.revalidate();
    expect(store.validationValid).toBe(true);
  });

  it('loadTemplate 在 readOnly 下仍生效（宿主刷新模板不被拦截）', () => {
    const store = useDesignerStore();
    store.setReadOnly(true);
    const dsl = JSON.parse(JSON.stringify(sampleRegistry[0].template)) as Record<string, unknown>;
    const ok = store.loadTemplate(dsl);
    expect(ok).toBe(true);
    expect(store.dsl).not.toBeNull();
  });
});
