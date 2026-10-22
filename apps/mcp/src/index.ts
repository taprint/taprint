#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// taprint-mcp 入口（ADR-0008 v0.1）：stdio transport，三工具
// validate_template / compile / list_examples；预览与硬件打印不在 v0.1。
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SERVER_INFO, createServer } from './server.ts';

const HELP = `taprint-mcp ${SERVER_INFO.version} — MCP server for the taprint print-template DSL

Usage:
  taprint-mcp            start the MCP server on stdio (for MCP hosts)
  taprint-mcp --help     show this help
  taprint-mcp --version  print the version

Tools:
  validate_template  validate a template JSON (schema + business rules + host-function audit)
  compile            compile template+data to ESC/POS / TSPL / CPCL bytes (base64 + frame summary)
  list_examples      browse the 6 bundled example templates (receipt / label / A4 × 2)

Claude Desktop / Claude Code config (stdio):
  {
    "mcpServers": {
      "taprint": { "command": "npx", "args": ["-y", "taprint-mcp"] }
    }
  }

Notes:
  - Zero hardware access, zero native dependencies (ADR-0008).
  - Preview rasterization (render_preview) arrives in v0.3; physical printing is
    permanently out of scope — hosts print the compiled byte streams themselves.
`;

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  process.stdout.write(HELP);
  process.exit(0);
}
if (process.argv.includes('--version')) {
  process.stdout.write(`${SERVER_INFO.version}\n`);
  process.exit(0);
}

const server = createServer();
await server.connect(new StdioServerTransport());
