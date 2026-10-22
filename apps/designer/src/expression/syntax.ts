// SPDX-License-Identifier: Apache-2.0
// monaco DSL 表达式语法支持（，设计契约）：
// 语言 id taprint-expression —— 普通文本 + {{...}} 插值（两种表达式形态共用：
// content 插值串与 when 的 JS 真值表达式）。monarch 负责高亮，补全 provider
// 挂接字段提示（候选纯函数见 fieldSuggestion.ts，jsdom 可测）。
// 注册幂等：monaco 为全局单例，多次打开编辑器不得重复 register（DR14 实装口径）。
import type * as MonacoNS from 'monaco-editor';
import { filterSuggestions, type FieldSuggestion } from './fieldSuggestion';

export const EXPRESSION_LANGUAGE_ID = 'taprint-expression';

let syntaxRegistered = false;
let completionRegistered = false;

/** monarch 高亮：{{ }} 定界符 + 插值内标识符/数字/字符串/管道/运算符 */
export function registerDslSyntax(monaco: typeof MonacoNS): void {
  if (syntaxRegistered) return;
  syntaxRegistered = true;
  monaco.languages.register({ id: EXPRESSION_LANGUAGE_ID });
  monaco.languages.setMonarchTokensProvider(EXPRESSION_LANGUAGE_ID, {
    defaultToken: 'text',
    tokenizer: {
      root: [
        [/\{\{/, { token: 'delimiter.expr', next: '@expr' }],
        [/[^{]+/, 'text'],
        [/\{/, 'text'],
      ],
      expr: [
        [/\}\}/, { token: 'delimiter.expr', next: '@pop' }],
        [/"([^"\\]|\\.)*"/, 'string'],
        [/'([^'\\]|\\.)*'/, 'string'],
        [/\d+(\.\d+)?/, 'number'],
        [/\|\|/, 'operator'],
        [/\|/, 'pipe'],
        [/[A-Za-z_$][\w$]*/, 'identifier'],
        [/[+\-*/%<>=!&?:]+/, 'operator'],
        [/[.[\],]/, 'delimiter'],
        [/\s+/, 'white'],
        [/[^}\s]/, 'identifier'],
      ],
    },
  });
}

/** 字段补全：仅在 {{ 之后、}} 与首个管道之前补全字段路径（管道后是过滤器名，不提示） */
export function registerFieldCompletion(
  monaco: typeof MonacoNS,
  getSuggestions: () => FieldSuggestion[],
): void {
  if (completionRegistered) return;
  completionRegistered = true;
  monaco.languages.registerCompletionItemProvider(EXPRESSION_LANGUAGE_ID, {
    triggerCharacters: ['.'],
    provideCompletionItems(model, position) {
      const before = model.getLineContent(position.lineNumber).slice(0, position.column - 1);
      const open = before.lastIndexOf('{{');
      if (open < 0 || before.slice(open).includes('}}')) return { suggestions: [] };
      const segment = before.slice(open + 2);
      if (segment.includes('|')) return { suggestions: [] };
      const prefix = /[A-Za-z0-9_$.]*$/.exec(segment)?.[0] ?? '';
      const word = model.getWordUntilPosition(position);
      const range: MonacoNS.IRange = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: position.column - prefix.length,
        endColumn: word.endColumn,
      };
      return {
        suggestions: filterSuggestions(getSuggestions(), prefix).map((s) => ({
          label: s.path,
          kind:
            s.kind === 'param'
              ? monaco.languages.CompletionItemKind.Variable
              : monaco.languages.CompletionItemKind.Field,
          insertText: s.path,
          detail: s.kind === 'param' ? `参数（${s.source}）` : `字段（${s.source}）`,
          range,
        })),
      };
    },
  });
}

/** 单测复位（幂等 flag 归零；生产不调用） */
export function resetRegistrationForTest(): void {
  syntaxRegistered = false;
  completionRegistered = false;
}
