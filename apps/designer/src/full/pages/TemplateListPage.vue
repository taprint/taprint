<script setup lang="ts">
// 模板列表页。
// 数据源：getSharedRepository()（mock 内存，刷新即重置）；CRUD/搜索/删除守卫/另存为入口；
// 三处跳转：/design/:id、/versions/:id、/lineage/:id。
// 既存 e2e 依赖保留：data-testid="open-designer" 指向 /design/sample（由 DesignerPage 重定向到 /design/1）。
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import {
  FetchTemplateRepository,
  getSharedRepository,
  TemplateHasDescendantsError,
  TemplateNotFoundError,
  type DeviceClass,
  type TemplateMeta,
} from '@/template-domain';
import SaveAsDialog from '@/full/components/SaveAsDialog.vue';

const router = useRouter();
const repo = getSharedRepository();
// 数据源形态（横幅如实告知，防 fetch 模式误显示 mock 文案）：
// VITE_SESSION_API_BASE 有值 → FetchTemplateRepository（真实后端）；否则内存 mock。
const isBackendRepo = repo instanceof FetchTemplateRepository;
const templates = ref<TemplateMeta[]>([]);
const loading = ref(true);
const errorMsg = ref<string | null>(null);
// 搜索关键词（按名称/描述模糊匹配，大小写不敏感）
const keyword = ref('');
// 重命名状态：当前正在编辑的 id 与暂存名称
const renamingId = ref<number | null>(null);
const renamingName = ref('');
// 删除二次确认（按 id 索引）
const confirmingDeleteId = ref<number | null>(null);
// 新建模板向导
const createOpen = ref(false);
const createName = ref('');
const createDevice = ref<DeviceClass>('receipt');

const filtered = computed<TemplateMeta[]>(() => {
  const k = keyword.value.trim().toLowerCase();
  if (!k) return templates.value;
  return templates.value.filter(
    (t) => t.name.toLowerCase().includes(k) || (t.description?.toLowerCase().includes(k) ?? false),
  );
});

async function reload(): Promise<void> {
  loading.value = true;
  errorMsg.value = null;
  try {
    templates.value = await repo.list();
  } catch (e) {
    errorMsg.value = (e as Error).message;
  } finally {
    loading.value = false;
  }
}

function deviceLabel(d: DeviceClass): string {
  switch (d) {
    case 'doc':
      return '文档';
    case 'receipt':
      return '小票';
    case 'label':
      return '标签';
  }
}

function formatTime(ms: number): string {
  // TZ=UTC 一致性：ISO 字符串稳定可测（不引入 toLocaleString 的时区不确定性）
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

function openDesigner(t: TemplateMeta): void {
  void router.push({ name: 'designer', params: { id: String(t.id) } });
}

function openVersions(t: TemplateMeta): void {
  void router.push({ name: 'version-history', params: { id: String(t.id) } });
}

function openLineage(t: TemplateMeta): void {
  void router.push({ name: 'template-lineage', params: { id: String(t.id) } });
}

function startRename(t: TemplateMeta): void {
  renamingId.value = t.id;
  renamingName.value = t.name;
  confirmingDeleteId.value = null;
}

async function confirmRename(t: TemplateMeta): Promise<void> {
  const name = renamingName.value.trim();
  if (!name || name === t.name) {
    renamingId.value = null;
    return;
  }
  try {
    await repo.rename(t.id, name);
    renamingId.value = null;
    await reload();
  } catch (e) {
    errorMsg.value = (e as Error).message;
  }
}

function cancelRename(): void {
  renamingId.value = null;
}

function startDelete(t: TemplateMeta): void {
  confirmingDeleteId.value = t.id;
  renamingId.value = null;
}

async function confirmDelete(t: TemplateMeta): Promise<void> {
  try {
    await repo.remove(t.id);
    confirmingDeleteId.value = null;
    await reload();
  } catch (e) {
    if (e instanceof TemplateHasDescendantsError) {
      errorMsg.value = e.message;
    } else if (e instanceof TemplateNotFoundError) {
      errorMsg.value = e.message;
    } else {
      errorMsg.value = (e as Error).message;
    }
    confirmingDeleteId.value = null;
  }
}

function cancelDelete(): void {
  confirmingDeleteId.value = null;
}

function openCreate(): void {
  createName.value = '';
  createDevice.value = 'receipt';
  createOpen.value = true;
}

async function confirmCreate(): Promise<void> {
  const name = createName.value.trim();
  if (!name) return;
  try {
    const created = await repo.create({ name, deviceClass: createDevice.value });
    createOpen.value = false;
    void router.push({ name: 'designer', params: { id: String(created.id) } });
  } catch (e) {
    errorMsg.value = (e as Error).message;
  }
}

function onDuplicated(record: { id: number }): void {
  // 另存为成功：跳转到新模板设计器
  void router.push({ name: 'designer', params: { id: String(record.id) } });
}

onMounted(reload);
</script>

<template>
  <section class="mx-auto max-w-6xl p-6">
    <header class="mb-4 flex items-center gap-3">
      <h1 class="text-lg font-semibold">模板列表</h1>
      <span v-if="isBackendRepo" class="text-xs text-gray-400" data-testid="repo-banner"
        >数据源：后端（模板持久化）</span
      >
      <span v-else class="text-xs text-gray-400" data-testid="repo-banner"
        >数据源：内存 mock（页面刷新即重置，持久化待后端 API）</span
      >
      <div class="flex-1" />
      <input
        v-model="keyword"
        type="search"
        placeholder="搜索名称/描述"
        data-testid="template-search"
        class="rounded border border-gray-300 px-2 py-1 text-sm"
      />
      <button
        type="button"
        data-testid="create-template"
        class="rounded bg-blue-600 px-3 py-1 text-sm text-white hover:bg-blue-700"
        @click="openCreate"
      >
        新建模板
      </button>
      <RouterLink
        to="/design/sample"
        class="rounded border border-gray-300 px-3 py-1 text-sm text-gray-700 hover:bg-gray-50"
        data-testid="open-designer"
      >
        进入设计器（样例模板）
      </RouterLink>
    </header>

    <p
      v-if="errorMsg"
      data-testid="template-list-error"
      class="mb-3 rounded bg-red-50 px-3 py-1 text-xs text-red-700"
    >
      {{ errorMsg }}
    </p>

    <div v-if="loading" class="text-sm text-gray-400">加载中…</div>

    <table
      v-else
      class="w-full table-fixed border-collapse text-sm"
      data-testid="template-list-table"
    >
      <thead class="bg-gray-50 text-xs text-gray-500">
        <tr>
          <th class="w-1/4 border px-2 py-1 text-left">名称</th>
          <th class="w-16 border px-2 py-1 text-left">设备类</th>
          <th class="w-20 border px-2 py-1 text-left">DSL</th>
          <th class="w-24 border px-2 py-1 text-left">当前版本</th>
          <th class="w-24 border px-2 py-1 text-left">血缘</th>
          <th class="w-44 border px-2 py-1 text-left">更新时间</th>
          <th class="border px-2 py-1 text-left">操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-if="!filtered.length">
          <td colspan="7" class="border px-2 py-3 text-center text-gray-400">
            {{ keyword ? '无匹配模板' : '尚无模板，点「新建模板」开始' }}
          </td>
        </tr>
        <tr v-for="t in filtered" :key="t.id" :data-testid="`template-row-${t.id}`">
          <td class="border px-2 py-1 align-top">
            <template v-if="renamingId === t.id">
              <input
                v-model="renamingName"
                type="text"
                :data-testid="`rename-input-${t.id}`"
                class="w-full rounded border border-gray-300 px-1 py-0.5 text-sm"
                @keydown.enter="confirmRename(t)"
                @keydown.esc="cancelRename"
              />
            </template>
            <template v-else>
              <button
                type="button"
                class="block w-full truncate text-left font-medium hover:text-blue-600"
                :title="t.description ?? t.name"
                :data-testid="`template-open-${t.id}`"
                @click="openDesigner(t)"
              >
                {{ t.name }}
              </button>
              <span v-if="t.description" class="block truncate text-[10px] text-gray-400">
                {{ t.description }}
              </span>
            </template>
          </td>
          <td class="border px-2 py-1 align-top" :data-testid="`template-device-${t.id}`">
            {{ deviceLabel(t.deviceClass) }}
          </td>
          <td class="border px-2 py-1 align-top">
            <span
              class="rounded bg-blue-50 px-1.5 py-0.5 text-xs text-blue-700"
              :data-testid="`template-schema-${t.id}`"
            >
              {{ t.dslSchemaVersion }}
            </span>
          </td>
          <td class="border px-2 py-1 align-top">
            <span
              v-if="t.currentVersion !== null"
              class="rounded bg-green-50 px-1.5 py-0.5 text-xs text-green-700"
              :data-testid="`template-version-${t.id}`"
            >
              v{{ t.currentVersion }}
            </span>
            <span v-else class="text-xs text-gray-400" :data-testid="`template-version-${t.id}`">
              —
            </span>
          </td>
          <td class="border px-2 py-1 align-top">
            <span
              v-if="t.sourceTemplateId !== null"
              class="rounded bg-purple-50 px-1.5 py-0.5 text-xs text-purple-700"
              :data-testid="`template-lineage-chip-${t.id}`"
              :title="`来源模板 #${t.sourceTemplateId}${
                t.sourceVersion !== null ? ` v${t.sourceVersion}` : ''
              }`"
            >
              血缘·#{{ t.sourceTemplateId }}
            </span>
            <span v-else class="text-xs text-gray-400">原始</span>
          </td>
          <td class="border px-2 py-1 align-top text-xs text-gray-600">
            {{ formatTime(t.updatedAt) }}
          </td>
          <td class="border px-2 py-1 align-top">
            <div class="flex flex-wrap gap-1">
              <button
                type="button"
                class="rounded border border-gray-300 px-2 py-0.5 text-xs text-gray-700 hover:bg-gray-50"
                :data-testid="`template-design-${t.id}`"
                @click="openDesigner(t)"
              >
                设计
              </button>
              <button
                type="button"
                class="rounded border border-gray-300 px-2 py-0.5 text-xs text-gray-700 hover:bg-gray-50"
                :data-testid="`template-versions-${t.id}`"
                @click="openVersions(t)"
              >
                版本
              </button>
              <button
                type="button"
                class="rounded border border-gray-300 px-2 py-0.5 text-xs text-gray-700 hover:bg-gray-50"
                :data-testid="`template-lineage-${t.id}`"
                @click="openLineage(t)"
              >
                血缘
              </button>
              <button
                type="button"
                class="rounded border border-gray-300 px-2 py-0.5 text-xs text-gray-700 hover:bg-gray-50"
                :data-testid="`template-rename-${t.id}`"
                @click="startRename(t)"
              >
                重命名
              </button>
              <!-- 另存为：按模板 API 契约 的插槽用法挂 SaveAsDialog 占位组件 -->
              <SaveAsDialog
                :template="t"
                :data-testid="`save-as-slot-${t.id}`"
                @done="onDuplicated"
              />
              <button
                type="button"
                class="rounded border px-2 py-0.5 text-xs"
                :class="
                  confirmingDeleteId === t.id
                    ? 'border-red-500 bg-red-500 text-white'
                    : 'border-red-200 text-red-500 hover:bg-red-50'
                "
                :data-testid="`template-delete-${t.id}`"
                @click="startDelete(t)"
              >
                {{ confirmingDeleteId === t.id ? '确认删除？' : '删除' }}
              </button>
              <template v-if="renamingId === t.id">
                <button
                  type="button"
                  class="rounded bg-blue-600 px-2 py-0.5 text-xs text-white"
                  :data-testid="`rename-confirm-${t.id}`"
                  @click="confirmRename(t)"
                >
                  保存
                </button>
                <button
                  type="button"
                  class="rounded border border-gray-300 px-2 py-0.5 text-xs text-gray-600"
                  :data-testid="`rename-cancel-${t.id}`"
                  @click="cancelRename"
                >
                  取消
                </button>
              </template>
              <template v-if="confirmingDeleteId === t.id">
                <button
                  type="button"
                  class="rounded bg-red-600 px-2 py-0.5 text-xs text-white"
                  :data-testid="`delete-confirm-${t.id}`"
                  @click="confirmDelete(t)"
                >
                  确认
                </button>
                <button
                  type="button"
                  class="rounded border border-gray-300 px-2 py-0.5 text-xs text-gray-600"
                  :data-testid="`delete-cancel-${t.id}`"
                  @click="cancelDelete"
                >
                  取消
                </button>
              </template>
            </div>
          </td>
        </tr>
      </tbody>
    </table>

    <!-- 新建模板向导 -->
    <div
      v-if="createOpen"
      data-testid="create-template-modal"
      class="fixed inset-0 z-40 flex items-center justify-center bg-black/40"
    >
      <div class="w-96 rounded bg-white p-4 shadow-lg">
        <h3 class="mb-2 text-sm font-semibold text-gray-700">新建模板</h3>
        <label class="block text-xs text-gray-500">
          名称
          <input
            v-model="createName"
            type="text"
            data-testid="create-name-input"
            class="mt-1 w-full rounded border border-gray-300 px-2 py-1"
            @keydown.enter="confirmCreate"
          />
        </label>
        <label class="mt-2 block text-xs text-gray-500">
          设备类
          <select
            v-model="createDevice"
            data-testid="create-device-select"
            class="mt-1 w-full rounded border border-gray-300 px-2 py-1"
          >
            <option value="receipt">小票（receipt）</option>
            <option value="label">标签（label）</option>
            <option value="doc">文档（doc）</option>
          </select>
        </label>
        <p class="mt-2 text-[10px] text-gray-400">
          新模板将生成对应设备类的最小空骨架（含 schemaVersion=2.0），进入设计器后可编辑。
        </p>
        <div class="mt-3 flex justify-end gap-2">
          <button
            type="button"
            data-testid="create-cancel"
            class="rounded border border-gray-300 px-2 py-0.5 text-xs text-gray-600 hover:bg-gray-50"
            @click="createOpen = false"
          >
            取消
          </button>
          <button
            type="button"
            data-testid="create-confirm"
            class="rounded bg-blue-600 px-2 py-0.5 text-xs text-white hover:bg-blue-700"
            @click="confirmCreate"
          >
            创建并进入设计器
          </button>
        </div>
      </div>
    </div>
  </section>
</template>
