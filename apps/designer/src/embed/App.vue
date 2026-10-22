<script setup lang="ts">
import { computed, onMounted } from 'vue';
import DesignerWorkbench from '@/canvas/DesignerWorkbench.vue';
import { useDesignerStore } from '@/canvas/store';
import { postMessageToHost } from './host-bridge';
import { beginSavePending, embedState, requestPreview, requestTestPrint } from './sdk-core';
import type { TemplateLike } from '@/canvas/store';
// embed 模式壳（：正式模板经宿主 loadTemplate 载入，SDK init 序列见 sdk-core；/）。
// 宿主：顶栏增预览/测试打印按钮，对应 preview/previewResult +
// testPrint/printResult 通道；readOnly 完整编辑锁仅关闭保存与编辑入口，
// 预览/测试打印作为只读语义的能力保持可用（与宿主契约的 preview()/testPrint() 对齐）。
// ：embed 是「完整 Web 设计器嵌入」，三栏工作台与 full 一致。
// ?fallbackSample=1：dev 调试样例兜底（无宿主场景），e2e 走真实宿主消息链路。

const store = useDesignerStore();
const fallbackSample = new URLSearchParams(window.location.search).get('fallbackSample') === '1';
const awaitHost = !fallbackSample;

const statusChip = computed(() => {
  switch (embedState.status) {
    case 'booting':
      return { text: '启动中', cls: 'bg-gray-100 text-gray-600' };
    case 'waiting-host':
      return { text: '等待宿主下发模板', cls: 'bg-amber-50 text-amber-700' };
    case 'connected':
      return { text: '已连接宿主', cls: 'bg-green-50 text-green-700' };
    case 'fatal':
      return { text: '启动失败', cls: 'bg-red-50 text-red-700' };
    default:
      return { text: '未知状态', cls: 'bg-gray-100 text-gray-600' };
  }
});

function onSaveChannel(dsl: TemplateLike): void {
  if (embedState.saving) return; // 防重入纵深
  embedState.saveResult = null;
  beginSavePending();
  postMessageToHost({
    type: 'save',
    dsl: dsl as unknown as Record<string, unknown>,
    deviceClass: store.device ?? undefined,
  });
}

// preview/testPrint 上行（带 dsl + deviceClass），
// previewResult/printResult 经 sdk-core handleHostMessage 写入 embedState 回执。
// 按钮 disabled：未挂载模板 / 无 device / 等待回执中；readOnly 下仍可用（只读语义）。
const previewDisabled = computed(() => !store.dsl || !store.device || embedState.previewing);
const testPrintDisabled = computed(() => !store.dsl || !store.device || embedState.testingPrint);

function onPreview(): void {
  if (!store.dsl || !store.device || embedState.previewing) return;
  requestPreview(store.dsl as unknown as Record<string, unknown>, store.device);
}

function onTestPrint(): void {
  if (!store.dsl || !store.device || embedState.testingPrint) return;
  requestTestPrint(store.dsl as unknown as Record<string, unknown>, store.device);
}

onMounted(() => {
  if (fallbackSample && !store.dsl) {
    import('@/canvas/samples').then(({ sampleRegistry }) => {
      store.loadTemplate(sampleRegistry[0].template);
    });
  }
});
</script>

<template>
  <div class="flex h-screen w-screen flex-col">
    <div
      class="flex items-center gap-2 border-b border-gray-200 px-3 py-1 text-xs"
      data-testid="embed-statusbar"
    >
      <span :class="['rounded px-2 py-0.5', statusChip.cls]" data-testid="embed-status-chip">
        {{ statusChip.text }}
      </span>
      <span
        v-if="store.readOnly"
        class="rounded bg-gray-100 px-2 py-0.5 text-gray-600"
        data-testid="readonly-chip"
      >
        只读模式
      </span>
      <div class="flex-1" />
      <button
        type="button"
        data-testid="embed-preview-button"
        class="rounded border border-gray-300 px-2 py-0.5 text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
        :disabled="previewDisabled"
        :title="
          !store.dsl
            ? '先加载模板'
            : !store.device
              ? '未选择设备'
              : embedState.previewing
                ? '等待宿主预览回执…'
                : '请求宿主预览（preview 通道）'
        "
        @click="onPreview"
      >
        {{ embedState.previewing ? '预览中…' : '预览（宿主）' }}
      </button>
      <button
        type="button"
        data-testid="embed-testprint-button"
        class="rounded border border-gray-300 px-2 py-0.5 text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
        :disabled="testPrintDisabled"
        :title="
          !store.dsl
            ? '先加载模板'
            : !store.device
              ? '未选择设备'
              : embedState.testingPrint
                ? '等待宿主测试打印回执…'
                : '请求宿主测试打印（testPrint 通道）'
        "
        @click="onTestPrint"
      >
        {{ embedState.testingPrint ? '测试打印中…' : '测试打印' }}
      </button>
      <span
        v-if="embedState.saving"
        class="rounded bg-amber-50 px-2 py-0.5 text-amber-700"
        data-testid="save-pending"
      >
        保存中，等待宿主回执…
      </span>
      <span
        v-if="embedState.saveResult"
        :class="[
          'rounded px-2 py-0.5',
          embedState.saveResult.success ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700',
        ]"
        data-testid="save-receipt"
      >
        {{
          embedState.saveResult.success
            ? '保存成功'
            : `保存失败：${embedState.saveResult.errorMessage ?? '宿主未返回原因'}`
        }}
      </span>
      <span
        v-if="embedState.previewResult"
        :class="[
          'rounded px-2 py-0.5',
          embedState.previewResult.errorMessage
            ? 'bg-red-50 text-red-700'
            : 'bg-green-50 text-green-700',
        ]"
        data-testid="preview-receipt"
      >
        {{
          embedState.previewResult.errorMessage
            ? `预览失败：${embedState.previewResult.errorMessage}`
            : '预览已返回'
        }}
      </span>
      <span
        v-if="embedState.printResult"
        :class="[
          'rounded px-2 py-0.5',
          embedState.printResult.success === false
            ? 'bg-red-50 text-red-700'
            : 'bg-green-50 text-green-700',
        ]"
        data-testid="print-receipt"
      >
        {{
          embedState.printResult.success === false
            ? `测试打印失败：${embedState.printResult.errorMessage ?? '宿主未返回原因'}`
            : '测试打印成功'
        }}
      </span>
    </div>
    <DesignerWorkbench
      class="min-h-0 flex-1"
      :await-host="awaitHost"
      :save-channel="awaitHost ? onSaveChannel : undefined"
      :save-busy="embedState.saving"
    />
    <!-- 宿主预览图渲染面板（previewResult.previewUrl）：宿主返回 PNG/PDF URL 时直接展示；
         errorMessage 走顶栏回执，此处不重复展示 -->
    <div
      v-if="embedState.previewResult?.previewUrl"
      data-testid="preview-host-image-wrap"
      class="border-t border-gray-200 bg-gray-50 p-2"
    >
      <div class="mb-1 text-[10px] text-gray-500">宿主预览（previewResult.previewUrl）：</div>
      <img
        :src="embedState.previewResult.previewUrl"
        data-testid="preview-host-image"
        alt="宿主预览"
        class="max-h-32 max-w-full border border-gray-200 bg-white shadow-sm"
      />
    </div>
  </div>
</template>
