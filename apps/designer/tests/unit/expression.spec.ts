// SPDX-License-Identifier: Apache-2.0
// 表达式编辑器纯逻辑层单测（暂不支持）：字段候选展平 / 即时诊断 / monaco 语法与
// 补全注册（monaco 以 mock 注入，jsdom 无真实 monaco）。ExpressionEditor.vue 的
// monaco 运行期行为由 e2e 覆盖（jsdom 无布局引擎）。
import { beforeEach, describe, expect, it } from 'vitest';
import type * as MonacoNS from 'monaco-editor';
import { diagnoseExpressionValue } from '../../src/expression/diagnostics';
import { collectFieldSuggestions, filterSuggestions } from '../../src/expression/fieldSuggestion';
import {
  EXPRESSION_LANGUAGE_ID,
  registerDslSyntax,
  registerFieldCompletion,
  resetRegistrationForTest,
} from '../../src/expression/syntax';

const FIXTURE_DSL = {
  version: '2.0',
  dataSources: [
    {
      name: 'order',
      type: 'master',
      schema: { orderNo: 'string', amount: 'number', customer: { name: 'string' } },
    },
    { name: 'items', type: 'detail', schema: { sku: 'string', orderNo: 'string' } },
  ],
  parameters: { diffTotal: 'number', printTime: 'string' },
};

describe('collectFieldSuggestions（字段候选展平）', () => {
  it('master 嵌套展平 + detail 裸路径（不带 [*]）+ parameters，去重排序', () => {
    const list = collectFieldSuggestions(FIXTURE_DSL);
    expect(list.map((s) => s.path)).toEqual([
      'amount',
      'customer.name',
      'diffTotal',
      'orderNo',
      'printTime',
      'sku',
    ]);
    const orderNo = list.find((s) => s.path === 'orderNo');
    expect(orderNo).toEqual({ path: 'orderNo', source: 'order', kind: 'field' }); // 跨源去重留先现
    expect(list.find((s) => s.path === 'diffTotal')).toEqual({
      path: 'diffTotal',
      source: 'parameters',
      kind: 'param',
    });
  });

  it('空输入：null / 无 dataSources / 坏条目全部容错', () => {
    expect(collectFieldSuggestions(null)).toEqual([]);
    expect(collectFieldSuggestions({})).toEqual([]);
    expect(
      collectFieldSuggestions({
        dataSources: [null, { name: 42 }, { name: 'x' }, { name: 'y', schema: 'not-object' }],
      } as unknown as Record<string, unknown>),
    ).toEqual([]);
  });

  it('filterSuggestions 大小写不敏感子串过滤，空前缀返回全量', () => {
    const list = collectFieldSuggestions(FIXTURE_DSL);
    expect(filterSuggestions(list, 'ORD').map((s) => s.path)).toEqual(['orderNo']);
    expect(filterSuggestions(list, 'stomer').map((s) => s.path)).toEqual(['customer.name']);
    expect(filterSuggestions(list, '')).toHaveLength(list.length);
  });
});

describe('diagnoseExpressionValue（即时诊断）', () => {
  it('合法插值串无诊断', () => {
    expect(diagnoseExpressionValue('单号 {{orderNo}}，金额 {{amount | currency:CNY}}')).toEqual([]);
    expect(diagnoseExpressionValue('纯文本无插值')).toEqual([]);
    expect(diagnoseExpressionValue('')).toEqual([]);
  });

  it('空 {{}}：就近错误 + 偏移正确', () => {
    const [d] = diagnoseExpressionValue('a{{}}b');
    expect(d.message).toContain('空表达式');
    expect(d.startOffset).toBe(1);
    expect(d.endOffset).toBe(5);
  });

  it('语法错误：内核 position 透传（整段级 -1）', () => {
    const [d] = diagnoseExpressionValue('{{1 +}}');
    expect(d.expression).toBe('1 +');
    expect(d.message).toContain('表达式意外结束');
    expect(d.position).toBe(-1);
    expect(d.startOffset).toBe(0);
    expect(d.endOffset).toBe(7);
  });

  it('多插值只报非法一处', () => {
    const diags = diagnoseExpressionValue('{{orderNo}} 和 {{a @ b}}');
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain('非法字符');
    expect(diags[0].position).toBeGreaterThan(0); // 字符级定位
  });

  it('超 1KB 沙箱限额：整段级错误', () => {
    const big = `{{${'a.'.repeat(600)}a}}`;
    const [d] = diagnoseExpressionValue(big);
    expect(d.message).toContain('沙箱限额');
    expect(d.position).toBe(-1);
  });
});

interface MockMonaco {
  registerCalls: { id: string }[];
  monarchs: { id: string; language: { tokenizer: Record<string, unknown> } }[];
  completionProviders: {
    triggerCharacters?: string[];
    provideCompletionItems: (
      model: {
        getLineContent: (n: number) => string;
        getWordUntilPosition: (p: unknown) => {
          word: string;
          startColumn: number;
          endColumn: number;
        };
      },
      position: { lineNumber: number; column: number },
    ) => {
      suggestions: {
        label: string;
        kind: number;
        insertText: string;
        range: { startColumn: number };
      }[];
    };
  }[];
  ns: unknown;
}

function mockMonaco(): MockMonaco {
  const mock: MockMonaco = { registerCalls: [], monarchs: [], completionProviders: [], ns: null };
  mock.ns = {
    languages: {
      register: (def: { id: string }) => mock.registerCalls.push(def),
      setMonarchTokensProvider: (id: string, language: { tokenizer: Record<string, unknown> }) =>
        mock.monarchs.push({ id, language }),
      registerCompletionItemProvider: (
        _id: string,
        provider: MockMonaco['completionProviders'][number],
      ) => mock.completionProviders.push(provider),
      CompletionItemKind: { Field: 14, Variable: 5 },
    },
  };
  return mock;
}

function mockModel(line: string) {
  return {
    getLineContent: () => line,
    getWordUntilPosition: () => ({ word: '', startColumn: 1, endColumn: line.length + 1 }),
  };
}

describe('syntax（monaco 语法与补全注册）', () => {
  beforeEach(() => {
    resetRegistrationForTest();
  });

  it('registerDslSyntax 幂等：语言 + monarch 仅注册一次，tokenizer 含 expr 态', () => {
    const monaco = mockMonaco();
    registerDslSyntax(monaco.ns as unknown as typeof MonacoNS);
    registerDslSyntax(monaco.ns as unknown as typeof MonacoNS);
    expect(monaco.registerCalls).toEqual([{ id: EXPRESSION_LANGUAGE_ID }]);
    expect(monaco.monarchs).toHaveLength(1);
    expect(Object.keys(monaco.monarchs[0].language.tokenizer)).toEqual(['root', 'expr']);
  });

  it('补全：{{ 内按前缀过滤 + kind 映射 + range 对齐前缀起点', () => {
    const monaco = mockMonaco();
    registerFieldCompletion(monaco.ns as unknown as typeof MonacoNS, () =>
      collectFieldSuggestions(FIXTURE_DSL),
    );
    const provider = monaco.completionProviders[0];
    const line = '{{ord';
    const res = provider.provideCompletionItems(mockModel(line), {
      lineNumber: 1,
      column: line.length + 1,
    });
    expect(res.suggestions.map((s) => s.label)).toEqual(['orderNo']);
    expect(res.suggestions[0].kind).toBe(14); // Field
    expect(res.suggestions[0].range.startColumn).toBe(3); // 前缀 'ord' 起点

    const line2 = '前缀文本 {{diffT';
    const res2 = provider.provideCompletionItems(mockModel(line2), {
      lineNumber: 1,
      column: line2.length + 1,
    });
    expect(res2.suggestions.map((s) => s.label)).toEqual(['diffTotal']);
    expect(res2.suggestions[0].kind).toBe(5); // param → Variable
  });

  it('补全边界：}} 之后 / 管道之后 / 插值外一律不提示', () => {
    const monaco = mockMonaco();
    registerFieldCompletion(monaco.ns as unknown as typeof MonacoNS, () =>
      collectFieldSuggestions(FIXTURE_DSL),
    );
    const provider = monaco.completionProviders[0];
    for (const line of ['{{orderNo}} or', '{{orderNo | ', '普通文本 ord']) {
      const res = provider.provideCompletionItems(mockModel(line), {
        lineNumber: 1,
        column: line.length + 1,
      });
      expect(res.suggestions).toEqual([]);
    }
  });

  it('registerFieldCompletion 幂等：重复调用不重复注册 provider', () => {
    const monaco = mockMonaco();
    registerFieldCompletion(monaco.ns as unknown as typeof MonacoNS, () => []);
    registerFieldCompletion(monaco.ns as unknown as typeof MonacoNS, () => []);
    expect(monaco.completionProviders).toHaveLength(1);
  });
});
