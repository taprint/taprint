<script setup lang="ts">
// 表格元素（table）：数据源驱动——v1.0 单行表头 + DSL 2.0 单元格模型
// （headerRows 多级/斜线表头、groups 分组小计、staticRows 自由合并行、
// column.subtable 主从子表、repeatHeaderOnPageBreak 徽标；专项步骤 4）。
// 设计态渲染口径：结构保真 + 数据占位——明细行求值属渲染器职责（设计契约）。
import { computed } from 'vue';
import type { CanvasElement, HeaderCellV2, TableColumn, TableGroupV2 } from '../types';
import TableHeaderCell from './table/TableHeaderCell.vue';

const props = defineProps<{ model: CanvasElement }>();

const columns = computed<TableColumn[]>(() =>
  Array.isArray(props.model.columns) ? props.model.columns : [],
);
const headerRows = computed<HeaderCellV2[][]>(() =>
  Array.isArray(props.model.headerRows) ? props.model.headerRows : [],
);
const groups = computed<TableGroupV2[]>(() => props.model.groups ?? []);
const staticRows = computed(() => props.model.staticRows);
const subtableColumns = computed(() =>
  columns.value.filter((c) => c.subtable && Array.isArray(c.subtable.columns)),
);

// 表格列数：columns 优先，缺省取首行表头 colspan 合计（与 validator width 推导同口径）
const colCount = computed(
  () =>
    columns.value.length ||
    (headerRows.value[0]?.reduce((acc, c) => acc + (c.colspan ?? 1), 0) ?? 0),
);

const repeatHeader = computed(() => props.model.layout?.repeatHeaderOnPageBreak === true);

// 模板内嵌 {{ 会破坏模板解析，占位表达式在脚本侧拼接
const cellExpr = (col: TableColumn): string =>
  col.field ? `{{${props.model.source}.${col.field}}}` : '';
const groupHeaderText = (group: TableGroupV2): string => group.header ?? `分组：{{${group.field}}}`;
const subExpr = (col: TableColumn): string => (col.field ? `{{${col.field}}}` : '');
</script>

<template>
  <div class="relative">
    <span
      v-if="repeatHeader"
      data-testid="table-repeat-badge"
      class="absolute -top-2 right-0 rounded bg-gray-100 px-1 text-[10px] text-gray-500"
      title="layout.repeatHeaderOnPageBreak：画布不分页，渲染器按页重复表头"
    >
      跨页重复表头
    </span>
    <table class="w-full border-collapse text-xs">
      <thead>
        <!-- DSL 2.0 多级表头：真实 colspan/rowspan 网格 -->
        <template v-if="headerRows.length">
          <tr v-for="(row, ri) in headerRows" :key="ri" data-testid="table-header-row">
            <th
              v-for="(cell, ci) in row"
              :key="ci"
              class="border border-gray-400 bg-gray-100 p-0 font-semibold"
              :colspan="cell.colspan ?? 1"
              :rowspan="cell.rowspan ?? 1"
            >
              <TableHeaderCell :cell="cell" />
            </th>
          </tr>
        </template>
        <!-- v1.0 回退：columns[].header 单行表头 -->
        <tr v-else>
          <th
            v-for="(col, ci) in columns"
            :key="`${col.field ?? ''}-${col.header ?? ''}-${ci}`"
            class="border border-gray-400 bg-gray-100 px-1.5 py-1 font-semibold"
            :style="{ width: col.width, textAlign: col.align ?? 'left' }"
          >
            {{ col.header }}
          </th>
        </tr>
      </thead>
      <tbody>
        <!-- staticRows position=before：自由合并行（结构保真） -->
        <template v-if="staticRows && staticRows.position === 'before'">
          <tr v-for="(row, ri) in staticRows.rows" :key="`sb-${ri}`" data-testid="table-static-row">
            <td
              v-for="(cell, ci) in row"
              :key="ci"
              class="border border-gray-300 px-1.5 py-1"
              :class="String(cell.value ?? '').includes('{{') ? 'text-blue-600' : ''"
              :colspan="cell.colspan ?? 1"
              :rowspan="cell.rowspan ?? 1"
              :style="{ textAlign: cell.align ?? 'left' }"
            >
              {{ cell.value ?? '' }}
            </td>
          </tr>
        </template>

        <!-- 明细占位行：数据行求值属渲染器职责，画布仅示意一行字段占位 -->
        <tr v-if="columns.length">
          <td
            v-for="(col, ci) in columns"
            :key="`${col.field ?? ''}-${ci}`"
            class="border border-gray-300 px-1.5 py-1 text-blue-600"
            :style="{ textAlign: col.align ?? 'left' }"
          >
            {{ cellExpr(col) }}
          </td>
        </tr>
        <tr v-if="model.source && colCount">
          <td
            :colspan="colCount"
            class="border border-gray-300 px-1.5 py-0.5 text-center text-gray-400"
          >
            ⋮ 数据源「{{ model.source }}」逐行渲染 ⋮
          </td>
        </tr>

        <!-- DSL 2.0 分组小计：组头行 + 小计行（values 逐列对齐，null 留空） -->
        <template v-for="(group, gi) in groups" :key="`g-${gi}`">
          <tr data-testid="table-group-header">
            <td
              :colspan="colCount"
              class="border border-gray-300 bg-blue-50 px-1.5 py-1 text-blue-800"
            >
              {{ groupHeaderText(group) }}
            </td>
          </tr>
          <tr v-if="group.subtotal" data-testid="table-group-subtotal">
            <template v-if="group.subtotal.values.length === colCount">
              <td
                v-for="(v, vi) in group.subtotal.values"
                :key="vi"
                class="border border-gray-300 bg-gray-50 px-1.5 py-1"
                :class="v && String(v).includes('{{') ? 'text-blue-600' : 'text-gray-500'"
              >
                {{ v ?? (vi === 0 ? (group.subtotal.label ?? '') : '') }}
              </td>
            </template>
            <td
              v-else
              :colspan="colCount"
              class="border border-gray-300 bg-red-50 px-1.5 py-1 text-red-600"
            >
              小计 values 长度 {{ group.subtotal.values.length }} ≠ 列数
              {{ colCount }}（subtotal-values-length）
            </td>
          </tr>
        </template>

        <!-- staticRows position=after（缺省）：自由合并行 -->
        <template v-if="staticRows && staticRows.position !== 'before'">
          <tr v-for="(row, ri) in staticRows.rows" :key="`sa-${ri}`" data-testid="table-static-row">
            <td
              v-for="(cell, ci) in row"
              :key="ci"
              class="border border-gray-300 px-1.5 py-1"
              :class="String(cell.value ?? '').includes('{{') ? 'text-blue-600' : ''"
              :colspan="cell.colspan ?? 1"
              :rowspan="cell.rowspan ?? 1"
              :style="{ textAlign: cell.align ?? 'left' }"
            >
              {{ cell.value ?? '' }}
            </td>
          </tr>
        </template>

        <tr v-if="model.summary?.length">
          <td :colspan="colCount" class="border border-gray-300 px-1.5 py-1">
            <div v-for="s in model.summary" :key="s.label" class="flex justify-between">
              <span class="text-gray-600">{{ s.label }}</span>
              <span class="text-blue-600">{{ s.value }}</span>
            </div>
          </td>
        </tr>
      </tbody>
    </table>

    <!-- DSL 2.0 主从表：列级子表缩进示意（行内展开属渲染器职责） -->
    <div
      v-for="col in subtableColumns"
      :key="`sub-${col.header}`"
      class="ml-4 mt-1 border-l-2 border-gray-200 pl-2"
      data-testid="table-subtable"
    >
      <div class="text-[10px] text-gray-400">
        主从子表：{{ col.header
        }}{{ col.subtable?.source ? `（source=${col.subtable.source}）` : '（行内子数组）' }}
      </div>
      <table class="w-full border-collapse text-xs">
        <thead>
          <tr>
            <th
              v-for="(sub, si) in col.subtable?.columns ?? []"
              :key="`${sub.field ?? ''}-${sub.header ?? ''}-${si}`"
              class="border border-gray-300 bg-gray-50 px-1.5 py-0.5 font-normal text-gray-600"
              :style="{ width: sub.width, textAlign: sub.align ?? 'left' }"
            >
              {{ sub.header }}
            </th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td
              v-for="(sub, si) in col.subtable?.columns ?? []"
              :key="`${sub.field ?? ''}-${si}`"
              class="border border-gray-200 px-1.5 py-0.5 text-blue-600"
            >
              {{ subExpr(sub) }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
