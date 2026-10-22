<script setup lang="ts">
// 文本元素：content 中的 {{...}} 表达式高亮展示（设计契约）
import { computed } from 'vue';
import type { CanvasElement } from '../types';

const props = defineProps<{ model: CanvasElement }>();

const segments = computed(() =>
  (props.model.content ?? '')
    .split(/(\{\{[^}]*\}\})/g)
    .filter((s) => s.length > 0)
    .map((s) => ({ text: s, expr: s.startsWith('{{') })),
);

const fontSize = computed(() => {
  const fs = props.model.style?.fontSize;
  return typeof fs === 'number' ? `${fs}pt` : undefined;
});
</script>

<template>
  <div
    class="w-full whitespace-pre-wrap break-words px-0.5 py-0.5"
    :style="{
      fontSize,
      fontWeight: model.style?.bold ? 700 : undefined,
      fontStyle: model.style?.italic ? 'italic' : undefined,
      color: model.style?.color ?? undefined,
      textAlign: model.align ?? model.style?.align ?? 'left',
    }"
  >
    <template v-for="(seg, i) in segments" :key="i">
      <span v-if="seg.expr" class="rounded bg-blue-50 text-blue-600">{{ seg.text }}</span>
      <span v-else>{{ seg.text }}</span>
    </template>
    <span v-if="segments.length === 0" class="text-gray-300">空文本</span>
  </div>
</template>
