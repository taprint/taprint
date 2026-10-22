// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mountEmbed, sdk } from '../../src/embed/sdk';

// embed 启动链路集成测试：
// 真实 DOM 挂载 mountEmbed，覆盖 main.ts → sdk.ts → sdk-core.startEmbed →
// App.vue → useDesignerStore 全链（token 注入 + 样例兜底 ?fallbackSample=1）。
describe('embed mountEmbed 集成', () => {
  afterEach(() => {
    sdk.destroy();
    document.getElementById('designer-root')?.remove();
    delete window.__TAPRINT_TOKEN__;
    window.history.replaceState({}, '', window.location.pathname);
    vi.restoreAllMocks();
  });

  async function waitFor(selector: () => Element | null): Promise<void> {
    const start = Date.now();
    while (!selector()) {
      if (Date.now() - start > 3000) throw new Error('embed 挂载超时');
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  it('挂载 #designer-root 不抛错，渲染画布 + 三栏面板', async () => {
    window.__TAPRINT_TOKEN__ = 'designer-session-token-fixture';
    window.history.replaceState({}, '', '/?embedMode=wpf&fallbackSample=1');
    const root = document.createElement('div');
    root.id = 'designer-root';
    document.body.appendChild(root);
    expect(() => mountEmbed('#designer-root')).not.toThrow();
    await waitFor(() => root.querySelector('[data-testid="canvas-element"]'));
    expect(root.querySelector('[data-testid="designer-canvas"]')).not.toBeNull();
    expect(root.querySelector('[data-testid="layers-panel"]')).not.toBeNull();
    expect(root.querySelectorAll('[data-testid="canvas-element"]').length).toBeGreaterThan(0);
  });

  it('root 缺失时经 console.error 报明确错误（startEmbed 为异步链路）', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mountEmbed('#no-such-root');
    await vi.waitFor(() => expect(errSpy).toHaveBeenCalled());
    expect(String(errSpy.mock.calls[0][1])).toContain('not found');
  });
});
