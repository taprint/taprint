<script setup lang="ts">
// 条码元素：设计态以条纹示意（真实 symbology 编码在渲染器侧）
import type { CanvasElement } from '../types';

defineProps<{ model: CanvasElement }>();
</script>

<template>
  <div class="inline-flex flex-col items-center px-1" :style="{ textAlign: model.align }">
    <div
      class="w-full min-w-28"
      :style="{
        height: model.height ?? '10mm',
        background:
          'repeating-linear-gradient(90deg, #111 0 2px, transparent 2px 4px, #111 4px 5px, transparent 5px 8px)',
      }"
    ></div>
    <div class="mt-0.5 text-[10px] text-blue-600">
      {{ model.content || `(${model.symbology})` }}
    </div>
  </div>
</template>
