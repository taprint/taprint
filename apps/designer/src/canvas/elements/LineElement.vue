<script setup lang="ts">
// 直线元素
import { computed } from 'vue';
import type { CanvasElement } from '../types';

const props = defineProps<{ model: CanvasElement }>();

const borderStyle = computed(() => {
  switch (props.model.lineStyle) {
    case 'dashed':
      return 'dashed';
    case 'dotted':
      return 'dotted';
    default:
      return 'solid';
  }
});
</script>

<template>
  <div class="w-full py-1">
    <div class="w-full border-t border-gray-800" :style="{ borderStyle }"></div>
  </div>
</template>
