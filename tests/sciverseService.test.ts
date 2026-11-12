import { describe, expect, it } from 'vitest';
import { createSciverseService } from '../adapters/odlab/sciverse.js';

describe('SciVerse 服务包装（adapters/odlab/sciverse.ts，真实模块无网络）', () => {
  it('无 Token：{ ok:false, reason } 指明配置路径（执行器据此 degraded）', async () => {
    const r = await createSciverseService({ keyProvider: () => undefined });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain('未配置 SciVerse API Token');
      expect(r.reason).toContain('SCIVERSE_API_TOKEN');
    }
  });

  it('空串/纯空白 Token 视为未配置', async () => {
    const r = await createSciverseService({ keyProvider: () => '   ' });
    expect(r.ok).toBe(false);
  });

  it('有 Token：服务就绪且暴露 semanticSearch/searchMetadata（不发起网络请求）', async () => {
    const r = await createSciverseService({ keyProvider: () => 'sv-test-token-0000' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(typeof r.service.semanticSearch).toBe('function');
      expect(typeof r.service.searchMetadata).toBe('function');
    }
  });
});
