<script setup lang="ts">
// 容器属性分区（loop/conditional）：each 下拉（仅 detail 源）、when 输入（JS 真值
// 规则提示，表达式真值契约）、body/elseBody 子元素最小编辑（加 text/line、编辑 content、
// 删除、上下移）。嵌套选中不做（暂不支持），子元素编辑经整体替换写回（专项步骤 4 块 C）。
import { computed, defineAsyncComponent, ref, watch } from 'vue';
import type { ValidationError } from 'taprint';
import { useDesignerStore } from '../../store';
import type { CanvasElement } from '../../types';
import { V2_ERROR_HINTS } from '../../../shared/dsl';
import { useMode } from '../../../shared/mode';

defineProps<{ errors: ValidationError[] }>();

const store = useDesignerStore();
const el = computed(() => store.selectedElement);

// when 表达式编辑器入口（仅 full 模式；monaco 首次打开才加载）
const fullMode = useMode() === 'full';
const ExpressionEditor = defineAsyncComponent(
  () => import('../../../expression/ExpressionEditor.vue'),
);
const fxWhen = ref(false);
watch(el, () => {
  fxWhen.value = false;
});

const detailSources = computed(() =>
  (store.dsl?.dataSources ?? []).filter((ds) => ds.type === 'detail').map((ds) => ds.name),
);

// 模板内嵌 {{ 会破坏模板解析，提示文案在脚本侧拼接
const whenHint =
  "when 运行期按 JS 真值规则求值：0 / '' / null / undefined / false / NaN 为假，其余为真（设计契约）";

type BranchKey = 'body' | 'elseBody';

function branchOf(key: BranchKey): CanvasElement[] {
  return (el.value?.[key] as CanvasElement[] | undefined) ?? [];
}

function patchBranch(key: BranchKey, arr: CanvasElement[]): void {
  store.updateSelected({ [key]: arr });
}

function addChild(key: BranchKey, type: 'text' | 'line'): void {
  const child: CanvasElement =
    type === 'text' ? { type: 'text', content: '' } : { type: 'line', lineStyle: 'solid' };
  patchBranch(key, [...branchOf(key), child]);
}

function removeChild(key: BranchKey, index: number): void {
  const arr = branchOf(key);
  if (arr.length <= 1) return;
  patchBranch(
    key,
    arr.filter((_, i) => i !== index),
  );
}

function moveChild(key: BranchKey, index: number, delta: -1 | 1): void {
  const arr = [...branchOf(key)];
  const j = index + delta;
  if (j < 0 || j >= arr.length) return;
  [arr[index], arr[j]] = [arr[j], arr[index]];
  patchBranch(key, arr);
}

function setChildContent(key: BranchKey, index: number, content: string): void {
  patchBranch(
    key,
    branchOf(key).map((c, i) => (i === index ? { ...c, content } : c)),
  );
}
</script>

<template>
  <div class="space-y-2">
    <!-- loop：each 必须引用 detail 源（loop-each-not-detail 就近展示） -->
    <template v-if="el?.type === 'loop'">
      <div
        v-for="e in errors.filter((x) => x.code === 'loop-each-not-detail')"
        :key="e.path"
        class="rounded bg-red-50 px-1.5 py-1 text-red-600"
        data-testid="inline-error-loop-each"
      >
        [{{ e.code }}] {{ e.message }}
        <div class="text-red-400">{{ V2_ERROR_HINTS[e.code] }}</div>
      </div>
      <label class="block">
        <span class="text-gray-500">循环源（each）</span>
        <select
          :value="(el.each as string) ?? ''"
          class="mt-0.5 w-full rounded border border-gray-200 px-1.5 py-1"
          data-testid="container-each"
          @change="store.updateSelected({ each: ($event.target as HTMLSelectElement).value })"
        >
          <option value="" disabled>选择 detail 数据源</option>
          <option v-for="name in detailSources" :key="name" :value="name">
            {{ name }}
          </option>
        </select>
      </label>
    </template>

    <!-- conditional：when 表达式（JS 真值规则） -->
    <template v-if="el?.type === 'conditional'">
      <label class="block">
        <span class="text-gray-500">条件表达式（when）</span>
        <input
          :value="(el.when as string) ?? ''"
          type="text"
          class="mt-0.5 w-full rounded border border-gray-200 px-1.5 py-1"
          data-testid="container-when"
          @change="store.updateSelected({ when: ($event.target as HTMLInputElement).value })"
        />
      </label>
      <p class="text-[10px] text-gray-400">{{ whenHint }}</p>
      <template v-if="fullMode">
        <button
          type="button"
          class="w-full rounded border border-dashed border-gray-300 px-1.5 py-0.5 text-gray-500 hover:border-blue-300 hover:text-blue-600"
          data-testid="container-when-fx"
          @click="fxWhen = !fxWhen"
        >
          {{ fxWhen ? '收起表达式编辑器' : 'fx 表达式编辑器' }}
        </button>
        <ExpressionEditor
          v-if="fxWhen"
          :model-value="(el.when as string) ?? ''"
          @update:model-value="store.updateSelected({ when: $event })"
        />
      </template>
    </template>

    <!-- body / elseBody 子元素最小编辑 -->
    <template
      v-for="branch in el?.type === 'conditional'
        ? (['body', 'elseBody'] as const)
        : (['body'] as const)"
      :key="branch"
    >
      <section class="rounded border border-gray-200 p-1.5">
        <h4 class="mb-1 text-gray-500">
          {{ branch === 'body' ? '容器内容（body）' : '否则分支（elseBody）' }}
        </h4>
        <div
          v-for="(child, i) in branchOf(branch)"
          :key="i"
          class="mb-1 flex items-center gap-1"
          :data-testid="`container-${branch}-item-${i}`"
        >
          <span class="rounded bg-gray-100 px-1 text-[10px] text-gray-500">{{ child.type }}</span>
          <input
            v-if="child.type === 'text'"
            :value="(child.content as string) ?? ''"
            type="text"
            class="w-full min-w-0 rounded border border-gray-200 px-1 py-0.5"
            :data-testid="`container-${branch}-content-${i}`"
            @change="setChildContent(branch, i, ($event.target as HTMLInputElement).value)"
          />
          <button
            type="button"
            class="rounded px-1 text-gray-400 hover:bg-gray-100 disabled:opacity-30"
            :disabled="i === 0"
            :data-testid="`container-${branch}-up-${i}`"
            aria-label="上移"
            @click="moveChild(branch, i, -1)"
          >
            ↑
          </button>
          <button
            type="button"
            class="rounded px-1 text-gray-400 hover:bg-gray-100 disabled:opacity-30"
            :disabled="i === branchOf(branch).length - 1"
            :data-testid="`container-${branch}-down-${i}`"
            aria-label="下移"
            @click="moveChild(branch, i, 1)"
          >
            ↓
          </button>
          <button
            type="button"
            class="rounded px-1 text-gray-400 hover:bg-red-50 hover:text-red-500"
            :data-testid="`container-${branch}-remove-${i}`"
            aria-label="删除子元素"
            @click="removeChild(branch, i)"
          >
            ×
          </button>
        </div>
        <p v-if="!branchOf(branch).length" class="text-gray-400">（空）</p>
        <div class="flex gap-1">
          <button
            type="button"
            class="rounded border border-gray-200 px-1.5 py-0.5 text-gray-500 hover:border-blue-300 hover:text-blue-600"
            :data-testid="`container-${branch}-add-text`"
            @click="addChild(branch, 'text')"
          >
            + 文本
          </button>
          <button
            type="button"
            class="rounded border border-gray-200 px-1.5 py-0.5 text-gray-500 hover:border-blue-300 hover:text-blue-600"
            :data-testid="`container-${branch}-add-line`"
            @click="addChild(branch, 'line')"
          >
            + 直线
          </button>
        </div>
      </section>
    </template>
  </div>
</template>
