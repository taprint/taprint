<script setup lang="ts">
// 设备/呈现切换（doc/receipt/label；设计契约）
import { useDesignerStore } from '../store';
import type { Device } from '../types';

const store = useDesignerStore();

const DEVICE_LABELS: Record<Device, string> = {
  doc: 'A4 单据',
  receipt: '小票',
  label: '标签',
};
</script>

<template>
  <div class="flex gap-1" data-testid="device-switcher">
    <button
      v-for="d in store.availableDevices"
      :key="d"
      type="button"
      class="rounded px-2 py-1 text-xs"
      :class="
        store.device === d
          ? 'bg-blue-600 text-white'
          : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
      "
      :data-testid="`device-${d}`"
      @click="store.setDevice(d)"
    >
      {{ DEVICE_LABELS[d] }}
    </button>
  </div>
</template>
