<script setup lang="ts">
// 另存为对话框（血缘标记：副本继承源模板 sourceTemplateId）。
//
// 稳定契约：列表页插槽用法 `<SaveAsDialog :template="row" @done="onDuplicated" />`，
// props/template 与事件名 done/cancel 不得改动。
//
// 实现：来源说明区（当前草稿/源版本号 sourceVersion）+ 名称校验 +
// 加载态 + 错误态（三段式文案，不泄漏异常堆栈）+ cancel 事件触发 + 焦点管理。
// 血缘字段（sourceTemplateId/sourceVersion）由 Repository 保证，对话框只做交互。
import { computed, nextTick, ref } from 'vue';
import { getSharedRepository, type TemplateMeta, type TemplateRecord } from '@/template-domain';

const props = defineProps<{
  /** 源模板（列表行 meta） */
  template: TemplateMeta;
}>();

const emit = defineEmits<{
  /** 复制成功：返回新模板完整记录，列表页跳转或刷新 */
  (e: 'done', record: TemplateRecord): void;
  /** 取消（用户主动取消或关闭对话框） */
  (e: 'cancel'): void;
}>();

const open = ref(false);
const newName = ref('');
const submitting = ref(false);
const errorMsg = ref<string | null>(null);
const nameInputRef = ref<HTMLInputElement | null>(null);

/** 名称校验：非空 + 长度限制 25 字符（对齐后端 ss_sys_print_template.name VARCHAR(25)） */
const NAME_MAX = 25;
const trimmedName = computed(() => newName.value.trim());
const nameError = computed<string | null>(() => {
  if (trimmedName.value.length === 0) return '请输入新模板名称';
  if (trimmedName.value.length > NAME_MAX) return `名称不能超过 ${NAME_MAX} 个字符`;
  return null;
});
const canSubmit = computed(() => !submitting.value && nameError.value === null);

/** 来源说明：源模板的版本状态决定显示口径 */
const sourceVersionLabel = computed(() => {
  if (props.template.currentVersion === null) {
    return '当前草稿（源模板尚未发布）';
  }
  return `源版本 v${props.template.currentVersion}（已发布快照）`;
});

/** 来源说明：另存为血缘语义提示 */
const lineageNote = computed(
  () =>
    `血缘副本：复制为独立模板（sourceTemplateId=${props.template.id}），` +
    '副本独立演化，基线变更不传播（非门店覆盖链）。',
);

function show(): void {
  newName.value = `${props.template.name}-副本`;
  errorMsg.value = null;
  submitting.value = false;
  open.value = true;
  // 焦点管理：打开后自动聚焦输入框（UI-SPEC 即时反馈）
  void nextTick(() => nameInputRef.value?.focus());
}

function close(): void {
  if (submitting.value) return; // 提交期间禁止关闭
  open.value = false;
  errorMsg.value = null;
}

function cancel(): void {
  close();
  emit('cancel');
}

async function confirm(): Promise<void> {
  if (!canSubmit.value) return;
  submitting.value = true;
  errorMsg.value = null;
  try {
    const repo = getSharedRepository();
    const record = await repo.duplicate(props.template.id, {
      name: trimmedName.value,
    });
    open.value = false;
    submitting.value = false;
    emit('done', record);
  } catch (e) {
    // 三段式文案（UI-SPEC ）：现象 + 原因 + 下一步；不泄漏异常类型名/堆栈
    submitting.value = false;
    errorMsg.value =
      e instanceof Error && e.message.length > 0
        ? `复制失败：${e.message}。请稍后重试或检查源模板状态。`
        : '复制失败：未知错误。请稍后重试。';
  }
}

defineExpose({ show });
</script>

<template>
  <div data-testid="save-as-dialog" class="inline-block">
    <button
      type="button"
      class="rounded border border-gray-300 px-2 py-0.5 text-xs text-gray-700 hover:bg-gray-50 disabled:opacity-50"
      :data-testid="`save-as-trigger-${template.id}`"
      title="复制为新模板（血缘副本）"
      @click="show"
    >
      另存为
    </button>
    <div
      v-if="open"
      data-testid="save-as-modal"
      class="fixed inset-0 z-40 flex items-center justify-center bg-black/40"
      @click.self="cancel"
    >
      <div class="w-96 rounded bg-white p-5 shadow-lg">
        <h3 class="mb-3 text-base font-semibold text-gray-800">
          复制「{{ template.name }}」为新模板
        </h3>

        <!-- 来源说明区（-->
        <div
          data-testid="save-as-source-info"
          class="mb-3 rounded border border-blue-200 bg-blue-50 p-2 text-xs text-blue-700"
        >
          <div data-testid="save-as-source-version">{{ sourceVersionLabel }}</div>
          <div class="mt-1 text-[10px] text-blue-600">{{ lineageNote }}</div>
        </div>

        <!-- 名称输入 -->
        <label class="block text-xs font-medium text-gray-600">
          新模板名称
          <input
            ref="nameInputRef"
            v-model="newName"
            type="text"
            :maxlength="NAME_MAX"
            data-testid="save-as-name-input"
            class="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            :class="{ 'border-red-400': nameError }"
            @keydown.enter="confirm"
          />
        </label>
        <p v-if="nameError" data-testid="save-as-name-error" class="mt-1 text-[10px] text-red-600">
          {{ nameError }}
        </p>

        <!-- 错误态 -->
        <p
          v-if="errorMsg"
          data-testid="save-as-error"
          class="mt-2 rounded bg-red-50 px-2 py-1 text-[11px] text-red-700"
        >
          {{ errorMsg }}
        </p>

        <!-- 操作按钮 -->
        <div class="mt-4 flex justify-end gap-2">
          <button
            type="button"
            data-testid="save-as-cancel"
            class="rounded border border-gray-300 px-3 py-1 text-xs text-gray-600 hover:bg-gray-50 disabled:opacity-50"
            :disabled="submitting"
            @click="cancel"
          >
            取消
          </button>
          <button
            type="button"
            data-testid="save-as-confirm"
            class="rounded bg-blue-600 px-3 py-1 text-xs text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
            :disabled="!canSubmit"
            @click="confirm"
          >
            <span v-if="submitting" data-testid="save-as-submitting">复制中…</span>
            <span v-else>确认复制</span>
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
