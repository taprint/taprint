<script setup lang="ts">
// Field 面板：字段拖入（点击插入 {{source.field}} 文本）+ 元素库（设计契约）
import { computed } from 'vue';
import { elementLibrary } from '../element-library';
import { useDesignerStore } from '../store';

const store = useDesignerStore();

// 元素库按 devices 门禁（专项步骤 4：loop/conditional 仅 doc 可见）
const availableElements = computed(() =>
  elementLibrary.filter((it) => !it.devices || (store.device && it.devices.includes(store.device))),
);

interface FieldEntry {
  source: string;
  field: string;
}

// fieldSchema：叶子为类型字符串，嵌套对象为子结构——展平为点路径
function flattenFields(schema: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(schema).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return typeof value === 'string'
      ? [path]
      : flattenFields(value as Record<string, unknown>, path);
  });
}

const fields = computed<FieldEntry[]>(() =>
  (store.dsl?.dataSources ?? []).flatMap((ds) =>
    flattenFields(ds.schema).map((field) => ({ source: ds.name, field })),
  ),
);

function insertField(entry: FieldEntry): void {
  if (!store.device) return;
  store.addElement({
    type: 'text',
    content: `{{${entry.source}.${entry.field}}}`,
    ...(store.device === 'label' ? { x: '5mm', y: `${5 + store.activeBody.length * 12}mm` } : {}),
  });
}

function insertElement(type: string): void {
  if (!store.device) return;
  const item = elementLibrary.find((it) => it.type === type);
  if (!item || (item.devices && !item.devices.includes(store.device))) return;
  store.addElement(item.create(store.device, store.activeBody.length, store.firstDetailSource));
}
</script>

<template>
  <!--
    readOnly 完整编辑锁。
    根 fieldset[disabled] 让字段插入/元素库添加按钮一律 disabled（HTML 标准 inheritance）。
    视觉灰态经 main.css 的 fieldset.embed-readonly-lock:disabled。
  -->
  <fieldset
    :disabled="store.readOnly"
    :data-readonly="store.readOnly ? 'true' : 'false'"
    class="embed-readonly-lock space-y-4"
    data-testid="field-panel"
  >
    <section>
      <h3 class="mb-1.5 text-xs font-semibold text-gray-500">字段</h3>
      <p v-if="!fields.length" class="text-xs text-gray-400">无数据源字段</p>
      <ul v-else class="space-y-1">
        <li v-for="f in fields" :key="`${f.source}.${f.field}`">
          <button
            type="button"
            class="w-full truncate rounded border border-gray-200 px-2 py-1 text-left text-xs text-gray-600 hover:border-blue-300 hover:text-blue-600"
            :title="`{{${f.source}.${f.field}}}`"
            data-testid="field-item"
            @click="insertField(f)"
          >
            {{ f.source }}.{{ f.field }}
          </button>
        </li>
      </ul>
    </section>

    <section>
      <h3 class="mb-1.5 text-xs font-semibold text-gray-500">元素</h3>
      <ul class="grid grid-cols-2 gap-1">
        <li v-for="item in availableElements" :key="item.type">
          <button
            type="button"
            class="w-full rounded border border-gray-200 px-2 py-1 text-xs text-gray-600 hover:border-blue-300 hover:text-blue-600"
            :data-testid="`element-add-${item.type}`"
            @click="insertElement(item.type)"
          >
            {{ item.label }}
          </button>
        </li>
      </ul>
    </section>
  </fieldset>
</template>
