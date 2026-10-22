<script setup lang="ts">
// 二维码元素：设计态以定位角示意（真实编码在渲染器侧）
import { computed } from 'vue';
import type { CanvasElement } from '../types';

const props = defineProps<{ model: CanvasElement }>();

const sizePx = computed(() => `${(props.model.size ?? 8) * 3}px`);
</script>

<template>
  <div class="inline-flex flex-col items-center">
    <div
      class="relative border border-gray-800 bg-white"
      :style="{ width: sizePx, height: sizePx }"
    >
      <div class="absolute left-0.5 top-0.5 h-2 w-2 border border-gray-800"></div>
      <div class="absolute right-0.5 top-0.5 h-2 w-2 border border-gray-800"></div>
      <div class="absolute bottom-0.5 left-0.5 h-2 w-2 border border-gray-800"></div>
      <div class="absolute inset-0 flex items-center justify-center text-[9px] text-gray-400">
        QR
      </div>
    </div>
    <div class="mt-0.5 max-w-28 truncate text-[10px] text-blue-600">
      {{ model.content || '二维码' }}
    </div>
  </div>
</template>
