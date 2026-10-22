<script setup lang="ts">
// DSL 2.0 循环容器（loop）：设计态渲 body 一轮（只读预览，子元素编辑走属性面板；
// 行作用域求值属渲染器职责）。嵌套选中不做（，选中仍为顶层 body 索引）。
import { computed } from 'vue';
import type { CanvasElement } from '../types';
import { elementRegistry } from './registry';

const props = defineProps<{ model: CanvasElement }>();
const children = computed<CanvasElement[]>(() => props.model.body ?? []);
</script>

<template>
  <div class="rounded border border-dashed border-purple-400 bg-purple-50/30 p-1.5">
    <span
      data-testid="loop-chip"
      class="mb-1 inline-block rounded bg-purple-100 px-1.5 py-0.5 text-[10px] text-purple-700"
    >
      循环：each={{ model.each || '（未指定 detail 源）' }}
    </span>
    <div class="space-y-1">
      <template v-for="(child, i) in children" :key="i">
        <component
          :is="elementRegistry[child.type]"
          v-if="elementRegistry[child.type]"
          :model="child"
        />
        <div v-else class="border border-gray-200 bg-gray-50 px-1.5 py-1 text-xs text-gray-400">
          {{ child.type }}
        </div>
      </template>
      <p v-if="!children.length" class="text-xs text-gray-400">（空循环体）</p>
    </div>
  </div>
</template>
