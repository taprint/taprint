<script setup lang="ts">
// 分组小计编辑器（table.groups）：field/header/subtotal.label；values 按列数渲染
// 等长输入（空→null）+「对齐到列数」一键修复；subtotal-values-length 就近展示
// （专项步骤 4 块 C）。
import type { ValidationError } from 'taprint';
import type { TableGroupV2 } from '../../types';
import { V2_ERROR_HINTS } from '../../../shared/dsl';

const props = defineProps<{
  groups: TableGroupV2[];
  /** 当前表格列数（values 等长基准） */
  colCount: number;
  errors: ValidationError[];
}>();
const emit = defineEmits<{ update: [TableGroupV2[]] }>();

function clean<T extends object>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as T;
}

function patch(index: number, p: Partial<TableGroupV2>): void {
  emit(
    'update',
    props.groups.map((g, i) => (i === index ? clean({ ...g, ...p }) : g)),
  );
}

function addGroup(): void {
  emit('update', [
    ...props.groups,
    { field: '', subtotal: { values: Array.from({ length: props.colCount }, () => null) } },
  ]);
}

function removeGroup(index: number): void {
  emit(
    'update',
    props.groups.filter((_, i) => i !== index),
  );
}

function patchSubtotal(index: number, p: Partial<NonNullable<TableGroupV2['subtotal']>>): void {
  const group = props.groups[index];
  if (!group.subtotal) return;
  patch(index, { subtotal: clean({ ...group.subtotal, ...p }) });
}

function setValue(index: number, vi: number, raw: string): void {
  const group = props.groups[index];
  if (!group.subtotal) return;
  // 输入按列数等长展开：越界写入前先对齐长度
  const base = alignValues(group.subtotal.values, Math.max(props.colCount, vi + 1));
  base[vi] = raw.trim() ? raw : null;
  patchSubtotal(index, { values: base.slice(0, Math.max(props.colCount, vi + 1)) });
}

function alignValues(values: Array<string | null>, length: number): Array<string | null> {
  return Array.from({ length }, (_, i) => values[i] ?? null);
}

/** 一键修复：values 对齐到列数（保留已有值，不足补 null，多余截断） */
function alignToColumns(index: number): void {
  const group = props.groups[index];
  if (!group.subtotal) return;
  patchSubtotal(index, { values: alignValues(group.subtotal.values, props.colCount) });
}

function createSubtotal(index: number): void {
  patch(index, { subtotal: { values: alignValues([], props.colCount) } });
}

function removeSubtotal(index: number): void {
  patch(index, { subtotal: undefined });
}

const lengthErrors = () => props.errors.filter((e) => e.code === 'subtotal-values-length');
</script>

<template>
  <div class="space-y-1.5">
    <div
      v-for="e in lengthErrors()"
      :key="e.path + e.message"
      class="rounded bg-red-50 px-1.5 py-1 text-red-600"
      data-testid="inline-error-subtotal-length"
    >
      [{{ e.code }}] {{ e.message }}
      <div class="text-red-400">{{ V2_ERROR_HINTS[e.code] }}</div>
    </div>

    <div
      v-for="(group, gi) in groups"
      :key="gi"
      class="rounded border border-gray-200 p-1.5"
      :data-testid="`group-editor-${gi}`"
    >
      <div class="flex items-center gap-1">
        <input
          :value="group.field"
          type="text"
          placeholder="分组字段 field"
          class="w-full min-w-0 rounded border border-gray-200 px-1 py-0.5"
          :data-testid="`group-field-${gi}`"
          @change="patch(gi, { field: ($event.target as HTMLInputElement).value })"
        />
        <button
          type="button"
          class="rounded px-1 text-gray-400 hover:bg-red-50 hover:text-red-500"
          :data-testid="`group-remove-${gi}`"
          aria-label="删除分组"
          @click="removeGroup(gi)"
        >
          ×
        </button>
      </div>
      <input
        :value="group.header ?? ''"
        type="text"
        placeholder="组头模板（留空用默认）"
        class="mt-1 w-full rounded border border-gray-200 px-1 py-0.5"
        :data-testid="`group-header-${gi}`"
        @change="patch(gi, { header: ($event.target as HTMLInputElement).value || undefined })"
      />

      <template v-if="group.subtotal">
        <input
          :value="group.subtotal.label ?? ''"
          type="text"
          placeholder="小计标签（如 小计）"
          class="mt-1 w-full rounded border border-gray-200 px-1 py-0.5"
          :data-testid="`group-subtotal-label-${gi}`"
          @change="
            patchSubtotal(gi, {
              label: ($event.target as HTMLInputElement).value || undefined,
            })
          "
        />
        <div class="mt-1 space-y-1">
          <input
            v-for="vi in Math.max(colCount, group.subtotal.values.length)"
            :key="vi - 1"
            :value="group.subtotal.values[vi - 1] ?? ''"
            type="text"
            :placeholder="`第 ${vi} 列小计（空=留空）`"
            class="w-full rounded border border-gray-200 px-1 py-0.5"
            :data-testid="`group-value-${gi}-${vi - 1}`"
            @change="setValue(gi, vi - 1, ($event.target as HTMLInputElement).value)"
          />
        </div>
        <div class="mt-1 flex gap-1">
          <button
            type="button"
            class="rounded border border-gray-200 px-1.5 py-0.5 text-gray-500 hover:border-blue-300 hover:text-blue-600"
            :data-testid="`group-align-${gi}`"
            @click="alignToColumns(gi)"
          >
            对齐到列数（{{ colCount }}）
          </button>
          <button
            type="button"
            class="rounded border border-red-200 px-1.5 py-0.5 text-red-500 hover:bg-red-50"
            :data-testid="`group-subtotal-remove-${gi}`"
            @click="removeSubtotal(gi)"
          >
            移除小计
          </button>
        </div>
      </template>
      <button
        v-else
        type="button"
        class="mt-1 rounded border border-gray-200 px-1.5 py-0.5 text-gray-500 hover:border-blue-300 hover:text-blue-600"
        :data-testid="`group-subtotal-create-${gi}`"
        @click="createSubtotal(gi)"
      >
        + 小计
      </button>
    </div>

    <button
      type="button"
      class="w-full rounded border border-dashed border-gray-300 px-1.5 py-1 text-gray-500 hover:border-blue-300 hover:text-blue-600"
      data-testid="group-add"
      @click="addGroup"
    >
      + 添加分组
    </button>
  </div>
</template>
