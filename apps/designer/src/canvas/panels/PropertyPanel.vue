<script setup lang="ts">
// Property 面板：选中元素属性编辑（按 type 判别表单；写回 DSL，设计契约）
// 专项步骤 4（块 C）：table v2 能力编辑器（列/多级表头/分组/自由行）+ 容器分区，
// 校验错误经 errorsForPath 按元素 path 过滤后就近展示。
import { computed, defineAsyncComponent, ref, watch } from 'vue';
import { errorsForPath } from '../../shared/dsl';
import { useMode } from '../../shared/mode';
import { useDesignerStore } from '../store';
import type { ElementStyle, HeaderCellV2, StaticRowsV2, TableColumn, TableGroupV2 } from '../types';
import ColumnListEditor from './props/ColumnListEditor.vue';
import ContainerPropsSection from './props/ContainerPropsSection.vue';
import GroupsEditor from './props/GroupsEditor.vue';
import HeaderRowsEditor from './props/HeaderRowsEditor.vue';
import PagePropsSection from './props/PagePropsSection.vue';
import StaticRowsEditor from './props/StaticRowsEditor.vue';

const store = useDesignerStore();
const el = computed(() => store.selectedElement);

// 表达式编辑器（暂不支持）：仅 full 模式提供入口——monaco 异步 chunk 首次
// 打开才加载（defineAsyncComponent 再切 ExpressionEditor 自身内部的动态 import）
const fullMode = useMode() === 'full';
const ExpressionEditor = defineAsyncComponent(
  () => import('../../expression/ExpressionEditor.vue'),
);
const fxField = ref<'content' | null>(null);

// 删除二次确认：首次点击进入确认态，再次点击才真正删除；切换选中自动复位
const confirmingDelete = ref(false);
watch(el, () => {
  confirmingDelete.value = false;
  fxField.value = null;
});
function onDelete(): void {
  if (!confirmingDelete.value) {
    confirmingDelete.value = true;
    return;
  }
  confirmingDelete.value = false;
  store.removeSelected();
}

const labelRows = [
  { key: 'x', label: 'X' },
  { key: 'y', label: 'Y' },
  { key: 'width', label: '宽' },
  { key: 'height', label: '高' },
] as const;

function stylePatch(patch: Partial<ElementStyle>): void {
  if (!el.value) return;
  store.updateSelected({ style: { ...(el.value.style ?? {}), ...patch } });
}

// label 的 x/y 是 schema 必填（labelElement allOf），清空输入时回退 0mm 而非删键；
// 非法单位格式（如 abc、50%）拒写，避免画布按 0 渲染
const LENGTH_RE = /^\d+(\.\d+)?(mm|cm|pt|px)$/;
function setGeom(key: string, value: string): void {
  if (value && !LENGTH_RE.test(value)) return;
  const required = key === 'x' || key === 'y';
  store.updateSelected({ [key]: value || (required ? '0mm' : undefined) });
}

const dataSourceNames = computed(() => (store.dsl?.dataSources ?? []).map((ds) => ds.name));
const detailSourceNames = computed(() =>
  (store.dsl?.dataSources ?? []).filter((ds) => ds.type === 'detail').map((ds) => ds.name),
);

// ---------- DSL 2.0 table/容器编辑（块 C）：视图派生 + 整体替换写回 ----------

const elementErrors = computed(() => {
  if (!store.device || store.selectedIndex === null) return [];
  return errorsForPath(
    store.validationErrors,
    `presentations.${store.device}.body[${store.selectedIndex}]`,
  );
});

const tableColumns = computed<TableColumn[]>(() =>
  Array.isArray(el.value?.columns) ? (el.value?.columns as TableColumn[]) : [],
);
const headerRows = computed<HeaderCellV2[][]>(() =>
  Array.isArray(el.value?.headerRows) ? (el.value?.headerRows as HeaderCellV2[][]) : [],
);
const tableGroups = computed<TableGroupV2[]>(() => (el.value?.groups as TableGroupV2[]) ?? []);
const staticRows = computed<StaticRowsV2 | undefined>(
  () => el.value?.staticRows as StaticRowsV2 | undefined,
);
// 与 TableElement/validator 同口径：columns 优先，缺省取首行表头 colspan 合计
const colCount = computed(
  () =>
    tableColumns.value.length ||
    headerRows.value[0]?.reduce((acc, c) => acc + (c.colspan ?? 1), 0) ||
    0,
);

function toggleRepeatHeader(checked: boolean): void {
  store.updateSelected({
    layout: checked ? { ...(el.value?.layout ?? {}), repeatHeaderOnPageBreak: true } : undefined,
  });
}

function createHeaderRows(): void {
  const n = colCount.value || 1;
  store.updateSelected({
    headerRows: [Array.from({ length: n }, () => ({ text: '' }))],
  });
}
</script>

<template>
  <!--
    readOnly 完整编辑锁。
    根 fieldset[disabled] 让内部所有 input/select/textarea/button（含 PagePropsSection、
    ColumnListEditor 等子组件内的）一律 disabled——HTML 标准 form-associated inheritance，
    无需逐个 :disabled 绑定。视觉灰态经 main.css 的 fieldset.embed-readonly-lock:disabled。
    预览与保存门禁不受此处影响（DesignerWorkbench 顶栏独立）。
  -->
  <fieldset
    :disabled="store.readOnly"
    :data-readonly="store.readOnly ? 'true' : 'false'"
    class="embed-readonly-lock"
    data-testid="property-panel"
  >
    <h3 class="mb-1.5 text-xs font-semibold text-gray-500">属性</h3>

    <div v-if="!el" class="text-xs">
      <!-- doc 未选中元素：页面级属性（水印/nup；块 D） -->
      <PagePropsSection v-if="store.device === 'doc'" />
      <span v-else class="text-gray-400">未选中元素</span>
    </div>

    <div v-else class="space-y-2 text-xs">
      <div class="flex items-center justify-between">
        <span class="rounded bg-gray-100 px-1.5 py-0.5 text-gray-500">{{ el.type }}</span>
        <button
          type="button"
          class="rounded border px-1.5 py-0.5"
          :class="
            confirmingDelete
              ? 'border-red-500 bg-red-500 text-white'
              : 'border-red-200 text-red-500 hover:bg-red-50'
          "
          data-testid="prop-delete"
          @click="onDelete"
        >
          {{ confirmingDelete ? '确认删除？' : '删除' }}
        </button>
      </div>

      <!-- label 呈现：绝对坐标 -->
      <template v-if="store.device === 'label'">
        <label v-for="row in labelRows" :key="row.key" class="flex items-center gap-2">
          <span class="w-8 text-gray-500">{{ row.label }}</span>
          <input
            :value="(el[row.key] as string) ?? ''"
            type="text"
            class="w-full rounded border border-gray-200 px-1.5 py-1"
            placeholder="如 5mm"
            :data-testid="`prop-${row.key}`"
            @change="setGeom(row.key, ($event.target as HTMLInputElement).value)"
          />
        </label>
      </template>

      <!-- text / barcode / qrcode 内容 -->
      <label v-if="['text', 'barcode', 'qrcode'].includes(el.type)" class="block">
        <span class="text-gray-500">内容</span>
        <textarea
          :value="(el.content as string) ?? ''"
          rows="2"
          class="mt-0.5 w-full rounded border border-gray-200 px-1.5 py-1"
          data-testid="prop-content"
          @change="store.updateSelected({ content: ($event.target as HTMLInputElement).value })"
        ></textarea>
      </label>
      <template v-if="['text', 'barcode', 'qrcode'].includes(el.type) && fullMode">
        <button
          type="button"
          class="w-full rounded border border-dashed border-gray-300 px-1.5 py-0.5 text-gray-500 hover:border-blue-300 hover:text-blue-600"
          data-testid="prop-content-fx"
          @click="fxField = fxField === 'content' ? null : 'content'"
        >
          {{ fxField === 'content' ? '收起表达式编辑器' : 'fx 表达式编辑器' }}
        </button>
        <ExpressionEditor
          v-if="fxField === 'content'"
          :model-value="(el.content as string) ?? ''"
          @update:model-value="store.updateSelected({ content: $event })"
        />
      </template>

      <!-- image 图源 -->
      <label v-if="el.type === 'image'" class="block">
        <span class="text-gray-500">图片地址</span>
        <input
          :value="(el.src as string) ?? ''"
          type="text"
          class="mt-0.5 w-full rounded border border-gray-200 px-1.5 py-1"
          data-testid="prop-src"
          @change="store.updateSelected({ src: ($event.target as HTMLInputElement).value })"
        />
      </label>

      <!-- barcode 制式/高度 -->
      <template v-if="el.type === 'barcode'">
        <label class="block">
          <span class="text-gray-500">制式</span>
          <select
            :value="(el.symbology as string) ?? 'CODE128'"
            class="mt-0.5 w-full rounded border border-gray-200 px-1.5 py-1"
            data-testid="prop-symbology"
            @change="
              store.updateSelected({ symbology: ($event.target as HTMLSelectElement).value })
            "
          >
            <option
              v-for="s in ['CODE128', 'EAN13', 'UPC', 'EAN8', 'CODE39', 'ITF']"
              :key="s"
              :value="s"
            >
              {{ s }}
            </option>
          </select>
        </label>
        <label class="block">
          <span class="text-gray-500">高度</span>
          <input
            :value="(el.height as string) ?? ''"
            type="text"
            class="mt-0.5 w-full rounded border border-gray-200 px-1.5 py-1"
            placeholder="如 10mm"
            @change="
              store.updateSelected({
                height: ($event.target as HTMLInputElement).value || undefined,
              })
            "
          />
        </label>
      </template>

      <!-- qrcode 模块大小 -->
      <label v-if="el.type === 'qrcode'" class="block">
        <span class="text-gray-500">模块大小</span>
        <input
          :value="(el.size as number) ?? 8"
          type="number"
          min="1"
          max="20"
          class="mt-0.5 w-full rounded border border-gray-200 px-1.5 py-1"
          @change="
            store.updateSelected({ size: Number(($event.target as HTMLInputElement).value) })
          "
        />
      </label>

      <!-- table 数据源 -->
      <label v-if="el.type === 'table'" class="block">
        <span class="text-gray-500">数据源</span>
        <select
          :value="(el.source as string) ?? ''"
          class="mt-0.5 w-full rounded border border-gray-200 px-1.5 py-1"
          data-testid="prop-source"
          @change="store.updateSelected({ source: ($event.target as HTMLSelectElement).value })"
        >
          <option value="" disabled>选择数据源</option>
          <option v-for="name in dataSourceNames" :key="name" :value="name">
            {{ name }}
          </option>
        </select>
      </label>

      <!-- line 样式 -->
      <label v-if="el.type === 'line'" class="block">
        <span class="text-gray-500">线型</span>
        <select
          :value="(el.lineStyle as string) ?? 'solid'"
          class="mt-0.5 w-full rounded border border-gray-200 px-1.5 py-1"
          @change="store.updateSelected({ lineStyle: ($event.target as HTMLSelectElement).value })"
        >
          <option value="solid">实线</option>
          <option value="dashed">虚线</option>
          <option value="dotted">点线</option>
        </select>
      </label>

      <!-- DSL 2.0 table 能力（块 C）：layout + 列/多级表头/分组/自由行编辑器 -->
      <template v-if="el.type === 'table'">
        <label class="flex items-center gap-2">
          <input
            type="checkbox"
            :checked="!!el.layout?.repeatHeaderOnPageBreak"
            data-testid="prop-repeat-header"
            @change="toggleRepeatHeader(($event.target as HTMLInputElement).checked)"
          />
          跨页重复表头
        </label>

        <details class="rounded border border-gray-200 p-1.5" data-testid="props-columns">
          <summary class="cursor-pointer text-gray-500">列（{{ tableColumns.length }}）</summary>
          <div class="mt-1.5">
            <ColumnListEditor
              :columns="tableColumns"
              :detail-sources="detailSourceNames"
              @update="store.updateSelected({ columns: $event })"
            />
          </div>
        </details>

        <details class="rounded border border-gray-200 p-1.5" data-testid="props-header-rows">
          <summary class="cursor-pointer text-gray-500">
            多级表头（{{ headerRows.length ? `${headerRows.length} 行` : '未启用' }}）
          </summary>
          <div class="mt-1.5">
            <template v-if="headerRows.length">
              <HeaderRowsEditor
                :rows="headerRows"
                :errors="elementErrors"
                @update="store.updateSelected({ headerRows: $event })"
              />
              <button
                type="button"
                class="mt-1 w-full rounded border border-red-200 px-1.5 py-0.5 text-red-500 hover:bg-red-50"
                data-testid="prop-header-rows-remove"
                @click="store.updateSelected({ headerRows: undefined })"
              >
                移除多级表头（回退单行）
              </button>
            </template>
            <button
              v-else
              type="button"
              class="w-full rounded border border-dashed border-gray-300 px-1.5 py-1 text-gray-500 hover:border-blue-300 hover:text-blue-600"
              data-testid="prop-header-rows-create"
              @click="createHeaderRows"
            >
              + 启用多级表头（按当前 {{ colCount || 1 }} 列初始化）
            </button>
          </div>
        </details>

        <details class="rounded border border-gray-200 p-1.5" data-testid="props-groups">
          <summary class="cursor-pointer text-gray-500">
            分组小计（{{ tableGroups.length }}）
          </summary>
          <div class="mt-1.5">
            <GroupsEditor
              :groups="tableGroups"
              :col-count="colCount"
              :errors="elementErrors"
              @update="store.updateSelected({ groups: $event.length ? $event : undefined })"
            />
          </div>
        </details>

        <details class="rounded border border-gray-200 p-1.5" data-testid="props-static-rows">
          <summary class="cursor-pointer text-gray-500">
            自由合并行（{{ staticRows ? `${staticRows.rows.length} 行` : '未启用' }}）
          </summary>
          <div class="mt-1.5">
            <StaticRowsEditor
              :model-value="staticRows"
              :errors="elementErrors"
              @update="store.updateSelected({ staticRows: $event })"
            />
          </div>
        </details>
      </template>

      <!-- DSL 2.0 容器（loop/conditional）属性分区 -->
      <ContainerPropsSection
        v-if="el.type === 'loop' || el.type === 'conditional'"
        :errors="elementErrors"
      />

      <!-- 文本样式（text/kvtable/table 共用 style） -->
      <template v-if="['text', 'kvtable', 'table'].includes(el.type)">
        <label class="flex items-center gap-2">
          <span class="w-8 text-gray-500">字号</span>
          <input
            :value="Number(el.style?.fontSize) || 12"
            type="number"
            min="6"
            max="72"
            class="w-full rounded border border-gray-200 px-1.5 py-1"
            data-testid="prop-font-size"
            @change="stylePatch({ fontSize: Number(($event.target as HTMLInputElement).value) })"
          />
        </label>
        <label class="flex items-center gap-2">
          <span class="w-8 text-gray-500">对齐</span>
          <select
            :value="el.style?.align ?? 'left'"
            class="w-full rounded border border-gray-200 px-1.5 py-1"
            @change="
              stylePatch({
                align: ($event.target as HTMLSelectElement).value as ElementStyle['align'],
              })
            "
          >
            <option value="left">左</option>
            <option value="center">中</option>
            <option value="right">右</option>
          </select>
        </label>
        <div class="flex items-center gap-3">
          <label class="flex items-center gap-1">
            <input
              type="checkbox"
              :checked="!!el.style?.bold"
              @change="stylePatch({ bold: ($event.target as HTMLInputElement).checked })"
            />
            粗体
          </label>
          <label class="flex items-center gap-1">
            <input
              type="checkbox"
              :checked="!!el.style?.italic"
              @change="stylePatch({ italic: ($event.target as HTMLInputElement).checked })"
            />
            斜体
          </label>
        </div>
      </template>

      <details class="rounded border border-gray-200 p-1.5">
        <summary class="cursor-pointer text-gray-500">DSL 片段</summary>
        <pre
          class="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all text-[10px] text-gray-500"
          >{{ JSON.stringify(el, null, 2) }}</pre>
      </details>
    </div>
  </fieldset>
</template>
