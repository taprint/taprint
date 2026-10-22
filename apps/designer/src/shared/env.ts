// SPDX-License-Identifier: Apache-2.0
// 仓库环境变量约定（Vite `VITE_*`，经 import.meta.env 读取）。
//
// 真实接线首立此约定（仓内此前无 import.meta.env 先例）：
// `VITE_SESSION_API_BASE` = 后端 origin（如 `http://localhost:8866`，不带 `/admin` 后缀——
// `/admin` 前缀属模板 API 契约 锁定的端点路径常量本身，见 shared/session-api.ts 与
// template-domain/fetch-repository.ts）。
//
// 切换语义：
// - 有值 → session 走 fetch transport（full 模式 bootstrap 注入）+ 模板 Repository 走
// fetch 实现（真实后端，模板 API 契约 端点）；
// - 缺省/空 → 保持 mock transport + 内存 Repository（测试与离线缺省，既有语义不变，
// mock 保留为测试缺省，不破坏既有基线）。
export const API_BASE_ENV_KEY = 'VITE_SESSION_API_BASE';

/**
 * 读取 API base（origin 前缀）。空串/空白/非字符串一律归一为 null（= 缺省 mock 语义）。
 * 尾部斜杠剥除（容错 `http://host:8866/`）。env 可注入便于单测（缺省读 import.meta.env）。
 */
export function resolveApiBase(
  env: Record<string, unknown> | undefined = import.meta.env,
): string | null {
  const raw = env?.[API_BASE_ENV_KEY];
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().replace(/\/+$/, '');
  return trimmed.length > 0 ? trimmed : null;
}
