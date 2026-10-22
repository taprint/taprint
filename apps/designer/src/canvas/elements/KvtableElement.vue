<script setup lang="ts">
// 键值表元素（kvtable）：rows 为「行 → 单元格对 [标签, 值]」二维结构
import { computed } from 'vue';
import type { CanvasElement } from '../types';

const props = defineProps<{ model: CanvasElement }>();

const columnCount = computed(() =>
  typeof props.model.columns === 'number' ? props.model.columns : 2,
);
</script>

<template>
  <table class="w-full border-collapse text-xs">
    <tbody>
      <tr v-for="(row, ri) in model.rows ?? []" :key="ri">
        <template v-for="(pair, ci) in row" :key="ci">
          <td class="border border-gray-300 bg-gray-50 px-1.5 py-1 text-gray-600">
            {{ pair[0] ?? '' }}
          </td>
          <td class="border border-gray-300 px-1.5 py-1">
            <span v-if="(pair[1] ?? '').includes('{{')" class="text-blue-600">{{ pair[1] }}</span>
            <span v-else>{{ pair[1] ?? '' }}</span>
          </td>
        </template>
        <td
          v-for="n in Math.max(0, columnCount - row.length)"
          :key="`pad-${n}`"
          colspan="2"
          class="border border-gray-300"
        ></td>
      </tr>
    </tbody>
  </table>
</template>
