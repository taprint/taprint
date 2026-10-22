<script setup lang="ts">
// 血缘视图页（sourceTemplateId 副本关系可视化）。
//
// 实现要点：
// - 焦点模板加载（repository.get + getLineage）+ 加载/空/错误三态。
// - 祖先链（sourceTemplateId 逐级上溯）+ 后代树（一级/多级列表）。
// - 节点显示：名称 / 当前版本 currentVersion / 更新时间。
// - 跳转：RouterLink to /design/:id（设计器）+ /versions/:id（版本页）。
// - 血缘页注明：与「门店覆盖链（后端 parent_id）」是两个独立概念。
// - "继承不联动"显式声明（设计契约）。
//
// 只读打开：DesignerPage 现为 4 行壳不读 query.readOnly，本页跳转设计器走普通
// /design/:id（与列表页跳转一致），不做只读特殊处理——保持 DesignerPage 职责单一。
import { computed, onMounted, ref } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';
import {
  getSharedRepository,
  type TemplateLineage,
  type TemplateMeta,
  type TemplateRecord,
} from '@/template-domain';

const route = useRoute();
const router = useRouter();

const focusTemplate = ref<TemplateRecord | null>(null);
const lineage = ref<TemplateLineage | null>(null);
const loading = ref(true);
const errorMsg = ref<string | null>(null);

const focusId = computed(() => Number(route.params.id));

function formatTime(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  // TZ=UTC（项目口径）：toJSON 输出 ISO 即 UTC，便于跨端一致
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

function versionLabel(meta: TemplateMeta): string {
  if (meta.currentVersion === null) return '草稿';
  return `v${meta.currentVersion}`;
}

async function load(): Promise<void> {
  loading.value = true;
  errorMsg.value = null;
  try {
    const repo = getSharedRepository();
    const [tpl, lin] = await Promise.all([repo.get(focusId.value), repo.getLineage(focusId.value)]);
    focusTemplate.value = tpl;
    lineage.value = lin;
    if (tpl === null) {
      errorMsg.value = `模板 #${focusId.value} 不存在或已被删除。`;
    }
  } catch (e) {
    errorMsg.value =
      e instanceof Error && e.message.length > 0
        ? `加载血缘失败：${e.message}`
        : '加载血缘失败：未知错误。';
  } finally {
    loading.value = false;
  }
}

/** 节点点击：跳转该模板设计器 */
function gotoDesign(meta: TemplateMeta): void {
  void router.push(`/design/${meta.id}`);
}

/** 节点操作：跳转该模板版本页 */
function gotoVersions(meta: TemplateMeta): void {
  void router.push(`/versions/${meta.id}`);
}

/** 后代树缩进（按 depth 计算） */
function indentFor(depth: number): string {
  return `${depth * 16}px`;
}

onMounted(load);
</script>

<template>
  <section class="min-h-screen bg-gray-50 p-6">
    <!-- 标题与说明 -->
    <header class="mb-6 flex items-center justify-between">
      <div>
        <h1 class="text-xl font-semibold text-gray-800">
          模板血缘
          <span v-if="focusTemplate" class="ml-2 text-sm font-normal text-gray-500">
            焦点：{{ focusTemplate.name }}
          </span>
        </h1>
        <p data-testid="lineage-concept-note" class="mt-1 max-w-3xl text-xs text-gray-500">
          血缘（sourceTemplateId）= 另存为副本与源模板的关系，副本独立演化，
          <strong>基线变更不传播</strong>（设计契约）。血缘 ≠
          <strong>门店覆盖链</strong>（后端 parent_id，加载时合并、子覆盖父）——
          两者是独立概念，血缘页只呈现前者。
        </p>
      </div>
      <RouterLink
        to="/"
        class="rounded border border-gray-300 px-3 py-1 text-xs text-gray-600 hover:bg-gray-100"
      >
        返回列表
      </RouterLink>
    </header>

    <!-- 加载态 -->
    <div v-if="loading" data-testid="lineage-loading" class="text-sm text-gray-500">
      正在加载血缘信息…
    </div>

    <!-- 错误态 -->
    <div
      v-else-if="errorMsg"
      data-testid="lineage-error"
      class="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700"
    >
      {{ errorMsg }}
    </div>

    <!-- 空态：模板存在但无祖先无后代 -->
    <div
      v-else-if="
        focusTemplate &&
        lineage &&
        lineage.ancestors.length === 0 &&
        lineage.descendants.length === 0
      "
      data-testid="lineage-empty"
      class="rounded border border-gray-200 bg-white p-4 text-sm text-gray-500"
    >
      本模板无血缘关系：既非另存为副本，也未被其他模板另存为来源。
    </div>

    <!-- 血缘视图主体 -->
    <div v-else-if="focusTemplate && lineage" class="grid grid-cols-1 gap-6 lg:grid-cols-2">
      <!-- 焦点模板卡片 -->
      <section class="rounded border border-blue-300 bg-blue-50 p-4 shadow-sm lg:col-span-2">
        <h2 class="mb-2 text-sm font-semibold text-blue-800">焦点模板</h2>
        <div class="flex items-center justify-between">
          <div>
            <span data-testid="lineage-focus-name" class="font-medium text-gray-800">
              {{ focusTemplate.name }}
            </span>
            <span
              data-testid="lineage-focus-version"
              class="ml-2 rounded bg-blue-100 px-2 py-0.5 text-xs text-blue-700"
            >
              {{ versionLabel(focusTemplate) }}
            </span>
            <span
              v-if="focusTemplate.sourceTemplateId !== null"
              data-testid="lineage-focus-source"
              class="ml-2 text-xs text-gray-500"
            >
              来源：模板 #{{ focusTemplate.sourceTemplateId }}
              <span v-if="focusTemplate.sourceVersion !== null">
                v{{ focusTemplate.sourceVersion }}
              </span>
            </span>
          </div>
          <div class="flex gap-2 text-xs">
            <button
              type="button"
              data-testid="lineage-focus-goto-design"
              class="rounded border border-gray-300 px-2 py-0.5 text-gray-600 hover:bg-white"
              @click="gotoDesign(focusTemplate)"
            >
              打开设计器
            </button>
            <button
              type="button"
              data-testid="lineage-focus-goto-versions"
              class="rounded border border-gray-300 px-2 py-0.5 text-gray-600 hover:bg-white"
              @click="gotoVersions(focusTemplate)"
            >
              版本历史
            </button>
          </div>
        </div>
      </section>

      <!-- 祖先链 -->
      <section
        v-if="lineage.ancestors.length > 0"
        class="rounded border border-gray-200 bg-white p-4 shadow-sm"
      >
        <h2 class="mb-3 text-sm font-semibold text-gray-700">
          祖先链（共 {{ lineage.ancestors.length }} 级）
        </h2>
        <ol data-testid="lineage-ancestors" class="space-y-2">
          <li
            v-for="(ancestor, idx) in lineage.ancestors"
            :key="ancestor.id"
            :data-testid="`lineage-ancestor-${idx}`"
            class="rounded border border-gray-100 bg-gray-50 p-2"
            :style="{ marginLeft: indentFor(idx) }"
          >
            <div class="flex items-center justify-between">
              <div class="flex items-center gap-2">
                <span class="text-xs text-gray-400">{{ idx + 1 }}.</span>
                <span class="text-sm text-gray-800">{{ ancestor.name }}</span>
                <span class="rounded bg-gray-200 px-1.5 py-0.5 text-[10px] text-gray-600">
                  {{ versionLabel(ancestor) }}
                </span>
              </div>
              <div class="flex gap-1 text-[10px]">
                <button
                  type="button"
                  :data-testid="`lineage-ancestor-${idx}-design`"
                  class="rounded border border-gray-300 px-1.5 py-0.5 text-gray-600 hover:bg-white"
                  @click="gotoDesign(ancestor)"
                >
                  设计器
                </button>
                <button
                  type="button"
                  :data-testid="`lineage-ancestor-${idx}-versions`"
                  class="rounded border border-gray-300 px-1.5 py-0.5 text-gray-600 hover:bg-white"
                  @click="gotoVersions(ancestor)"
                >
                  版本
                </button>
              </div>
            </div>
            <div class="mt-0.5 text-[10px] text-gray-400">
              更新：{{ formatTime(ancestor.updatedAt) }} · ID #{{ ancestor.id }}
            </div>
          </li>
        </ol>
        <p v-if="lineage.ancestors.length === 0" class="text-xs text-gray-400">
          （无祖先：本模板不是任何模板的副本）
        </p>
      </section>

      <!-- 后代树 -->
      <section
        v-if="lineage.descendants.length > 0"
        class="rounded border border-gray-200 bg-white p-4 shadow-sm"
      >
        <h2 class="mb-3 text-sm font-semibold text-gray-700">
          后代树（共 {{ lineage.descendants.length }} 个副本）
        </h2>
        <ul data-testid="lineage-descendants" class="space-y-2">
          <li
            v-for="(descendant, idx) in lineage.descendants"
            :key="descendant.id"
            :data-testid="`lineage-descendant-${idx}`"
            class="rounded border border-gray-100 bg-gray-50 p-2"
          >
            <div class="flex items-center justify-between">
              <div class="flex items-center gap-2">
                <span class="text-xs text-gray-400">→</span>
                <span class="text-sm text-gray-800">{{ descendant.name }}</span>
                <span class="rounded bg-gray-200 px-1.5 py-0.5 text-[10px] text-gray-600">
                  {{ versionLabel(descendant) }}
                </span>
                <span v-if="descendant.sourceVersion !== null" class="text-[10px] text-gray-400">
                  源 v{{ descendant.sourceVersion }}
                </span>
              </div>
              <div class="flex gap-1 text-[10px]">
                <button
                  type="button"
                  :data-testid="`lineage-descendant-${idx}-design`"
                  class="rounded border border-gray-300 px-1.5 py-0.5 text-gray-600 hover:bg-white"
                  @click="gotoDesign(descendant)"
                >
                  设计器
                </button>
                <button
                  type="button"
                  :data-testid="`lineage-descendant-${idx}-versions`"
                  class="rounded border border-gray-300 px-1.5 py-0.5 text-gray-600 hover:bg-white"
                  @click="gotoVersions(descendant)"
                >
                  版本
                </button>
              </div>
            </div>
            <div class="mt-0.5 text-[10px] text-gray-400">
              更新：{{ formatTime(descendant.updatedAt) }} · ID #{{ descendant.id }}
            </div>
          </li>
        </ul>
        <p v-if="lineage.descendants.length === 0" class="text-xs text-gray-400">
          （无后代：本模板尚未被另存为来源）
        </p>
      </section>

      <!-- 继承不联动声明 -->
      <section
        data-testid="lineage-inheritance-note"
        class="rounded border border-yellow-200 bg-yellow-50 p-3 text-xs text-yellow-800 lg:col-span-2"
      >
        <strong>继承 = 血缘级，不做字段级联动。</strong>
        每个副本是独立模板，基线模板的后续修改<strong>不会自动传播</strong>到副本。
        若需同步基线变更，请在副本的设计器中手动重新另存为或导入。
      </section>
    </div>
  </section>
</template>
