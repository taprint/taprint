// SPDX-License-Identifier: Apache-2.0
// 画布元素库：各元素类型的默认模板（新增元素入口；与 schema 元素类型对齐）
//
// label 模式暴露面：text/barcode/qrcode/image/line/box 六元素
// ——table/kvtable 收进 doc/receipt 门禁（价签不需要；schema v1.1 labelElement 白名单
// 同步六型）。doc 专属容器 loop/conditional 沿用 devices 门禁。
// schema 中的辅助元素 rect/spacer/pageBreak（doc）与 cut/cashDrawer（receipt）
// 计划后续补齐；在此之前 CanvasElementHost 对未注册类型降级显示 type 名。
import type { CanvasElement, Device } from './types';

export interface ElementLibraryItem {
  type: string;
  label: string;
  /** 设备门禁：缺省全设备可见；专项步骤 4 范围仅 doc/A4 */
  devices?: Device[];
  /** 生成默认元素；label 呈现补绝对坐标（x/y） */
  create(device: Device, index: number, detailSource?: string): CanvasElement;
}

const labelPos = (index: number): Pick<CanvasElement, 'x' | 'y'> => ({
  x: '5mm',
  y: `${5 + index * 12}mm`,
});

export const elementLibrary: ElementLibraryItem[] = [
  {
    type: 'text',
    label: '文本',
    create: (device, index) => ({
      type: 'text',
      content: '双击编辑文本',
      ...(device === 'label' ? labelPos(index) : {}),
    }),
  },
  {
    type: 'image',
    label: '图片',
    create: (device, index) => ({
      type: 'image',
      src: '',
      width: '30mm',
      height: '20mm',
      ...(device === 'label' ? labelPos(index) : {}),
    }),
  },
  {
    type: 'barcode',
    label: '条码',
    create: (device, index) => ({
      type: 'barcode',
      content: '',
      symbology: 'CODE128',
      height: '10mm',
      ...(device === 'label' ? labelPos(index) : {}),
    }),
  },
  {
    type: 'qrcode',
    label: '二维码',
    create: (device, index) => ({
      type: 'qrcode',
      content: '',
      size: 8,
      ...(device === 'label' ? labelPos(index) : {}),
    }),
  },
  {
    type: 'table',
    label: '表格',
    devices: ['doc', 'receipt'], // T2 收口：label 模式不暴露（schema labelElement 白名单外）
    create: (device, index, detailSource) => ({
      type: 'table',
      source: detailSource ?? 'items',
      columns: [
        { header: '名称', field: 'name', width: '50%' },
        { header: '数量', field: 'qty', align: 'right', width: '25%' },
        { header: '金额', field: 'amount', align: 'right', width: '25%' },
      ],
      ...(device === 'label' ? labelPos(index) : {}),
    }),
  },
  {
    type: 'kvtable',
    label: '键值表',
    devices: ['doc', 'receipt'], // T2 收口：label 模式不暴露（schema labelElement 白名单外）
    create: (device, index) => ({
      type: 'kvtable',
      columns: 2,
      rows: [
        [
          ['键', '{{字段}}'],
          ['键', '{{字段}}'],
        ],
      ],
      ...(device === 'label' ? labelPos(index) : {}),
    }),
  },
  {
    type: 'line',
    label: '直线',
    create: (device, index) => ({
      type: 'line',
      lineStyle: 'solid',
      width: '36mm',
      height: '0mm',
      thickness: 2,
      ...(device === 'label' ? labelPos(index) : {}),
    }),
  },
  {
    type: 'box',
    label: '矩形框',
    create: (device, index) => ({
      type: 'box',
      width: '36mm',
      height: '26mm',
      thickness: 2, // dot；schema v1.1：radius 可选（TSPL 无原生命令渲染降级直角）
      ...(device === 'label' ? labelPos(index) : {}),
    }),
  },
  {
    type: 'loop',
    label: '循环',
    devices: ['doc'],
    create: (_device, _index, detailSource) => ({
      type: 'loop',
      each: detailSource ?? '', // 无 detail 源时留空，由属性面板选源（避免伪造引用）
      body: [{ type: 'text', content: '循环体（在属性面板编辑）' }],
    }),
  },
  {
    type: 'conditional',
    label: '条件',
    devices: ['doc'],
    create: () => ({
      type: 'conditional',
      when: '',
      body: [{ type: 'text', content: '条件成立时显示' }],
      elseBody: [{ type: 'text', content: '条件不成立时显示' }],
    }),
  },
];
