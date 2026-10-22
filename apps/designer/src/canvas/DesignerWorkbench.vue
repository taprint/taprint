<script setup lang="ts">
import { defineAsyncComponent, onMounted, ref } from 'vue';
import DesignerCanvas from './DesignerCanvas.vue';
import FieldPanel from './panels/FieldPanel.vue';
import LayersPanel from './panels/LayersPanel.vue';
import PropertyPanel from './panels/PropertyPanel.vue';
import ValidationStatus from './panels/ValidationStatus.vue';
import { sampleRegistry } from './samples';
import { useDesignerStore, type TemplateLike } from './store';
// 设计器工作台：画布 + 元素库/图层 + 属性面板三栏。
// embed 经 saveChannel 注入宿主保存通道（prepareSave 门禁 → save 消息），
// awaitHost=true 时不样例兜底（模板由宿主 loadTemplate 下发）；readOnly 保存门禁。
// 预览覆盖层异步加载 PreviewPane → 独立 chunk（预算 <100KB）；full/embed 均提供
// （embed 本地预览为宿主 preview 通道接入前的过渡能力；设计契约）。
const PreviewPane = defineAsyncComponent(() => import('./preview/PreviewPane.vue'));

const props = defineProps<{
  /** true = 等待宿主 loadTemplate，不加载样例（embed 正式链路） */
  awaitHost?: boolean;
  /** 宿主保存通道（embed 注入；缺省走本地「校验通过可保存」提示） */
  saveChannel?: (dsl: TemplateLike) => void;
  /** true = save 已上行等待宿主回执：保存防重入 */
  saveBusy?: boolean;
}>();

const store = useDesignerStore();
const selectedSample = ref(sampleRegistry[0].id);
const saveNote = ref<string | null>(null);
// 保存失败递增：强制展开 ValidationStatus 错误列表（块 D）
const expandErrors = ref(0);
// 预览覆盖层开关（M2 预览仿真；full/embed 均提供）
const previewOpen = ref(false);

function loadSelected(): void {
  const entry = sampleRegistry.find((s) => s.id === selectedSample.value);
  saveNote.value = null;
  if (entry) store.loadTemplate(entry.template);
}

function onSave(): void {
  if (store.readOnly) {
    saveNote.value = '只读模式，禁止保存';
    return;
  }
  if (props.saveBusy) return; // 等待宿主回执期间防重入
  const result = store.prepareSave();
  if (result.ok) {
    if (props.saveChannel && store.dsl) {
      saveNote.value = null;
      props.saveChannel(store.dsl);
    } else {
      saveNote.value = '校验通过，可保存';
    }
  } else {
    saveNote.value = null;
    expandErrors.value += 1;
  }
}

onMounted(() => {
  if (!props.awaitHost && !store.dsl) loadSelected();
});
</script>

<template>
  <div class="flex h-full flex-col">
    <header
      class="flex items-center gap-3 border-b border-gray-200 px-3 py-2 text-sm"
      data-testid="workbench-topbar"
    >
      <label class="flex items-center gap-1">
        样例模板
        <select
          v-model="selectedSample"
          data-testid="sample-select"
          class="rounded border border-gray-300 px-1 py-0.5"
          @change="loadSelected"
        >
          <option v-for="s in sampleRegistry" :key="s.id" :value="s.id">
            {{ s.label }}
          </option>
        </select>
      </label>
      <span
        v-if="store.schemaVersion"
        data-testid="version-chip"
        class="rounded bg-blue-50 px-2 py-0.5 text-xs text-blue-700"
      >
        DSL {{ store.schemaVersion }}
      </span>
      <span
        v-if="store.loadNote"
        data-testid="load-note"
        class="rounded bg-amber-50 px-2 py-0.5 text-xs text-amber-700"
      >
        {{ store.loadNote }}
      </span>
      <span
        v-if="saveNote"
        data-testid="save-note"
        :class="[
          'rounded px-2 py-0.5 text-xs',
          store.readOnly ? 'bg-amber-50 text-amber-700' : 'bg-green-50 text-green-700',
        ]"
      >
        {{ saveNote }}
      </span>
      <div class="flex-1" />
      <button
        type="button"
        data-testid="preview-button"
        class="rounded border border-gray-300 px-3 py-1 text-gray-700 hover:bg-gray-50"
        :disabled="!store.dsl"
        :title="store.dsl ? '打开预览仿真（设计态近似）' : '先加载模板'"
        @click="previewOpen = true"
      >
        预览
      </button>
      <button
        type="button"
        data-testid="save-button"
        class="rounded px-3 py-1 text-white"
        :class="
          store.validationValid && !store.readOnly && !saveBusy
            ? 'bg-blue-600'
            : 'cursor-not-allowed bg-gray-300'
        "
        :aria-disabled="!store.validationValid || store.readOnly || saveBusy"
        :title="
          store.readOnly
            ? '只读模式，禁止保存'
            : saveBusy
              ? '等待宿主回执…'
              : store.validationValid
                ? ''
                : '存在校验错误，点击定位错误列表'
        "
        @click="onSave"
      >
        保存
      </button>
    </header>
    <div class="flex min-h-0 flex-1">
      <aside class="flex w-60 flex-col gap-6 overflow-y-auto border-r border-gray-200 p-3">
        <FieldPanel />
        <LayersPanel />
      </aside>
      <DesignerCanvas class="min-w-0 flex-1" />
      <aside class="flex w-64 flex-col gap-3 overflow-y-auto border-l border-gray-200 p-3">
        <ValidationStatus :expand-signal="expandErrors" />
        <PropertyPanel />
      </aside>
    </div>
    <div
      v-if="previewOpen"
      data-testid="preview-overlay"
      class="fixed inset-0 z-40 flex flex-col bg-black/40"
    >
      <div
        class="flex items-center justify-between border-b border-gray-200 bg-white px-4 py-2 text-sm"
      >
        <span class="font-medium text-gray-700">预览仿真（设计态近似，渲染器为权威）</span>
        <button
          type="button"
          data-testid="preview-close"
          class="rounded border border-gray-300 px-2 py-0.5 text-gray-600 hover:bg-gray-50"
          @click="previewOpen = false"
        >
          关闭
        </button>
      </div>
      <div class="flex-1 overflow-auto p-6">
        <PreviewPane
          :dsl="store.dsl as Record<string, unknown> | null"
          :device="store.device"
          class="mx-auto inline-block"
        />
      </div>
    </div>
  </div>
</template>
