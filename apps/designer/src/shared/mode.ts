// SPDX-License-Identifier: Apache-2.0
// 双模式判定（设计契约）：
// 本地资源主路径是 http://localhost:{port}/index.html?embedMode=wpf，
// 路径不含 /embed——只按路径判定会进 full 模式。规则：query 的 embedMode 优先，
// 无 query 时按路径 /embed 兜底（远程 URL）。
export function useMode(): 'full' | 'embed' {
  const mode = new URLSearchParams(window.location.search).get('embedMode');
  if (mode === 'wpf' || mode === 'flutter' || mode === 'web-iframe') return 'embed';
  return window.location.pathname.endsWith('/embed') ? 'embed' : 'full';
}
