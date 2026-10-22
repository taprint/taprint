<script setup lang="ts">
// 列编辑器（table.columns）：增删列 + header/field/width/align；每列可展开 subtable
// 编辑（source 仅列 detail 源），子列递归复用本组件（专项步骤 4 块 C）。
// 写回口径：整体替换数组，禁止原地 mutate。
import { computed } from 'vue';
import type { SubtableV2, TableColumn } from '../../types';

const props = withDefaults(
  defineProps<{
    columns: TableColumn[];
    detailSources: string[];
    /** 子表列禁用再嵌套（schema 允许递归，UI 限一层防失焦） */
    allowSubtable?: boolean;
  }>(),
  // boolean prop 缺省被 Vue 布尔铸造为 false，必须显式 default true
  { allowSubtable: true },
);
const emit = defineEmits<{ update: [TableColumn[]] }>();

const canSubtable = computed(() => props.allowSubtable);

function clean<T extends object>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as T;
}

function patch(index: number, p: Partial<TableColumn>): void {
  emit(
    'update',
    props.columns.map((c, i) => (i === index ? clean({ ...c, ...p }) : c)),
  );
}

function addColumn(): void {
  emit('update', [...props.columns, { header: '', field: '' }]);
}

function removeColumn(index: number): void {
  emit(
    'update',
    props.columns.filter((_, i) => i !== index),
  );
}

function patchSubtable(index: number, p: Partial<SubtableV2>): void {
  const col = props.columns[index];
  if (!col?.subtable) return;
  patch(index, { subtable: clean({ ...col.subtable, ...p }) });
}

function createSubtable(index: number): void {
  patch(index, { subtable: { columns: [{ header: '', field: '' }] } });
}

function removeSubtable(index: number): void {
  patch(index, { subtable: undefined });
}
</script>

<template>
  <div class="space-y-1.5">
    <div
      v-for="(col, i) in columns"
      :key="i"
      class="rounded border border-gray-200 p-1.5"
      data-testid="column-row"
    >
      <div class="flex items-center gap-1">
        <input
          :value="col.header"
          type="text"
          placeholder="表头"
          class="w-full min-w-0 rounded border border-gray-200 px-1 py-0.5"
          :data-testid="`column-header-input-${i}`"
          @change="patch(i, { header: ($event.target as HTMLInputElement).value })"
        />
        <input
          :value="col.field"
          type="text"
          placeholder="field"
          class="w-full min-w-0 rounded border border-gray-200 px-1 py-0.5"
          :data-testid="`column-field-input-${i}`"
          @change="patch(i, { field: ($event.target as HTMLInputElement).value })"
        />
        <button
          type="button"
          class="rounded px-1 text-gray-400 hover:bg-red-50 hover:text-red-500"
          :data-testid="`column-remove-${i}`"
          aria-label="删除列"
          @click="removeColumn(i)"
        >
          ×
        </button>
      </div>
      <div class="mt-1 flex items-center gap-1">
        <input
          :value="col.width ?? ''"
          type="text"
          placeholder="宽 如 10%"
          class="w-full min-w-0 rounded border border-gray-200 px-1 py-0.5"
          :data-testid="`column-width-input-${i}`"
          @change="patch(i, { width: ($event.target as HTMLInputElement).value || undefined })"
        />
        <select
          :value="col.align ?? ''"
          class="rounded border border-gray-200 px-1 py-0.5"
          :data-testid="`column-align-input-${i}`"
          @change="
            patch(i, {
              align: (($event.target as HTMLSelectElement).value || undefined) as
                TableColumn['align'] | undefined,
            })
          "
        >
          <option value="">对齐</option>
          <option value="left">左</option>
          <option value="center">中</option>
          <option value="right">右</option>
        </select>
      </div>

      <!-- 主从子表（列级 subtable；source 仅列 detail 源） -->
      <template v-if="canSubtable">
        <details v-if="col.subtable" class="mt-1 rounded bg-gray-50 p-1">
          <summary class="cursor-pointer text-gray-500" :data-testid="`subtable-toggle-${i}`">
            子表{{ col.subtable.source ? `：${col.subtable.source}` : '（行内子数组）' }}
          </summary>
          <div class="mt-1 space-y-1">
            <select
              :value="col.subtable.source ?? ''"
              class="w-full rounded border border-gray-200 px-1 py-0.5"
              :data-testid="`subtable-source-${i}`"
              @change="
                patchSubtable(i, {
                  source: ($event.target as HTMLSelectElement).value || undefined,
                })
              "
            >
              <option value="">行内子数组（取列 field）</option>
              <option v-for="name in detailSources" :key="name" :value="name">
                {{ name }}
              </option>
            </select>
            <ColumnListEditor
              :columns="col.subtable.columns"
              :detail-sources="detailSources"
              :allow-subtable="false"
              @update="patchSubtable(i, { columns: $event })"
            />
            <button
              type="button"
              class="rounded border border-red-200 px-1.5 py-0.5 text-red-500 hover:bg-red-50"
              :data-testid="`subtable-remove-${i}`"
              @click="removeSubtable(i)"
            >
              移除子表
            </button>
          </div>
        </details>
        <button
          v-else
          type="button"
          class="mt-1 rounded border border-gray-200 px-1.5 py-0.5 text-gray-500 hover:border-blue-300 hover:text-blue-600"
          :data-testid="`subtable-create-${i}`"
          @click="createSubtable(i)"
        >
          + 子表
        </button>
      </template>
    </div>
    <button
      type="button"
      class="w-full rounded border border-dashed border-gray-300 px-1.5 py-1 text-gray-500 hover:border-blue-300 hover:text-blue-600"
      data-testid="column-add"
      @click="addColumn"
    >
      + 添加列
    </button>
  </div>
</template>
