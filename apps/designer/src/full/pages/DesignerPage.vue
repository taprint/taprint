<script setup lang="ts">
// 设计器主页面（full 模式路由页；接入 template-domain Repository， 。
//
// 预载机制（DesignerWorkbench/store 零改动——禁改区，已实测核实可行路径）：
// - setup 阶段 await repo.get(id) → store.loadTemplate(dsl) → 渲染 workbench；
// - 子组件 mounted 时 !store.dsl 为 false（已预载），样例兜底不触发；
// - 不存在 → 404 友好态，不挂 workbench。
//
// /design/sample 兼容路由：在 routes.ts 路由层 redirect 到 /design/1（sales-note seed），
// DesignerPage 仅处理数字 id；既存 e2e 流程（open-designer → sample-select）经此保持通过。
//
// 保存写回：workbench 既有 saveChannel prop 注入（公开 prop，传参不构成改动）；
// prepareSave 门禁通过后调 repo.save 写当前路由模板的草稿（updatedAt 更新，
// 血缘/版本字段不动）。
//
// 样例下拉语义：保留 workbench 顶栏下拉（既有 e2e 7 处依赖）；下拉切换的是 store 内存
// 草稿，与当前路由模板的 Repository 草稿相互独立——下拉载入样例后保存仅写当前路由模板
// ）。
import { onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import DesignerWorkbench from '@/canvas/DesignerWorkbench.vue';
import { useDesignerStore, type TemplateLike } from '@/canvas/store';
import { getSharedRepository, TemplateNotFoundError } from '@/template-domain';

const route = useRoute();
const store = useDesignerStore();
const repo = getSharedRepository();

const loading = ref(true);
const notFound = ref(false);
const notFoundId = ref<string>('');
const loadError = ref<string | null>(null);
const templateId = ref<number | null>(null);
const templateName = ref<string>('');
/** 最近一次保存时间锚点（UI 反馈，无业务语义） */
const lastSavedAt = ref<number | null>(null);

function parseId(raw: string): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

async function loadTemplate(id: number): Promise<void> {
  const record = await repo.get(id);
  if (!record) {
    notFound.value = true;
    notFoundId.value = String(id);
    loading.value = false;
    return;
  }
  templateId.value = record.id;
  templateName.value = record.name;
  // store.loadTemplate 内部完成 detectVersion → 迁移 → 校验（迁移后 dsl.schemaVersion=CURRENT_VERSION）
  const ok = store.loadTemplate(record.dsl);
  if (!ok) {
    loadError.value = store.loadNote ?? '模板加载失败';
  }
  loading.value = false;
}

async function saveChannel(dsl: TemplateLike): Promise<void> {
  if (templateId.value === null) return;
  try {
    await repo.save(templateId.value, dsl);
    lastSavedAt.value = Date.now();
    loadError.value = null;
  } catch (e) {
    loadError.value = `保存失败：${(e as Error).message}`;
  }
}

onMounted(async () => {
  const raw = route.params.id as string;
  const parsed = parseId(raw);
  if (parsed === null) {
    notFound.value = true;
    notFoundId.value = raw;
    loading.value = false;
    return;
  }
  try {
    await loadTemplate(parsed);
  } catch (e) {
    if (e instanceof TemplateNotFoundError) {
      notFound.value = true;
      notFoundId.value = String(parsed);
    } else {
      loadError.value = (e as Error).message;
    }
    loading.value = false;
  }
});
</script>

<template>
  <div class="flex h-full flex-col">
    <div
      v-if="loading"
      class="flex h-full items-center justify-center text-sm text-gray-400"
      data-testid="designer-loading"
    >
      加载模板中…
    </div>

    <div
      v-else-if="notFound"
      class="flex h-full flex-col items-center justify-center gap-3 p-6 text-sm"
      data-testid="designer-not-found"
    >
      <p class="text-base font-medium text-gray-700">模板不存在（id={{ notFoundId }}）</p>
      <p class="text-xs text-gray-500">请从<a class="text-blue-600" href="/">模板列表</a>进入。</p>
    </div>

    <template v-else>
      <!-- 顶部信息条：模板名 + 最近保存时间 + 加载/保存错误 + 样例下拉误操作提示 -->
      <div
        class="flex flex-wrap items-center gap-2 border-b border-gray-200 px-3 py-1 text-xs"
        data-testid="designer-infobar"
      >
        <span class="font-medium text-gray-700">{{ templateName }}</span>
        <span class="text-gray-400">· id={{ templateId }}</span>
        <span
          v-if="lastSavedAt"
          data-testid="designer-last-saved"
          class="rounded bg-green-50 px-1.5 py-0.5 text-[10px] text-green-700"
        >
          已保存 {{ new Date(lastSavedAt).toISOString().slice(11, 19) }} UTC
        </span>
        <span
          v-if="loadError"
          data-testid="designer-load-error"
          class="rounded bg-red-50 px-1.5 py-0.5 text-[10px] text-red-700"
        >
          {{ loadError }}
        </span>
        <div class="flex-1" />
        <span
          class="rounded bg-amber-50 px-1.5 py-0.5 text-[10px] text-amber-700"
          data-testid="sample-dropdown-hint"
        >
          顶栏『样例模板』下拉载入的样例会替换当前未保存草稿，保存将写入本模板（id={{
            templateId
          }}）
        </span>
      </div>
      <!-- saveChannel 注入写回 Repository；workbench 自身的 sample-select/onMounted 兜底保留不动 -->
      <DesignerWorkbench class="min-h-0 flex-1" :save-channel="saveChannel" />
    </template>
  </div>
</template>
