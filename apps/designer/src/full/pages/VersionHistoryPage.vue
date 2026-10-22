<script setup lang="ts">
// 版本历史页：
// 时间线 + 发布 + 指针式回滚 + 版本 diff。
// 数据源 = TemplateRepository 单例；回滚指针式（对齐后端 rollback）——
// 仅 published 版本可回滚，currentVersion 指针移动、不产生新版本行、版本条目数不变。
import { computed, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { DslParser } from 'taprint';
import {
  getSharedRepository,
  RollbackTargetInvalidError,
  type TemplateRecord,
  type TemplateVersion,
} from '../../template-domain';
import PublishPanel from '../versioning/PublishPanel.vue';
import VersionDiffPanel from '../versioning/VersionDiffPanel.vue';

const route = useRoute();
const repo = getSharedRepository();

const templateId = computed(() => Number(route.params.id));
const record = ref<TemplateRecord | null>(null);
const versions = ref<TemplateVersion[]>([]);
const loading = ref(true);
const notFound = ref(false);
const loadError = ref<string | null>(null);

// 回滚确认态（预览该版本 DSL 摘要 → 确认）
const rollbackTarget = ref<TemplateVersion | null>(null);
const rollbackBusy = ref(false);
const rollbackError = ref<string | null>(null);

const draftHash = computed(() => (record.value ? DslParser.hash(record.value.dsl as never) : null));
const currentSnapshot = computed(
  () => versions.value.find((v) => v.version === record.value?.currentVersion) ?? null,
);
/** 草稿 hash ≠ currentVersion 快照 hash 即「有未发布改动」（无已发布版本时整个草稿视为未发布） */
const hasUnpublished = computed(
  () =>
    record.value !== null &&
    (currentSnapshot.value ? draftHash.value !== currentSnapshot.value.dslHash : true),
);
/** 时间线按版本号倒序（最新在上） */
const timeline = computed(() => [...versions.value].sort((a, b) => b.version - a.version));

async function load(): Promise<void> {
  loading.value = true;
  loadError.value = null;
  try {
    const found = await repo.get(templateId.value);
    if (!found) {
      notFound.value = true;
      record.value = null;
      versions.value = [];
      return;
    }
    notFound.value = false;
    record.value = found;
    versions.value = await repo.getVersions(templateId.value);
  } catch (e) {
    loadError.value = (e as Error).message;
  } finally {
    loading.value = false;
  }
}

function onPublished(): void {
  void load();
}

function requestRollback(version: TemplateVersion): void {
  rollbackError.value = null;
  rollbackTarget.value = version;
}

async function confirmRollback(): Promise<void> {
  const target = rollbackTarget.value;
  if (!target) return;
  rollbackBusy.value = true;
  rollbackError.value = null;
  try {
    await repo.rollback(templateId.value, target.version);
    rollbackTarget.value = null;
    await load();
  } catch (e) {
    rollbackError.value =
      e instanceof RollbackTargetInvalidError ? e.message : `回滚失败：${(e as Error).message}`;
  } finally {
    rollbackBusy.value = false;
  }
}

function cancelRollback(): void {
  rollbackTarget.value = null;
  rollbackError.value = null;
}

/** 版本可回滚条件：status=published 且非当前指向版本（后端口径） */
function canRollback(v: TemplateVersion): boolean {
  return v.status === 'published' && v.version !== record.value?.currentVersion;
}

/** UTC 展示（测试机 TZ=UTC；整数毫秒 → ISO 截断到秒） */
function fmtTime(ms: number | null): string {
  if (ms === null) return '—';
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
}

function shortHash(hash: string): string {
  return hash.length > 14 ? `${hash.slice(0, 14)}…` : hash;
}

onMounted(load);
</script>

<template>
  <section class="p-6" data-testid="version-history-page">
    <h1 class="text-lg font-semibold">版本历史</h1>

    <p v-if="loading" class="mt-2 text-sm text-gray-500" data-testid="version-loading">加载中…</p>

    <div v-else-if="notFound" data-testid="version-not-found">
      <p class="mt-2 text-sm text-red-600">模板 {{ templateId }} 不存在。</p>
      <RouterLink to="/" class="mt-2 inline-block text-sm text-blue-600">返回模板列表</RouterLink>
    </div>

    <div v-else-if="record" class="mt-3 space-y-4">
      <div class="flex items-center gap-3 text-sm">
        <span class="font-medium text-gray-800" data-testid="template-name">{{ record.name }}</span>
        <span
          class="rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-600"
          data-testid="current-version-badge"
        >
          当前版本：{{ record.currentVersion ?? '未发布' }}
        </span>
        <span
          v-if="hasUnpublished"
          class="rounded bg-amber-50 px-2 py-0.5 text-xs text-amber-700"
          data-testid="has-unpublished-chip"
        >
          有未发布改动
        </span>
      </div>

      <PublishPanel
        :template-id="record.id"
        :has-changes="hasUnpublished"
        @published="onPublished"
      />

      <div class="rounded border border-gray-200 bg-white p-4" data-testid="timeline">
        <h2 class="text-sm font-semibold text-gray-700">版本时间线（只增不删不改）</h2>
        <ul v-if="timeline.length > 0" class="mt-2 divide-y divide-gray-100">
          <li
            v-for="v in timeline"
            :key="v.version"
            class="flex flex-wrap items-center gap-2 py-2 text-sm"
            data-testid="timeline-row"
          >
            <span class="font-semibold text-gray-800" data-testid="timeline-version"
              >v{{ v.version }}</span
            >
            <span
              class="rounded px-1.5 py-0.5 text-[10px]"
              :class="
                v.status === 'published'
                  ? 'bg-green-50 text-green-700'
                  : v.status === 'grayscale'
                    ? 'bg-purple-50 text-purple-700'
                    : 'bg-gray-100 text-gray-600'
              "
              data-testid="timeline-status"
            >
              {{ v.status }}
            </span>
            <span class="text-xs text-gray-500" data-testid="timeline-hash" :title="v.dslHash">
              hash {{ shortHash(v.dslHash) }}
            </span>
            <span class="text-xs text-gray-500" data-testid="timeline-time">{{
              fmtTime(v.publishedAt)
            }}</span>
            <span class="flex-1 truncate text-xs text-gray-600" data-testid="timeline-note">
              {{ v.changeNote }}
            </span>
            <span
              v-if="v.version === record.currentVersion"
              class="rounded bg-blue-50 px-1.5 py-0.5 text-[10px] text-blue-700"
              data-testid="timeline-current-marker"
            >
              当前
            </span>
            <button
              type="button"
              data-testid="rollback-button"
              class="rounded border border-amber-300 px-2 py-0.5 text-xs text-amber-700 disabled:cursor-not-allowed disabled:border-gray-200 disabled:text-gray-300"
              :disabled="!canRollback(v)"
              :title="
                v.status !== 'published'
                  ? '只能回滚到已发布版本（后端口径）'
                  : v.version === record.currentVersion
                    ? '已是当前版本'
                    : '指针式回滚：currentVersion 指向该版本，不产生新版本行'
              "
              @click="requestRollback(v)"
            >
              回滚到此
            </button>
          </li>
        </ul>
        <p v-else class="mt-2 text-xs text-gray-500" data-testid="timeline-empty">
          尚无版本记录，先发布首个版本。
        </p>
      </div>

      <!-- 回滚确认（预览目标版本 DSL 摘要 → 确认；指针式不新增版本行） -->
      <div
        v-if="rollbackTarget"
        class="rounded border border-amber-300 bg-amber-50 p-4"
        data-testid="rollback-confirm-section"
      >
        <h3 class="text-sm font-semibold text-amber-800">
          确认指针式回滚到 v{{ rollbackTarget.version }}
        </h3>
        <p class="mt-1 text-xs text-amber-700">
          变更备注：{{ rollbackTarget.changeNote }} | 发布：{{
            fmtTime(rollbackTarget.publishedAt)
          }}
          <span class="ml-1 break-all" :title="rollbackTarget.dslHash">
            hash {{ shortHash(rollbackTarget.dslHash) }}
          </span>
        </p>
        <p class="mt-1 text-[10px] text-amber-600">
          指针式语义：currentVersion 指向 v{{ rollbackTarget.version }}，草稿同步回滚为该版本快照；
          不产生新版本行，时间线条目数不变（对齐后端 rollback）。
        </p>
        <p v-if="rollbackError" class="mt-1 text-xs text-red-700" data-testid="rollback-error">
          {{ rollbackError }}
        </p>
        <div class="mt-2 flex gap-2">
          <button
            type="button"
            data-testid="rollback-confirm-button"
            class="rounded bg-amber-600 px-3 py-1 text-xs text-white disabled:cursor-not-allowed disabled:bg-gray-300"
            :disabled="rollbackBusy"
            @click="confirmRollback"
          >
            {{ rollbackBusy ? '回滚中…' : '确认回滚' }}
          </button>
          <button
            type="button"
            data-testid="rollback-cancel-button"
            class="rounded border border-gray-300 px-3 py-1 text-xs text-gray-600"
            @click="cancelRollback"
          >
            取消
          </button>
        </div>
      </div>

      <VersionDiffPanel
        :draft="record.dsl"
        :versions="versions"
        :current-version="record.currentVersion"
      />
    </div>

    <p v-else-if="loadError" class="mt-2 text-sm text-red-600" data-testid="version-load-error">
      {{ loadError }}
    </p>
  </section>
</template>
