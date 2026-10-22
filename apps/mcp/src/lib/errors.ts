// SPDX-License-Identifier: Apache-2.0
// MCP 层错误：工具可预期失败（非法入参、能力外请求）统一带 code 上抛，
// 由 server.ts 映射为 isError:true + 结构化文本，不吞成裸异常。
export class ToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ToolError';
  }
}
