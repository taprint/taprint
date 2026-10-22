<script setup lang="ts">
// 共享画布：doc/receipt 流式布局、label 绝对坐标布局（设计契约）
// 专项步骤 4（块 D）：doc 页级能力——水印覆盖层（text/image、tile 平铺）与
// nup 一页多单（grid 只读副本；数据求值/分页属渲染器职责，设计态仅结构示意）。
import { computed } from 'vue';
import CanvasElementHost from './CanvasElementHost.vue';
import { elementRegistry } from './elements/registry';
import DeviceSwitcher from './panels/DeviceSwitcher.vue';
import { useDesignerStore } from './store';
import {
  DEFAULT_PAGE_MARGIN_MM,
  PX_PER_MM,
  parseLengthMm,
  type CanvasElement,
  type NupV2,
  type WatermarkV2,
} from './types';

const store = useDesignerStore();

// 稳定 key：元素对象 → 单调递增 uid（WeakMap，元素移除后自动回收）。
// index 作 key 会在删除后把旧组件实例复用给不同 model
const uidMap = new WeakMap<object, number>();
let uidSeq = 0;
function uidOf(el: CanvasElement): number {
  let uid = uidMap.get(el);
  if (uid === undefined) {
    uidSeq += 1;
    uid = uidSeq;
    uidMap.set(el, uid);
  }
  return uid;
}

const PAGE_SIZES_MM: Record<string, [number, number]> = {
  A4: [210, 297],
  A5: [148, 210],
  LETTER: [215.9, 279.4],
};

const presentation = computed(() => store.activePresentation);
const body = computed(() => store.activeBody);
const header = computed<CanvasElement[]>(
  () => (presentation.value?.header as CanvasElement[] | undefined) ?? [],
);
const footer = computed<CanvasElement[]>(
  () => (presentation.value?.footer as CanvasElement[] | undefined) ?? [],
);

// ---------- doc 页级能力（块 D）：水印 + nup ----------

const pageDef = computed(() => (presentation.value?.page ?? {}) as Record<string, unknown>);
const watermark = computed(() => pageDef.value.watermark as WatermarkV2 | undefined);
const nup = computed(() => pageDef.value.nup as NupV2 | undefined);

// tile 平铺 3×4 = 12 枚（设计态近似；精确排布属渲染器职责）
const watermarkCopies = computed(() =>
  Array.from({ length: watermark.value?.tile ? 12 : 1 }, (_, i) => i),
);
const watermarkTextStyle = computed(() => ({
  opacity: watermark.value?.opacity ?? 0.15,
  transform: `rotate(${watermark.value?.angle ?? -30}deg)`,
}));
// 含表达式的图源不求值（渲染器职责），占位显示
const watermarkSrcIsExpr = computed(
  () => watermark.value?.type === 'image' && String(watermark.value.src ?? '').includes('{{'),
);

const nupGapPx = computed(() => parseLengthMm(nup.value?.gap) || 5 * PX_PER_MM);
const nupGridStyle = computed(() =>
  nup.value
    ? {
        display: 'grid',
        gridTemplateColumns: `repeat(${nup.value.cols}, minmax(0, 1fr))`,
        gap: `${nupGapPx.value}px`,
      }
    : {},
);
// 除首个可编辑单元外的只读副本数
const nupCopies = computed(() =>
  nup.value ? Math.max(0, nup.value.cols * nup.value.rows - 1) : 0,
);
// nup 只读副本渲染 header+body+footer 全段（不进 uidMap/不可选）
const nupReadOnly = computed<CanvasElement[]>(() => [
  ...header.value,
  ...body.value,
  ...footer.value,
]);

const pageSizePx = computed<[number, number]>(() => {
  const page = (presentation.value?.page ?? {}) as Record<string, unknown>;
  let [w, h] = PAGE_SIZES_MM[(page.size as string) ?? 'A4'] ?? PAGE_SIZES_MM.A4;
  if (page.size === 'CUSTOM') {
    w = parseLengthMm(page.width as string | undefined) || w;
    h = parseLengthMm(page.height as string | undefined) || h;
  }
  if (page.orientation === 'landscape') [w, h] = [h, w];
  return [w * PX_PER_MM, h * PX_PER_MM];
});

const pagePaddingPx = computed(() => {
  const margin = (presentation.value?.page as Record<string, unknown> | undefined)?.margin as
    Record<string, string> | undefined;
  const mm = (side: string) => parseLengthMm(margin?.[side]) || DEFAULT_PAGE_MARGIN_MM;
  return {
    paddingTop: `${mm('top') * PX_PER_MM}px`,
    paddingRight: `${mm('right') * PX_PER_MM}px`,
    paddingBottom: `${mm('bottom') * PX_PER_MM}px`,
    paddingLeft: `${mm('left') * PX_PER_MM}px`,
  };
});

const receiptWidthPx = computed(() => {
  const w = parseLengthMm(presentation.value?.width as string | undefined) || 80;
  return w * PX_PER_MM;
});

const labelSizePx = computed<[number, number]>(() => {
  const size = (presentation.value?.size ?? {}) as Record<string, string>;
  return [
    (parseLengthMm(size.width) || 40) * PX_PER_MM,
    (parseLengthMm(size.height) || 30) * PX_PER_MM,
  ];
});

function labelStyle(index: number): Record<string, string> {
  const el = body.value[index];
  const style: Record<string, string> = {
    position: 'absolute',
    left: `${parseLengthMm(el?.x as string | undefined) * PX_PER_MM}px`,
    top: `${parseLengthMm(el?.y as string | undefined) * PX_PER_MM}px`,
  };
  if (el?.width) style.width = `${parseLengthMm(el.width as string | undefined) * PX_PER_MM}px`;
  if (el?.height) style.height = `${parseLengthMm(el.height as string | undefined) * PX_PER_MM}px`;
  return style;
}
</script>

<template>
  <div class="flex h-full min-h-0 flex-col" data-testid="designer-canvas">
    <div class="flex items-center justify-between border-b border-gray-200 bg-white px-3 py-1.5">
      <DeviceSwitcher />
      <span v-if="store.dsl" class="text-xs text-gray-400">
        {{ store.dsl.code }} · {{ store.device }}
      </span>
    </div>

    <div
      class="min-h-0 flex-1 overflow-auto bg-gray-100 p-6"
      data-testid="canvas-background"
      @click.self="store.clearSelection()"
    >
      <div v-if="!store.dsl" class="flex h-full items-center justify-center text-sm text-gray-400">
        未加载模板
      </div>

      <!-- doc：A4 页面流式布局；块 D：水印覆盖层 + nup 只读副本 -->
      <div
        v-else-if="store.device === 'doc'"
        class="relative mx-auto bg-white shadow"
        :style="{ width: `${pageSizePx[0]}px`, minHeight: `${pageSizePx[1]}px`, ...pagePaddingPx }"
        data-testid="canvas-doc-page"
        @click.self="store.clearSelection()"
      >
        <!-- 水印覆盖层：不参与交互（pointer-events-none），设计态近似 -->
        <div
          v-if="watermark"
          class="pointer-events-none absolute inset-0 z-10 overflow-hidden"
          data-testid="watermark-overlay"
        >
          <template v-if="watermark.type === 'image'">
            <div
              v-if="watermarkSrcIsExpr"
              class="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-400"
              :style="{ opacity: watermark.opacity ?? 0.15 }"
              data-testid="watermark-placeholder"
            >
              水印图片（表达式占位）
            </div>
            <img
              v-else
              :src="watermark.src"
              alt=""
              class="absolute left-1/2 top-1/2 max-h-1/2 max-w-1/2 -translate-x-1/2 -translate-y-1/2"
              :style="{ opacity: watermark.opacity ?? 0.15 }"
              data-testid="watermark-image"
            />
          </template>
          <div
            v-else
            class="grid h-full place-items-center"
            :class="watermark.tile ? 'grid-cols-3' : 'grid-cols-1'"
          >
            <span
              v-for="i in watermarkCopies"
              :key="i"
              class="whitespace-nowrap text-2xl font-bold text-gray-800"
              :style="watermarkTextStyle"
              data-testid="watermark-text"
            >
              {{ watermark.text }}
            </span>
          </div>
        </div>

        <div
          v-if="nup"
          data-testid="nup-chip"
          class="mb-1 inline-block rounded bg-indigo-50 px-1.5 py-0.5 text-[10px] text-indigo-700"
        >
          一页多单：{{ nup.cols }}×{{ nup.rows }}（共 {{ nup.cols * nup.rows }} 份，渲染器分页填数）
        </div>

        <div :style="nupGridStyle">
          <div>
            <CanvasElementHost
              v-for="(el, i) in header"
              :key="uidOf(el)"
              :model="el"
              :index="i"
              :selected="false"
              device="doc"
            />
            <CanvasElementHost
              v-for="(el, i) in body"
              :key="uidOf(el)"
              :model="el"
              :index="i"
              :selected="store.selectedIndex === i"
              device="doc"
              @select="store.select(i)"
            />
            <CanvasElementHost
              v-for="(el, i) in footer"
              :key="uidOf(el)"
              :model="el"
              :index="i"
              :selected="false"
              device="doc"
            />
          </div>

          <!-- nup 只读副本：结构保真预览，不可选中 -->
          <div
            v-for="k in nupCopies"
            :key="`nup-${k}`"
            class="border border-dashed border-gray-200 p-1"
            data-testid="nup-copy"
          >
            <template v-for="(el, i) in nupReadOnly" :key="`c-${k}-${i}`">
              <component
                :is="elementRegistry[el.type]"
                v-if="elementRegistry[el.type]"
                :model="el"
              />
              <div
                v-else
                class="border border-gray-200 bg-gray-50 px-1.5 py-1 text-xs text-gray-400"
              >
                {{ el.type }}
              </div>
            </template>
          </div>
        </div>
      </div>

      <!-- receipt：小票纸宽流式布局 -->
      <div
        v-else-if="store.device === 'receipt'"
        class="mx-auto bg-white shadow"
        :style="{ width: `${receiptWidthPx}px` }"
        data-testid="canvas-receipt-page"
        @click.self="store.clearSelection()"
      >
        <CanvasElementHost
          v-for="(el, i) in body"
          :key="uidOf(el)"
          :model="el"
          :index="i"
          :selected="store.selectedIndex === i"
          device="receipt"
          @select="store.select(i)"
        />
      </div>

      <!-- label：绝对坐标布局（interactjs 拖拽/缩放在 CanvasElementHost） -->
      <div
        v-else-if="store.device === 'label'"
        class="relative mx-auto border border-gray-300 bg-white shadow"
        :style="{ width: `${labelSizePx[0]}px`, height: `${labelSizePx[1]}px` }"
        data-testid="canvas-label-page"
        @click.self="store.clearSelection()"
      >
        <div v-for="(el, i) in body" :key="uidOf(el)" :style="labelStyle(i)">
          <CanvasElementHost
            :model="el"
            :index="i"
            :selected="store.selectedIndex === i"
            device="label"
            class="h-full w-full"
            @select="store.select(i)"
          />
        </div>
      </div>
    </div>
  </div>
</template>
