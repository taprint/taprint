// SPDX-License-Identifier: Apache-2.0
// list_examples 工具：返回包内精选 6 个模板（收据/价签/A4 各二），
// 含模板全文（examples/ 资产由 scripts/sync-assets.mjs 从仓内权威 fixtures 同步）。
import { loadExamples } from '../lib/assets.ts';

export interface ExampleEntry {
  name: string;
  code: string;
  schemaVersion: string;
  category: 'receipt' | 'label' | 'a4';
  file: string;
  template: Record<string, unknown>;
}

export interface ListExamplesOutput {
  count: number;
  examples: ExampleEntry[];
}

export function listExamples(): ListExamplesOutput {
  const examples = loadExamples().map(({ file, category, template }) => ({
    name: String(template.name ?? file),
    code: String(template.code ?? ''),
    schemaVersion: String(template.schemaVersion ?? ''),
    category,
    file,
    template,
  }));
  return { count: examples.length, examples };
}
