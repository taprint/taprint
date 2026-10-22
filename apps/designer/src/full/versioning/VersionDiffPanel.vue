<script setup lang="ts">
// 版本差异面板：任选两版本 / 版本 vs 草稿。
// diff.ts 纯函数：第一道 dslHash 相等判定 → 字段级三态差异清单（新增/删除/修改着色）。
import { computed, ref } from 'vue';
import type { TemplateLike } from '../../canvas/store';
import type { TemplateVersion } from '../../template-domain';
import { diffDsl, type FieldDiff } from './diff';

const props = defineProps<{
  /** 当前草稿（可为 null = 模板不存在/加载中） */
  draft: TemplateLike | null;
  /** 版本历史（升序） */
  versions: TemplateVersion[];
  /** 当前指向的已发布版本号（diff 默认 B 侧） */
  currentVersion: number | null;
}>();

/** 选择项：'draft' = 草稿，数字 = 版本号 */
type PickSide = 'draft' | number;

const pickA = ref<PickSide>('draft');
const pickB = ref<PickSide>(props.currentVersion ?? 'draft');

const selectOptions = computed<Array<{ label: string; value: PickSide }>>(() => [
  { label: '草稿（未发布）', value: 'draft' },
  ...[...props.versions]
    .sort((a, b) => b.version - a.version)
    .map((v) => ({ label: `v${v.version}（${v.status}）`, value: v.version })),
]);

function sourceOf(pick: PickSide): TemplateLike | null {
  if (pick === 'draft') return props.draft;
  // 兜底数字/字符串（测试与 DOM select 的 value 形态差异）：Number 归一后按版本号匹配
  return props.versions.find((v) => v.version === Number(pick))?.dsl ?? null;
}

const result = computed(() => {
  const a = sourceOf(pickA.value);
  const b = sourceOf(pickB.value);
  if (!a || !b) return null;
  return diffDsl(a, b);
});

/** 差异清单按路径排序（稳定展示），相等状态单独呈现 */
const sortedChanges = computed<FieldDiff[]>(() => {
  const changes = result.value?.changes ?? [];
  return [...changes].sort((x, y) => x.path.localeCompare(y.path));
});

const stateLabel: Record<FieldDiff['state'], string> = {
  added: '新增',
  removed: '删除',
  modified: '修改',
};

const stateClass: Record<FieldDiff['state'], string> = {
  added: 'bg-green-50 text-green-700',
  removed: 'bg-red-50 text-red-700',
  modified: 'bg-amber-50 text-amber-700',
};
</script>

<template>
  <div class="rounded border border-gray-200 bg-white p-4" data-testid="diff-panel">
    <h2 class="text-sm font-semibold text-gray-700">版本差异对比</h2>
    <div class="mt-2 flex flex-wrap items-center gap-2 text-sm">
      <select
        v-model="pickA"
        data-testid="diff-select-a"
        class="rounded border border-gray-300 px-2 py-1"
      >
        <option v-for="opt in selectOptions" :key="opt.label" :value="opt.value">
          {{ opt.label }}
        </option>
      </select>
      <span class="text-gray-400">对比</span>
      <select
        v-model="pickB"
        data-testid="diff-select-b"
        class="rounded border border-gray-300 px-2 py-1"
      >
        <option v-for="opt in selectOptions" :key="opt.label" :value="opt.value">
          {{ opt.label }}
        </option>
      </select>
    </div>

    <p v-if="result && result.equal" class="mt-3 text-xs text-green-700" data-testid="diff-equal">
      内容一致（dslHash 相等，无差异）
    </p>
    <p v-else-if="result && sortedChanges.length === 0" class="mt-3 text-xs text-gray-500">
      选择两侧后展示字段级差异
    </p>
    <ul v-else-if="result" class="mt-3 space-y-1" data-testid="diff-change-list">
      <li
        v-for="c in sortedChanges"
        :key="c.path"
        class="rounded px-2 py-1 text-xs"
        :class="stateClass[c.state]"
        data-testid="diff-change-row"
      >
        <span class="font-semibold">{{ c.path }}</span>
        <span class="ml-2 rounded bg-white/70 px-1">{{ stateLabel[c.state] }}</span>
        <div v-if="c.state === 'added'" class="mt-0.5 break-all text-green-800">
          {{ c.after }}
        </div>
        <div v-else-if="c.state === 'removed'" class="mt-0.5 break-all text-red-800">
          {{ c.before }}
        </div>
        <div v-else class="mt-0.5 break-all">
          <span class="text-red-800 line-through decoration-red-400">{{ c.before }}</span>
          <span class="mx-1 text-gray-400">→</span>
          <span class="text-green-800">{{ c.after }}</span>
        </div>
      </li>
    </ul>
    <p v-else class="mt-3 text-xs text-gray-500">版本历史为空或草稿未加载。</p>
  </div>
</template>
