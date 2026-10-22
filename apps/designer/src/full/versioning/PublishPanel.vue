<script setup lang="ts">
// 版本发布面板：changeNote 必填 + 草稿与 currentVersion
// 快照 hash 相同时禁用（幂等防护；Repository.publish 亦抛 TemplateNoChangesError 双保险）。
// 只消费 TemplateRepository.publish，成功 emit 'published' 由页面刷新时间线。
import { computed, ref } from 'vue';
import { getSharedRepository, TemplateNoChangesError } from '../../template-domain';

const props = defineProps<{
  /** 目标模板 id */
  templateId: number;
  /** 是否有未发布改动（草稿 hash ≠ currentVersion 快照 hash；无已发布版本恒 true） */
  hasChanges: boolean;
}>();

const emit = defineEmits<{ published: [] }>();

const changeNote = ref('');
const busy = ref(false);
const error = ref<string | null>(null);

const canPublish = computed(
  () => props.hasChanges && changeNote.value.trim() !== '' && !busy.value,
);

async function onPublish(): Promise<void> {
  if (!canPublish.value) return;
  busy.value = true;
  error.value = null;
  try {
    await getSharedRepository().publish(props.templateId, changeNote.value.trim());
    changeNote.value = '';
    emit('published');
  } catch (e) {
    if (e instanceof TemplateNoChangesError) {
      error.value = '草稿与已发布版本内容相同，无变更可发布';
    } else {
      error.value = `发布失败：${(e as Error).message}`;
    }
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="rounded border border-gray-200 bg-white p-4" data-testid="publish-panel">
    <h2 class="text-sm font-semibold text-gray-700">发布新版本</h2>
    <p v-if="!hasChanges" class="mt-1 text-xs text-gray-500" data-testid="publish-no-changes-hint">
      草稿与当前已发布版本内容相同（dslHash 相等），无变更可发布。
    </p>
    <div class="mt-2 flex items-start gap-2">
      <input
        v-model="changeNote"
        type="text"
        data-testid="publish-note-input"
        placeholder="变更备注（必填）"
        class="flex-1 rounded border border-gray-300 px-2 py-1 text-sm"
        :disabled="busy || !hasChanges"
        @keydown.enter.prevent="onPublish"
      />
      <button
        type="button"
        data-testid="publish-button"
        class="rounded bg-blue-600 px-3 py-1 text-sm text-white disabled:cursor-not-allowed disabled:bg-gray-300"
        :disabled="!canPublish"
        @click="onPublish"
      >
        {{ busy ? '发布中…' : '发布' }}
      </button>
    </div>
    <p v-if="error" class="mt-1 text-xs text-red-600" data-testid="publish-error">
      {{ error }}
    </p>
  </div>
</template>
