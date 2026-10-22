<script setup lang="ts">
// 多级表头编辑器（table.headerRows）：行→格两层编辑——text/colspan/rowspan/
// diagonal 下拉；diagonalLabels 四角输入仅 diagonal 时显示（镜像 schema if/then）。
// header-cell-span-mismatch 就近展示（专项步骤 4 块 C）。
import type { ValidationError } from 'taprint';
import type { HeaderCellV2 } from '../../types';
import { V2_ERROR_HINTS } from '../../../shared/dsl';

const props = defineProps<{
  rows: HeaderCellV2[][];
  /** 已按元素 path 过滤的校验错误，组件内再按 code 过滤 */
  errors: ValidationError[];
}>();
const emit = defineEmits<{ update: [HeaderCellV2[][] | undefined] }>();

function clean<T extends object>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as T;
}

function toSpan(value: string): number | undefined {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 1 ? n : undefined;
}

function patchCell(ri: number, ci: number, p: Partial<HeaderCellV2>): void {
  emit(
    'update',
    props.rows.map((row, r) =>
      r !== ri ? row : row.map((cell, c) => (c !== ci ? cell : clean({ ...cell, ...p }))),
    ),
  );
}

function setDiagonal(ri: number, ci: number, value: string): void {
  if (!value) {
    // 清除 diagonal 同时必须移除 diagonalLabels（schema if/then 耦合）
    patchCell(ri, ci, { diagonal: undefined, diagonalLabels: undefined });
    return;
  }
  patchCell(ri, ci, { diagonal: value as HeaderCellV2['diagonal'] });
}

function setCorner(ri: number, ci: number, corner: 'tl' | 'tr' | 'bl' | 'br', value: string): void {
  const cell = props.rows[ri][ci];
  const labels = { ...(cell.diagonalLabels ?? {}), [corner]: value || undefined };
  const rest = Object.entries(labels).filter(([, v]) => v !== undefined);
  patchCell(ri, ci, {
    diagonalLabels: rest.length
      ? (Object.fromEntries(rest) as HeaderCellV2['diagonalLabels'])
      : undefined,
  });
}

function addRow(): void {
  emit('update', [...props.rows, [{ text: '' }]]);
}

function removeRow(ri: number): void {
  const rows = props.rows.filter((_, i) => i !== ri);
  emit('update', rows.length ? rows : undefined);
}

function addCell(ri: number): void {
  emit(
    'update',
    props.rows.map((row, r) => (r === ri ? [...row, { text: '' }] : row)),
  );
}

function removeCell(ri: number, ci: number): void {
  const rows = props.rows
    .map((row, r) => (r === ri ? row.filter((_, c) => c !== ci) : row))
    .filter((row) => row.length > 0);
  emit('update', rows.length ? rows : undefined);
}

const spanErrors = () => props.errors.filter((e) => e.code === 'header-cell-span-mismatch');
</script>

<template>
  <div class="space-y-1.5">
    <div
      v-for="e in spanErrors()"
      :key="e.path + e.message"
      class="rounded bg-red-50 px-1.5 py-1 text-red-600"
      data-testid="inline-error-header-span"
    >
      [{{ e.code }}] {{ e.message }}
      <div class="text-red-400">{{ V2_ERROR_HINTS[e.code] }}</div>
    </div>

    <div
      v-for="(row, ri) in rows"
      :key="ri"
      class="rounded border border-gray-200 p-1.5"
      :data-testid="`header-row-editor-${ri}`"
    >
      <div class="mb-1 flex items-center justify-between text-gray-500">
        <span>第 {{ ri + 1 }} 行</span>
        <div class="flex gap-1">
          <button
            type="button"
            class="rounded px-1 hover:bg-gray-100"
            :data-testid="`header-cell-add-${ri}`"
            @click="addCell(ri)"
          >
            + 格
          </button>
          <button
            type="button"
            class="rounded px-1 text-red-400 hover:bg-red-50"
            :data-testid="`header-row-remove-${ri}`"
            @click="removeRow(ri)"
          >
            删行
          </button>
        </div>
      </div>
      <div
        v-for="(cell, ci) in row"
        :key="ci"
        class="mb-1 rounded bg-gray-50 p-1"
        :data-testid="`header-cell-editor-${ri}-${ci}`"
      >
        <div class="flex items-center gap-1">
          <input
            :value="cell.text"
            type="text"
            placeholder="表头文字"
            class="w-full min-w-0 rounded border border-gray-200 px-1 py-0.5"
            :data-testid="`header-cell-text-${ri}-${ci}`"
            @change="patchCell(ri, ci, { text: ($event.target as HTMLInputElement).value })"
          />
          <button
            type="button"
            class="rounded px-1 text-gray-400 hover:bg-red-50 hover:text-red-500"
            :data-testid="`header-cell-remove-${ri}-${ci}`"
            aria-label="删除单元格"
            @click="removeCell(ri, ci)"
          >
            ×
          </button>
        </div>
        <div class="mt-1 flex items-center gap-1">
          <input
            :value="cell.colspan ?? 1"
            type="number"
            min="1"
            title="colspan"
            class="w-14 rounded border border-gray-200 px-1 py-0.5"
            :data-testid="`header-cell-colspan-${ri}-${ci}`"
            @change="
              patchCell(ri, ci, {
                colspan: toSpan(($event.target as HTMLInputElement).value),
              })
            "
          />
          <input
            :value="cell.rowspan ?? 1"
            type="number"
            min="1"
            title="rowspan"
            class="w-14 rounded border border-gray-200 px-1 py-0.5"
            :data-testid="`header-cell-rowspan-${ri}-${ci}`"
            @change="
              patchCell(ri, ci, {
                rowspan: toSpan(($event.target as HTMLInputElement).value),
              })
            "
          />
          <select
            :value="cell.diagonal ?? ''"
            class="w-full min-w-0 rounded border border-gray-200 px-1 py-0.5"
            :data-testid="`header-cell-diagonal-${ri}-${ci}`"
            @change="setDiagonal(ri, ci, ($event.target as HTMLSelectElement).value)"
          >
            <option value="">无斜线</option>
            <option value="ltr">斜线 ↘（ltr）</option>
            <option value="rtl">斜线 ↗（rtl）</option>
            <option value="both">双斜线 ✕（both）</option>
          </select>
        </div>
        <div v-if="cell.diagonal" class="mt-1 grid grid-cols-2 gap-1">
          <input
            v-for="corner in ['tl', 'tr', 'bl', 'br'] as const"
            :key="corner"
            :value="cell.diagonalLabels?.[corner] ?? ''"
            type="text"
            :placeholder="`角标 ${corner}`"
            class="rounded border border-gray-200 px-1 py-0.5"
            :data-testid="`header-corner-${corner}-${ri}-${ci}`"
            @change="setCorner(ri, ci, corner, ($event.target as HTMLInputElement).value)"
          />
        </div>
      </div>
    </div>
    <button
      type="button"
      class="w-full rounded border border-dashed border-gray-300 px-1.5 py-1 text-gray-500 hover:border-blue-300 hover:text-blue-600"
      data-testid="header-row-add"
      @click="addRow"
    >
      + 添加表头行
    </button>
  </div>
</template>
