<script setup lang="ts">
// DSL 2.0 表头单元格（镜像 definitions.headerCell）：合并跨度 + 斜线表头。
// 斜线为设计态近似（CSS/SVG），精确几何以后端渲染器为权威（设计契约）。
import { computed } from 'vue';
import type { HeaderCellV2 } from '../../types';

const props = defineProps<{ cell: HeaderCellV2 }>();

const hasLtr = computed(() => props.cell.diagonal === 'ltr' || props.cell.diagonal === 'both');
const hasRtl = computed(() => props.cell.diagonal === 'rtl' || props.cell.diagonal === 'both');
const labels = computed(() => props.cell.diagonalLabels ?? {});
const cornerBase = 'absolute px-0.5 text-[10px] leading-tight text-gray-700';
</script>

<template>
  <div class="relative min-h-7 w-full" data-testid="table-header-cell">
    <svg
      v-if="hasLtr || hasRtl"
      class="pointer-events-none absolute inset-0 h-full w-full"
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <line v-if="hasLtr" x1="0" y1="0" x2="100" y2="100" stroke="#9ca3af" stroke-width="1" />
      <line v-if="hasRtl" x1="0" y1="100" x2="100" y2="0" stroke="#9ca3af" stroke-width="1" />
    </svg>
    <span
      v-if="hasLtr && labels.tl"
      :class="cornerBase"
      class="left-0 top-0"
      data-testid="diagonal-label-tl"
      >{{ labels.tl }}</span
    >
    <span
      v-if="hasLtr && labels.br"
      :class="cornerBase"
      class="bottom-0 right-0"
      data-testid="diagonal-label-br"
      >{{ labels.br }}</span
    >
    <span
      v-if="hasRtl && labels.bl"
      :class="cornerBase"
      class="bottom-0 left-0"
      data-testid="diagonal-label-bl"
      >{{ labels.bl }}</span
    >
    <span
      v-if="hasRtl && labels.tr"
      :class="cornerBase"
      class="right-0 top-0"
      data-testid="diagonal-label-tr"
      >{{ labels.tr }}</span
    >
    <div
      v-if="cell.text"
      class="flex h-full items-center px-1.5 py-1"
      :style="{
        textAlign: cell.align ?? 'left',
        justifyContent:
          cell.align === 'center' ? 'center' : cell.align === 'right' ? 'flex-end' : 'flex-start',
      }"
    >
      {{ cell.text }}
    </div>
  </div>
</template>
