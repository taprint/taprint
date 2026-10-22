// SPDX-License-Identifier: Apache-2.0
// 元素类型 → 渲染组件映射（CanvasElementHost 与 loop/conditional 容器共用；
// 容器内子元素只读预览走同一映射，不经过宿主选中/interact 体系——专项步骤 4）
import type { Component } from 'vue';
import BarcodeElement from './BarcodeElement.vue';
import BoxElement from './BoxElement.vue';
import ConditionalElement from './ConditionalElement.vue';
import ImageElement from './ImageElement.vue';
import KvtableElement from './KvtableElement.vue';
import LineElement from './LineElement.vue';
import LoopElement from './LoopElement.vue';
import QrcodeElement from './QrcodeElement.vue';
import TableElement from './TableElement.vue';
import TextElement from './TextElement.vue';

export const elementRegistry: Record<string, Component> = {
  text: TextElement,
  kvtable: KvtableElement,
  table: TableElement,
  image: ImageElement,
  barcode: BarcodeElement,
  qrcode: QrcodeElement,
  line: LineElement,
  box: BoxElement, // schema v1.1 六元素（T2）
  loop: LoopElement,
  conditional: ConditionalElement,
};
