// SPDX-License-Identifier: Apache-2.0
import './styles/main.css';

// 双模式入口（设计契约）：
// - full：完整 SPA（history 路由：/、/design/:id、/versions/:id）挂 #app
// - embed：宿主（WPF/Flutter WebView）嵌入，SDK 直挂静态 #designer-root，不经 router
// （SDK 唯一挂载入口；由 bootstrap() 接管）
import { useMode } from './shared/mode';

const mode = useMode();

if (mode === 'embed') {
  const { mountEmbed } = await import('./embed/sdk');
  mountEmbed('#designer-root');
} else {
  // full 模式启动鉴权（挂点：createApp 前消费 URL 一次性 code 换会话 token）
  const { ensureSession } = await import('./full/bootstrap');
  try {
    await ensureSession();

    const { createApp } = await import('vue');
    const { createPinia } = await import('pinia');
    const { default: App } = await import('./full/App.vue');
    const { createFullRouter } = await import('./full/routes');

    createApp(App).use(createPinia()).use(createFullRouter()).mount('#app');
  } catch {
    // AuthRedirectError：兑换失败已引导回源（redirect 即抛），中止挂载
  }
}
