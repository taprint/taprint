<script setup lang="ts">
// 页面属性分区（doc page 级；未选中元素时渲染）：水印（type/text/src 互斥、
// opacity/angle/tile、移除）+ nup（cols/rows 1-4、gap、移除），写回 updatePage；
// page 相关校验错误就近展示（专项步骤 4 块 D）。
import { computed } from 'vue';
import { useDesignerStore } from '../../store';
import type { NupV2, WatermarkV2 } from '../../types';

const store = useDesignerStore();

const page = computed(() => (store.activePresentation?.page ?? {}) as Record<string, unknown>);
const watermark = computed(() => page.value.watermark as WatermarkV2 | undefined);
const nup = computed(() => page.value.nup as NupV2 | undefined);

// schema 错误 path 为 ajv instancePath（/presentations/doc/page/watermark/...）
const pageErrors = computed(() =>
  store.validationErrors.filter(
    (e) => e.path.includes('watermark') || e.path.includes('nup') || e.path.includes('/page'),
  ),
);

function patchWatermark(patch: Partial<WatermarkV2>): void {
  const next = { ...(watermark.value ?? { type: 'text' as const }), ...patch };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete next[k as keyof WatermarkV2];
  }
  store.updatePage({ watermark: next });
}

// type 切换互斥：text 型移除 src，image 型移除 text（镜像 schema oneOf 语义）
function setWatermarkType(type: 'text' | 'image'): void {
  const next: WatermarkV2 = { ...(watermark.value ?? { type: 'text' }), type };
  if (type === 'text') {
    delete next.src;
    if (next.text === undefined) next.text = '';
  } else {
    delete next.text;
    if (next.src === undefined) next.src = '';
  }
  store.updatePage({ watermark: next });
}

function toNumber(value: string, fallback: number): number {
  if (value.trim() === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clampOpacity(value: string): number {
  return Math.min(1, Math.max(0.01, toNumber(value, 0.15)));
}

function clampAngle(value: string): number {
  return Math.min(90, Math.max(-90, toNumber(value, -30)));
}

function clamp14(value: string): number {
  return Math.min(4, Math.max(1, Math.round(toNumber(value, 1))));
}

function patchNup(patch: Partial<NupV2>): void {
  const next = { ...(nup.value ?? { cols: 2, rows: 2 }), ...patch };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete next[k as keyof NupV2];
  }
  store.updatePage({ nup: next });
}
</script>

<template>
  <div class="space-y-3 text-xs" data-testid="page-props">
    <h3 class="text-xs font-semibold text-gray-500">页面属性（doc）</h3>

    <div
      v-for="e in pageErrors"
      :key="e.path + e.message"
      class="rounded bg-red-50 px-1.5 py-1 text-red-600"
      data-testid="page-error-item"
    >
      [{{ e.code }}] {{ e.path }}：{{ e.message }}
    </div>

    <!-- 水印 -->
    <section class="rounded border border-gray-200 p-1.5">
      <h4 class="mb-1 text-gray-500">水印</h4>
      <template v-if="watermark">
        <select
          :value="watermark.type"
          class="mb-1 w-full rounded border border-gray-200 px-1.5 py-1"
          data-testid="page-watermark-type"
          @change="setWatermarkType(($event.target as HTMLSelectElement).value as 'text' | 'image')"
        >
          <option value="text">文本水印</option>
          <option value="image">图片水印</option>
        </select>
        <input
          v-if="watermark.type === 'text'"
          :value="watermark.text ?? ''"
          type="text"
          placeholder="水印文字"
          class="mb-1 w-full rounded border border-gray-200 px-1.5 py-1"
          data-testid="page-watermark-text"
          @change="patchWatermark({ text: ($event.target as HTMLInputElement).value })"
        />
        <input
          v-else
          :value="watermark.src ?? ''"
          type="text"
          placeholder="图片地址（支持表达式）"
          class="mb-1 w-full rounded border border-gray-200 px-1.5 py-1"
          data-testid="page-watermark-src"
          @change="patchWatermark({ src: ($event.target as HTMLInputElement).value })"
        />
        <div class="mb-1 flex items-center gap-1">
          <span class="w-12 text-gray-500">透明度</span>
          <input
            :value="watermark.opacity ?? 0.15"
            type="number"
            min="0"
            max="1"
            step="0.01"
            class="w-full rounded border border-gray-200 px-1.5 py-1"
            data-testid="page-watermark-opacity"
            @change="
              patchWatermark({ opacity: clampOpacity(($event.target as HTMLInputElement).value) })
            "
          />
        </div>
        <div class="mb-1 flex items-center gap-1">
          <span class="w-12 text-gray-500">角度</span>
          <input
            :value="watermark.angle ?? -30"
            type="number"
            class="w-full rounded border border-gray-200 px-1.5 py-1"
            data-testid="page-watermark-angle"
            @change="
              patchWatermark({ angle: clampAngle(($event.target as HTMLInputElement).value) })
            "
          />
        </div>
        <label class="mb-1 flex items-center gap-2">
          <input
            type="checkbox"
            :checked="!!watermark.tile"
            data-testid="page-watermark-tile"
            @change="
              patchWatermark({ tile: ($event.target as HTMLInputElement).checked || undefined })
            "
          />
          平铺（tile）
        </label>
        <button
          type="button"
          class="w-full rounded border border-red-200 px-1.5 py-0.5 text-red-500 hover:bg-red-50"
          data-testid="page-watermark-remove"
          @click="store.updatePage({ watermark: undefined })"
        >
          移除水印
        </button>
      </template>
      <button
        v-else
        type="button"
        class="w-full rounded border border-dashed border-gray-300 px-1.5 py-1 text-gray-500 hover:border-blue-300 hover:text-blue-600"
        data-testid="page-watermark-add"
        @click="store.updatePage({ watermark: { type: 'text', text: '' } })"
      >
        + 添加水印
      </button>
    </section>

    <!-- 一页多单（nup） -->
    <section class="rounded border border-gray-200 p-1.5">
      <h4 class="mb-1 text-gray-500">一页多单（nup）</h4>
      <template v-if="nup">
        <div class="mb-1 flex items-center gap-1">
          <span class="w-8 text-gray-500">列</span>
          <input
            :value="nup.cols"
            type="number"
            min="1"
            max="4"
            class="w-full rounded border border-gray-200 px-1.5 py-1"
            data-testid="page-nup-cols"
            @change="patchNup({ cols: clamp14(($event.target as HTMLInputElement).value) })"
          />
          <span class="w-8 text-gray-500">行</span>
          <input
            :value="nup.rows"
            type="number"
            min="1"
            max="4"
            class="w-full rounded border border-gray-200 px-1.5 py-1"
            data-testid="page-nup-rows"
            @change="patchNup({ rows: clamp14(($event.target as HTMLInputElement).value) })"
          />
        </div>
        <div class="mb-1 flex items-center gap-1">
          <span class="w-8 text-gray-500">间距</span>
          <input
            :value="nup.gap ?? ''"
            type="text"
            placeholder="如 5mm"
            class="w-full rounded border border-gray-200 px-1.5 py-1"
            data-testid="page-nup-gap"
            @change="patchNup({ gap: ($event.target as HTMLInputElement).value || undefined })"
          />
        </div>
        <button
          type="button"
          class="w-full rounded border border-red-200 px-1.5 py-0.5 text-red-500 hover:bg-red-50"
          data-testid="page-nup-remove"
          @click="store.updatePage({ nup: undefined })"
        >
          移除 nup
        </button>
      </template>
      <button
        v-else
        type="button"
        class="w-full rounded border border-dashed border-gray-300 px-1.5 py-1 text-gray-500 hover:border-blue-300 hover:text-blue-600"
        data-testid="page-nup-add"
        @click="store.updatePage({ nup: { cols: 2, rows: 2 } })"
      >
        + 启用一页多单
      </button>
    </section>
  </div>
</template>
