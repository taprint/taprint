// SPDX-License-Identifier: Apache-2.0
// embed 模式 SDK 入口（设计契约）。
// init 序列由 sdk-core.startEmbed 接管（token 注入 → 宿主消息监听 → store → ready）。
import { destroyEmbed, startEmbed } from './sdk-core';

export interface TaprintDesignerSDK {
  mount(selector: string): void;
  destroy(): void;
}

export function mountEmbed(selector: string): void {
  void startEmbed(selector).catch((e: unknown) => {
    console.error('[designer embed] 启动失败：', e);
  });
}

export const sdk: TaprintDesignerSDK = {
  mount: mountEmbed,
  destroy: destroyEmbed,
};

declare global {
  interface Window {
    TaprintDesigner?: TaprintDesignerSDK;
  }
}

window.TaprintDesigner = sdk;
