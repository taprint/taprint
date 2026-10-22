// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it } from 'vitest';
import { useMode } from '../../src/shared/mode';

// 双模式判定（设计契约）：query embedMode 优先，路径 /embed 兜底
function navigate(url: string) {
  window.history.replaceState({}, '', url);
}

describe('useMode', () => {
  afterEach(() => navigate('/'));

  it.each(['wpf', 'flutter', 'web-iframe'])(
    'embedMode=%s 判定为 embed（本地资源主路径无 /embed）',
    (embedMode) => {
      navigate(`/?templateId=t-001&embedMode=${embedMode}`);
      expect(useMode()).toBe('embed');
    },
  );

  it('路径 /embed 兜底判定为 embed（远程 URL 无 query）', () => {
    navigate('/embed');
    expect(useMode()).toBe('embed');
  });

  it('非法 embedMode 值且非 /embed 路径判定为 full', () => {
    navigate('/?embedMode=hack');
    expect(useMode()).toBe('full');
  });

  it('无 query 无 /embed 路径判定为 full', () => {
    navigate('/design/t-001');
    expect(useMode()).toBe('full');
  });
});
