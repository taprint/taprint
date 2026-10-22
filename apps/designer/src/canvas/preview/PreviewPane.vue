<script setup lang="ts">
// 预览面板（M2 预览仿真，设计契约 同构）：DSL 直渲近似仿真——
// provideMockData → layout → canvas 光栅化 → PNG objectURL。doc 设备类不支持本地
// 预览（口径：doc 预览走 Web/WPF 完整链路）；提示文案明示非 bug
// 宿主预览通道预期 + 画布替代。
// 设计态一切视觉为近似预览，渲染器为权威；embed 宿主 preview/previewResult
// 通道归 宿主。
import { onBeforeUnmount, ref, watch } from 'vue';
import type { Device } from '../types';
import { provideMockData } from './mockData';
import { renderReceiptPreview } from './ReceiptSimulator';
import { renderLabelPreview } from './LabelSimulator';

const props = defineProps<{
  dsl: Record<string, unknown> | null;
  device: Device | null;
}>();

const loading = ref(false);
const src = ref<string | null>(null);
const errorMsg = ref<string | null>(null);

let objectUrl: string | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
// 竞态栅栏：异步渲染期间 DSL 连续变更时只采纳最新一次结果
let seq = 0;

function revoke(): void {
  if (objectUrl) {
    URL.revokeObjectURL(objectUrl);
    objectUrl = null;
  }
}

async function render(): Promise<void> {
  const my = ++seq;
  if (!props.dsl || props.device === null || props.device === 'doc') {
    revoke();
    src.value = null;
    return;
  }
  loading.value = true;
  errorMsg.value = null;
  try {
    const data = provideMockData(props.dsl);
    const blob =
      props.device === 'receipt'
        ? await renderReceiptPreview(props.dsl, data)
        : await renderLabelPreview(props.dsl, data);
    if (my !== seq) return;
    revoke();
    objectUrl = URL.createObjectURL(blob);
    src.value = objectUrl;
  } catch (e) {
    if (my !== seq) return;
    errorMsg.value = `预览渲染失败：${(e as Error).message}`;
    revoke();
    src.value = null;
  } finally {
    if (my === seq) loading.value = false;
  }
}

function schedule(): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void render(), 300);
}

// deep：store 对 dsl 为就地变更（updateSelected 等），须深监听跟随编辑重渲
watch(() => props.dsl, schedule, { deep: true });
watch(
  () => props.device,
  () => void render(),
);

onBeforeUnmount(() => {
  if (timer) clearTimeout(timer);
  seq += 1;
  revoke();
});

void render();
</script>

<template>
  <div data-testid="preview-pane" class="preview-pane">
    <div
      v-if="device === 'doc'"
      data-testid="preview-unsupported"
      class="rounded bg-amber-50 px-3 py-2 text-xs text-amber-700"
    >
      当前设备类（doc）不做本地预览仿真（UNSUPPORTED_DEVICE_CLASS）。这不是错误：doc 完整预览待
      宿主 宿主预览通道（previewResult）接入，当前版式请直接查看画布排版；receipt/label
      可使用本地仿真预览。
    </div>
    <template v-else-if="device === 'receipt' || device === 'label'">
      <p v-if="loading" data-testid="preview-loading" class="text-xs text-gray-400">仿真渲染中…</p>
      <p
        v-if="errorMsg"
        data-testid="preview-error"
        class="rounded bg-red-50 px-2 py-1 text-xs text-red-600"
      >
        {{ errorMsg }}
      </p>
      <img
        v-if="src"
        :src="src"
        data-testid="preview-image"
        alt="预览仿真（近似）"
        class="max-w-full border border-gray-200 bg-white shadow-sm"
      />
      <p v-if="src" class="mt-1 text-[10px] text-gray-400">
        设计态近似预览：mock 数据按 schema 类型确定性生成（如 string →
        示例-字段路径），精确输出以渲染服务为准
      </p>
    </template>
    <p v-else class="text-xs text-gray-400">无呈现设备，无法预览</p>
  </div>
</template>
