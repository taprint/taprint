<script setup lang="ts">
// Layers 面板：元素列表（选中/上下移/删除；设计契约）
import { ref } from 'vue';
import { useDesignerStore } from '../store';

const store = useDesignerStore();

// 删除二次确认：首次点击某项进入确认态，再次点击才删除
const confirmingIndex = ref<number | null>(null);
function onDelete(index: number): void {
  if (confirmingIndex.value !== index) {
    confirmingIndex.value = index;
    return;
  }
  confirmingIndex.value = null;
  store.select(index);
  store.removeSelected();
}

function elementLabel(type: string, index: number): string {
  const el = store.activeBody[index];
  // 容器元素摘要 each/when 语义（专项步骤 4）
  if (type === 'loop' && typeof el?.each === 'string')
    return `循环：each=${el.each || '（未设置）'}`;
  if (type === 'conditional' && typeof el?.when === 'string') {
    return `条件：when=${el.when.slice(0, 16) || '（未设置）'}`;
  }
  const preview = (el?.content as string) || (el?.src as string) || '';
  return `${type}${preview ? `：${preview.slice(0, 12)}` : ''}`;
}
</script>

<template>
  <!--
    readOnly 完整编辑锁。
    根 fieldset[disabled] 让「选中元素」「上下移」「删除」按钮一律 disabled；
    readOnly 下用户仍可见图层列表（视觉提示），但不可改 selection（store.select 也加门禁）。
  -->
  <fieldset
    :disabled="store.readOnly"
    :data-readonly="store.readOnly ? 'true' : 'false'"
    class="embed-readonly-lock"
    data-testid="layers-panel"
  >
    <h3 class="mb-1.5 text-xs font-semibold text-gray-500">图层</h3>
    <p v-if="!store.activeBody.length" class="text-xs text-gray-400">无元素</p>
    <ul v-else class="space-y-1">
      <li
        v-for="(el, i) in store.activeBody"
        :key="i"
        class="flex items-center gap-1 rounded border px-1.5 py-1 text-xs"
        :class="
          store.selectedIndex === i
            ? 'border-blue-400 bg-blue-50 text-blue-700'
            : 'border-gray-200 text-gray-600'
        "
        :data-testid="`layer-item-${i}`"
      >
        <button
          type="button"
          class="min-w-0 flex-1 truncate text-left"
          :title="elementLabel(el.type, i)"
          @click="store.select(i)"
        >
          {{ elementLabel(el.type, i) }}
        </button>
        <template v-if="store.device !== 'label'">
          <button
            type="button"
            class="rounded px-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 disabled:opacity-30"
            :disabled="i === 0"
            aria-label="上移"
            @click="
              store.select(i);
              store.moveFlowSelected(-1);
            "
          >
            ↑
          </button>
          <button
            type="button"
            class="rounded px-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 disabled:opacity-30"
            :disabled="i === store.activeBody.length - 1"
            aria-label="下移"
            @click="
              store.select(i);
              store.moveFlowSelected(1);
            "
          >
            ↓
          </button>
        </template>
        <button
          type="button"
          class="rounded px-1 text-gray-400 hover:bg-red-50 hover:text-red-500"
          :class="confirmingIndex === i ? 'bg-red-500 text-white hover:bg-red-500' : ''"
          :aria-label="confirmingIndex === i ? '确认删除' : '删除'"
          @click="onDelete(i)"
        >
          {{ confirmingIndex === i ? '确认' : '×' }}
        </button>
      </li>
    </ul>
  </fieldset>
</template>
