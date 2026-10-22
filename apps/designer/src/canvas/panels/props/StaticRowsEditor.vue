<script setup lang="ts">
// 自由合并行编辑器（table.staticRows）：position + 行/格编辑（value/colspan/rowspan）；
// static-row-span-mismatch 就近展示（专项步骤 4 块 C）。
import type { ValidationError } from 'taprint';
import type { StaticRowsV2, TableCellV2 } from '../../types';
import { V2_ERROR_HINTS } from '../../../shared/dsl';

const props = defineProps<{
  modelValue: StaticRowsV2 | undefined;
  errors: ValidationError[];
}>();
const emit = defineEmits<{ update: [StaticRowsV2 | undefined] }>();

function clean<T extends object>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as T;
}

function toSpan(value: string): number | undefined {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 1 ? n : undefined;
}

function create(): void {
  emit('update', { position: 'after', rows: [[{ value: '' }]] });
}

function patchRows(rows: TableCellV2[][]): void {
  if (!props.modelValue) return;
  emit('update', { ...props.modelValue, rows });
}

function patchCell(ri: number, ci: number, p: Partial<TableCellV2>): void {
  if (!props.modelValue) return;
  patchRows(
    props.modelValue.rows.map((row, r) =>
      r !== ri ? row : row.map((cell, c) => (c !== ci ? cell : clean({ ...cell, ...p }))),
    ),
  );
}

function addRow(): void {
  if (!props.modelValue) return;
  patchRows([...props.modelValue.rows, [{ value: '' }]]);
}

function removeRow(ri: number): void {
  if (!props.modelValue) return;
  const rows = props.modelValue.rows.filter((_, i) => i !== ri);
  emit('update', rows.length ? { ...props.modelValue, rows } : undefined);
}

function addCell(ri: number): void {
  if (!props.modelValue) return;
  patchRows(props.modelValue.rows.map((row, r) => (r === ri ? [...row, { value: '' }] : row)));
}

function removeCell(ri: number, ci: number): void {
  if (!props.modelValue) return;
  const rows = props.modelValue.rows
    .map((row, r) => (r === ri ? row.filter((_, c) => c !== ci) : row))
    .filter((row) => row.length > 0);
  emit('update', rows.length ? { ...props.modelValue, rows } : undefined);
}

const spanErrors = () => props.errors.filter((e) => e.code === 'static-row-span-mismatch');
</script>

<template>
  <div class="space-y-1.5">
    <div
      v-for="e in spanErrors()"
      :key="e.path + e.message"
      class="rounded bg-red-50 px-1.5 py-1 text-red-600"
      data-testid="inline-error-static-span"
    >
      [{{ e.code }}] {{ e.message }}
      <div class="text-red-400">{{ V2_ERROR_HINTS[e.code] }}</div>
    </div>

    <template v-if="modelValue">
      <div class="flex items-center gap-1">
        <span class="text-gray-500">位置</span>
        <select
          :value="modelValue.position ?? 'after'"
          class="w-full rounded border border-gray-200 px-1 py-0.5"
          data-testid="static-position"
          @change="
            emit('update', {
              ...modelValue,
              position: ($event.target as HTMLSelectElement).value as 'before' | 'after',
            })
          "
        >
          <option value="before">数据行之前</option>
          <option value="after">数据行之后</option>
        </select>
        <button
          type="button"
          class="rounded border border-red-200 px-1.5 py-0.5 text-red-500 hover:bg-red-50"
          data-testid="static-remove-all"
          @click="emit('update', undefined)"
        >
          移除
        </button>
      </div>

      <div
        v-for="(row, ri) in modelValue.rows"
        :key="ri"
        class="rounded border border-gray-200 p-1.5"
        :data-testid="`static-row-editor-${ri}`"
      >
        <div class="mb-1 flex items-center justify-between text-gray-500">
          <span>第 {{ ri + 1 }} 行</span>
          <div class="flex gap-1">
            <button
              type="button"
              class="rounded px-1 hover:bg-gray-100"
              :data-testid="`static-cell-add-${ri}`"
              @click="addCell(ri)"
            >
              + 格
            </button>
            <button
              type="button"
              class="rounded px-1 text-red-400 hover:bg-red-50"
              :data-testid="`static-row-remove-${ri}`"
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
          :data-testid="`static-cell-editor-${ri}-${ci}`"
        >
          <div class="flex items-center gap-1">
            <input
              :value="cell.value ?? ''"
              type="text"
              placeholder="内容"
              class="w-full min-w-0 rounded border border-gray-200 px-1 py-0.5"
              :data-testid="`static-cell-value-${ri}-${ci}`"
              @change="
                patchCell(ri, ci, { value: ($event.target as HTMLInputElement).value || undefined })
              "
            />
            <button
              type="button"
              class="rounded px-1 text-gray-400 hover:bg-red-50 hover:text-red-500"
              :data-testid="`static-cell-remove-${ri}-${ci}`"
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
              :data-testid="`static-cell-colspan-${ri}-${ci}`"
              @change="
                patchCell(ri, ci, { colspan: toSpan(($event.target as HTMLInputElement).value) })
              "
            />
            <input
              :value="cell.rowspan ?? 1"
              type="number"
              min="1"
              title="rowspan"
              class="w-14 rounded border border-gray-200 px-1 py-0.5"
              :data-testid="`static-cell-rowspan-${ri}-${ci}`"
              @change="
                patchCell(ri, ci, { rowspan: toSpan(($event.target as HTMLInputElement).value) })
              "
            />
          </div>
        </div>
      </div>

      <button
        type="button"
        class="w-full rounded border border-dashed border-gray-300 px-1.5 py-1 text-gray-500 hover:border-blue-300 hover:text-blue-600"
        data-testid="static-row-add"
        @click="addRow"
      >
        + 添加行
      </button>
    </template>

    <button
      v-else
      type="button"
      class="w-full rounded border border-dashed border-gray-300 px-1.5 py-1 text-gray-500 hover:border-blue-300 hover:text-blue-600"
      data-testid="static-create"
      @click="create"
    >
      + 添加自由合并行
    </button>
  </div>
</template>
