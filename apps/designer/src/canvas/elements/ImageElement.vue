<script setup lang="ts">
// 图片元素：src 为静态 URL 时预览，含表达式或空时占位
import { computed } from 'vue';
import type { CanvasElement } from '../types';

const props = defineProps<{ model: CanvasElement }>();

const isStaticSrc = computed(() => {
  const src = props.model.src ?? '';
  return src.length > 0 && !src.includes('{{');
});
</script>

<template>
  <div class="flex items-center justify-center">
    <img
      v-if="isStaticSrc"
      :src="model.src"
      :style="{ width: model.width, height: model.height }"
      class="max-h-40 object-contain"
      alt="模板图片"
    />
    <div
      v-else
      class="flex items-center justify-center rounded border border-dashed border-gray-400 bg-gray-50 text-xs text-gray-400"
      :style="{ width: model.width ?? '30mm', height: model.height ?? '20mm' }"
    >
      {{ model.src || '图片' }}
    </div>
  </div>
</template>
