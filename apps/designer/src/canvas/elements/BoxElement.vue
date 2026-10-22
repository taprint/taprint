<script setup lang="ts">
// 矩形框元素（schema v1.1；D9 单形 x/y/width/height；TSPL 无原生命令=打印降级直角，
// 设计器按直角框预览与打印语义一致）
import { computed } from 'vue';
import type { CanvasElement } from '../types';

const props = defineProps<{ model: CanvasElement }>();

const thickness = computed(() => {
  const t = Number(props.model.thickness);
  return Number.isFinite(t) && t > 0 ? Math.min(32, t) : 2;
});
</script>

<template>
  <div class="h-full w-full">
    <div
      class="h-full w-full border-gray-800"
      :style="{ borderStyle: 'solid', borderWidth: `${thickness}px` }"
    ></div>
  </div>
</template>
