<script setup lang="ts">
// 元素宿主：选中态 + label 呈现的 interactjs 拖拽/缩放（手写包装组件口径）。
// readOnly 完整编辑锁——interact 不启用 + 视觉灰态 + click 拦截。
import interact from 'interactjs';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { elementRegistry } from './elements/registry';
import { useDesignerStore } from './store';
import type { CanvasElement, Device } from './types';

const props = defineProps<{
  model: CanvasElement;
  index: number;
  selected: boolean;
  device: Device;
}>();

const emit = defineEmits<{ select: [] }>();
const store = useDesignerStore();
const el = ref<HTMLElement>();
let interactable: ReturnType<typeof interact> | null = null;

// 必须为 computed：实例可能被 v-for 复用（key 变化场景），需随 model.type 响应式切换
const inner = computed(() => elementRegistry[props.model.type]);

// readOnly 下元素不可选中（store.select 已门禁，点击也无副作用）
const locked = computed(() => store.readOnly);

// 位置/尺寸由 DSL（mm）驱动并每帧回写，interact 自身的 transform 需清零避免叠加
function clearTransform(target: HTMLElement): void {
  target.style.transform = '';
  target.style.width = '';
  target.style.height = '';
}

// 仅选中元素创建 interactable（每实例 ~30-50KB），未选中元素零开销；
// readOnly 下不启用——store.moveLabelSelected/resizeSelected 已 self-guard，但 interact
// 监听器仍会触发，提前 unset 减少 DOM 事件噪音（双层门禁）
function setupInteract(): void {
  if (!el.value || props.device !== 'label' || !props.selected || locked.value || interactable)
    return;
  interactable = interact(el.value)
    .draggable({
      listeners: {
        start() {
          emit('select');
        },
        move(event) {
          store.moveLabelSelected(event.dx, event.dy);
          clearTransform(event.target as HTMLElement);
        },
      },
    })
    .resizable({
      edges: { right: true, bottom: true },
      listeners: {
        move(event) {
          store.resizeSelected(event.deltaRect.width, event.deltaRect.height);
          clearTransform(event.target as HTMLElement);
        },
      },
    });
}

function teardownInteract(): void {
  interactable?.unset();
  interactable = null;
}

onMounted(setupInteract);
watch(
  () => [props.device, props.selected, locked.value] as const,
  () => {
    teardownInteract();
    setupInteract();
  },
);
onBeforeUnmount(teardownInteract);
</script>

<template>
  <div
    ref="el"
    class="group relative rounded-sm focus:outline-none"
    :class="
      locked
        ? selected
          ? 'ring-2 ring-dashed ring-gray-400 canvas-element-readonly'
          : 'canvas-element-readonly opacity-80'
        : selected
          ? 'ring-2 ring-blue-500'
          : 'hover:ring-1 hover:ring-blue-300 focus-visible:ring-1 focus-visible:ring-blue-300'
    "
    data-testid="canvas-element"
    tabindex="0"
    role="button"
    :aria-label="`元素 ${model.type}（第 ${index + 1} 个）${locked ? '（只读）' : ''}`"
    :aria-pressed="selected"
    :aria-disabled="locked ? 'true' : 'false'"
    @click.stop="!locked && emit('select')"
    @keydown.enter.prevent="!locked && emit('select')"
    @keydown.space.prevent="!locked && emit('select')"
  >
    <component :is="inner" v-if="inner" :model="model" />
    <div v-else class="border border-gray-200 bg-gray-50 px-1.5 py-1 text-xs text-gray-400">
      {{ model.type }}
    </div>
    <span
      v-if="selected"
      :class="
        locked
          ? 'absolute -top-4 left-0 rounded-sm bg-gray-400 px-1 text-[10px] leading-4 text-white'
          : 'absolute -top-4 left-0 rounded-sm bg-blue-500 px-1 text-[10px] leading-4 text-white'
      "
    >
      {{ model.type }}[{{ index }}]{{ locked ? '（只读）' : '' }}
    </span>
  </div>
</template>
