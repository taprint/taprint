<script setup lang="ts">
// DSL 2.0 条件容器（conditional）：设计态渲双支（body 正常 + elseBody 灰化）；
// when 按 JS 真值规则运行期求值（0/''/null/undefined/false/NaN 为假，表达式真值契约）。
import { computed } from 'vue';
import type { CanvasElement } from '../types';
import { elementRegistry } from './registry';

const props = defineProps<{ model: CanvasElement }>();
const children = computed<CanvasElement[]>(() => props.model.body ?? []);
const elseChildren = computed<CanvasElement[]>(() => props.model.elseBody ?? []);
</script>

<template>
  <div class="rounded border border-dashed border-teal-400 bg-teal-50/30 p-1.5">
    <span
      data-testid="conditional-chip"
      class="mb-1 inline-block rounded bg-teal-100 px-1.5 py-0.5 text-[10px] text-teal-700"
    >
      条件：when={{ model.when || '（未指定表达式）' }}
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
      <p v-if="!children.length" class="text-xs text-gray-400">（空条件体）</p>
    </div>
    <div v-if="elseChildren.length" class="mt-1 opacity-60" data-testid="conditional-else">
      <span class="mb-1 inline-block rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-500">
        否则
      </span>
      <div class="space-y-1">
        <template v-for="(child, i) in elseChildren" :key="i">
          <component
            :is="elementRegistry[child.type]"
            v-if="elementRegistry[child.type]"
            :model="child"
          />
          <div v-else class="border border-gray-200 bg-gray-50 px-1.5 py-1 text-xs text-gray-400">
            {{ child.type }}
          </div>
        </template>
      </div>
    </div>
  </div>
</template>
