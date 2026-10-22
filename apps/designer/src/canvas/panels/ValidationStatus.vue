<script setup lang="ts">
// 校验状态条（专项步骤 4 块 D）：绿/红持久内联状态 + 错误列表（code 徽标 +
// path + message + V2_ERROR_HINTS 指引）。无 Toast 依赖的降级交互：
// 保存失败时经 expandSignal 递增强制展开。
import { ref, watch } from 'vue';
import { V2_ERROR_HINTS } from '../../shared/dsl';
import { useDesignerStore } from '../store';

const props = defineProps<{
  /** 保存失败时递增，强制展开错误列表 */
  expandSignal?: number;
}>();

const store = useDesignerStore();
const open = ref(false);

watch(
  () => props.expandSignal,
  (v) => {
    if (v) open.value = true;
  },
);
</script>

<template>
  <div
    class="rounded border px-2 py-1.5 text-xs"
    :class="store.validationValid ? 'border-green-200 bg-green-50' : 'border-red-200 bg-red-50'"
    data-testid="validation-status"
  >
    <div class="flex items-center justify-between">
      <span :class="store.validationValid ? 'text-green-700' : 'text-red-700'">
        <template v-if="store.validationValid">校验通过（schema + 业务规则）</template>
        <template v-else>校验错误 {{ store.validationErrors.length }} 项</template>
      </span>
      <button
        v-if="!store.validationValid"
        type="button"
        class="rounded border border-red-200 px-1.5 py-0.5 text-red-600 hover:bg-red-100"
        data-testid="validation-toggle"
        @click="open = !open"
      >
        {{ open ? '收起' : '展开' }}
      </button>
    </div>

    <ul
      v-if="!store.validationValid && open"
      class="mt-1.5 space-y-1"
      data-testid="validation-error-list"
    >
      <li
        v-for="(e, i) in store.validationErrors"
        :key="`${e.path}-${e.code}-${i}`"
        class="rounded bg-white px-1.5 py-1"
        data-testid="validation-error-item"
      >
        <div class="flex items-start gap-1">
          <span class="shrink-0 rounded bg-red-100 px-1 text-[10px] text-red-700">{{
            e.code
          }}</span>
          <span class="min-w-0 break-all text-gray-600">
            <span class="text-gray-400">{{ e.path }}</span>
            {{ e.message }}
          </span>
        </div>
        <p v-if="V2_ERROR_HINTS[e.code]" class="mt-0.5 text-[10px] text-red-400">
          {{ V2_ERROR_HINTS[e.code] }}
        </p>
      </li>
    </ul>
  </div>
</template>
