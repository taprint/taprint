// SPDX-License-Identifier: Apache-2.0
import axios from 'axios';

// 后端 API 封装（设计契约）
// embed/本地模式页面不直连 API——模板经 HostMessage loadTemplate 下发。
//
// ⚠️ 模块状态：本模块当前**无任何 caller**——模板数据走
// 本地样例 fixture，后端接入（session/code 兑换、template CRUD）排期后续；
// 此处为先行脚手架，避免后续重复搭 axios 实例。
export const api = axios.create({
  baseURL: '/api/print',
  timeout: 10_000,
});

// 端点清单（逐个接入）：
// - template CRUD / versions / publish / rollback / diff
// - field/list?bizType=（字段元数据）
// - preview（预览渲染，渲染器文档口径：只出字节流）
// - designer/session：issue_code / exchange / refresh / check（一次性 code 换 token）
