<script setup lang="ts">
// 表达式编辑器：monaco-editor 包装（独立异步 chunk；设计契约）。
// 动态 import('monaco-editor') 经 vite manualChunks 独立成 monaco chunk（实测
// 980KB gzipped / 约 3.85MB 原始， 构建口径；不计核心预算 ，仅 full
// 模式首次打开时加载，接线侧门控）。
// 能力：语法高亮（monarch）、字段补全（dataSources/parameters 展平）、编译错误
// 即时诊断（marker + 内联错误列表，300ms 防抖）。
// 加载失败降级 textarea（运行期兜底；与 DR14 构建期 codemirror 备选是两层口径）。
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type * as MonacoNS from 'monaco-editor';
import { useDesignerStore } from '../canvas/store';
import { diagnoseExpressionValue, type ExpressionDiagnostic } from './diagnostics';
import { collectFieldSuggestions } from './fieldSuggestion';
import { EXPRESSION_LANGUAGE_ID, registerDslSyntax, registerFieldCompletion } from './syntax';

const props = withDefaults(defineProps<{ modelValue: string; height?: number }>(), {
  height: 96,
});
const emit = defineEmits<{ (e: 'update:modelValue', value: string): void }>();

const store = useDesignerStore();
const hostRef = ref<HTMLDivElement | null>(null);
const loading = ref(true);
const loadError = ref('');
const diagnostics = ref<ExpressionDiagnostic[]>([]);

let editor: MonacoNS.editor.IStandaloneCodeEditor | null = null;
let monacoRef: typeof MonacoNS | null = null;
let diagnoseTimer: ReturnType<typeof setTimeout> | undefined;
let applyingExternal = false;

function applyDiagnostics(value: string): void {
  diagnostics.value = diagnoseExpressionValue(value);
  const monaco = monacoRef;
  const model = editor?.getModel();
  if (!monaco || !model) return;
  monaco.editor.setModelMarkers(
    model,
    EXPRESSION_LANGUAGE_ID,
    diagnostics.value.map((d) => {
      const start = model.getPositionAt(d.startOffset);
      const end = model.getPositionAt(d.endOffset);
      return {
        severity: monaco.MarkerSeverity.Error,
        message: d.message,
        startLineNumber: start.lineNumber,
        startColumn: start.column,
        endLineNumber: end.lineNumber,
        endColumn: end.column,
      };
    }),
  );
}

onMounted(async () => {
  try {
    const [monaco, { installMonacoWorkers }] = await Promise.all([
      import('monaco-editor'),
      import('./workers'),
    ]);
    installMonacoWorkers();
    registerDslSyntax(monaco);
    registerFieldCompletion(monaco, () => collectFieldSuggestions(store.dsl));
    monacoRef = monaco;
    if (!hostRef.value) throw new Error('editor host 节点缺失');
    editor = monaco.editor.create(hostRef.value, {
      value: props.modelValue,
      language: EXPRESSION_LANGUAGE_ID,
      wordWrap: 'on',
      minimap: { enabled: false },
      lineNumbers: 'off',
      glyphMargin: false,
      folding: false,
      scrollBeyondLastLine: false,
      fontSize: 12,
      automaticLayout: true,
      fixedOverflowWidgets: true,
    });
    editor.onDidChangeModelContent(() => {
      const value = editor?.getValue() ?? '';
      if (!applyingExternal) emit('update:modelValue', value);
      clearTimeout(diagnoseTimer);
      diagnoseTimer = setTimeout(() => applyDiagnostics(value), 300);
    });
    applyDiagnostics(props.modelValue);
    loading.value = false;
  } catch (e) {
    loading.value = false;
    loadError.value = e instanceof Error ? e.message : String(e);
  }
});

watch(
  () => props.modelValue,
  (value) => {
    if (!editor || editor.getValue() === value) return;
    applyingExternal = true;
    editor.setValue(value);
    applyingExternal = false;
    applyDiagnostics(value);
  },
);

onBeforeUnmount(() => {
  clearTimeout(diagnoseTimer);
  editor?.dispose();
  editor = null;
});
</script>

<template>
  <div data-testid="expression-editor">
    <div v-if="loading" class="text-[10px] text-gray-400" data-testid="expr-loading">
      表达式编辑器加载中…
    </div>
    <template v-if="loadError">
      <p class="text-[10px] text-red-500" data-testid="expr-load-error">
        monaco 加载失败，降级为普通输入：{{ loadError }}
      </p>
      <textarea
        :value="modelValue"
        rows="2"
        class="w-full rounded border border-gray-200 px-1.5 py-1 text-xs"
        data-testid="expr-fallback"
        @input="emit('update:modelValue', ($event.target as HTMLTextAreaElement).value)"
      />
    </template>
    <div
      v-show="!loadError"
      ref="hostRef"
      class="overflow-hidden rounded border border-gray-200"
      :style="{ height: `${height}px` }"
      data-testid="expr-host"
    />
    <ul v-if="diagnostics.length" class="mt-1 space-y-0.5" data-testid="expr-errors">
      <li v-for="(d, i) in diagnostics" :key="i" class="text-[10px] text-red-500">
        {{ d.message }}
      </li>
    </ul>
  </div>
</template>
