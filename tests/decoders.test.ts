import { describe, expect, it, vi } from 'vitest';
import { createDecoder, redact } from '../adapters/core/decoders/factory.js';
import type { DecoderConfig } from '../core/decode/documentDecoder.js';

const KEY = 'test-key-xxx';
const keyProvider = () => KEY;

function mockFetch(ok: boolean, body: string, status = 200): typeof fetch {
  return vi.fn(async () =>
    new Response(ok ? body : `error: invalid key ${KEY}`, { status }),
  ) as unknown as typeof fetch;
}

describe('decoder factory', () => {
  it('未知 provider 抛中文错误', () => {
    expect(() =>
      createDecoder({ provider: 'hologram' } as DecoderConfig, keyProvider),
    ).toThrow('未知的解码器供应商');
  });

  it('缺 key 时抛中文提示', async () => {
    const decoder = createDecoder({ provider: 'kimi' }, () => undefined);
    await expect(
      decoder.decode({ data: new Uint8Array([1]), materialType: 'pdf' }),
    ).rejects.toThrow('未配置 API key');
  });
});

describe('kimi 解码器', () => {
  const config: DecoderConfig = { provider: 'kimi', model: 'm1', endpoint: 'https://api.moonshot.cn' };

  it('请求构造正确（endpoint/model/Authorization），响应解析正确', async () => {
    const fetchImpl = mockFetch(true, JSON.stringify({ content: '解析出的文本' }));
    const decoder = createDecoder(config, keyProvider, { fetchImpl });
    const doc = await decoder.decode({ data: new Uint8Array([0x25, 0x50]), materialType: 'pdf' });
    expect(doc.content).toBe('解析出的文本');
    expect(doc.materialType).toBe('pdf');
    const call = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe('https://api.moonshot.cn/v1/files/extract');
    expect((call[1].headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
  });

  it('错误响应中 key 被脱敏（输出不含明文 key）', async () => {
    const fetchImpl = mockFetch(false, '', 401);
    const decoder = createDecoder(config, keyProvider, { fetchImpl });
    await expect(
      decoder.decode({ data: new Uint8Array([1]), materialType: 'pdf' }),
    ).rejects.toThrow('Kimi 解码失败');
    await expect(
      decoder.decode({ data: new Uint8Array([1]), materialType: 'pdf' }),
    ).rejects.toThrow(/HTTP 401/);
    try {
      await decoder.decode({ data: new Uint8Array([1]), materialType: 'pdf' });
    } catch (err) {
      expect(String(err)).not.toContain(KEY);
      expect(String(err)).toContain('***');
    }
  });
});

describe('openai 视觉解码器', () => {
  const config: DecoderConfig = { provider: 'openai', model: 'gpt-4o' };

  it('请求构造正确（chat/completions + base64 图片 + 转录 prompt）', async () => {
    const fetchImpl = mockFetch(
      true,
      JSON.stringify({ choices: [{ message: { content: '逐页转录文本' } }] }),
    );
    const decoder = createDecoder(config, keyProvider, { fetchImpl });
    const doc = await decoder.decode({ data: new Uint8Array([0x89, 0x50]), materialType: 'pdf' });
    expect(doc.content).toBe('逐页转录文本');
    const call = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe('https://api.openai.com/v1/chat/completions');
    const body = JSON.parse(call[1].body as string);
    expect(body.model).toBe('gpt-4o');
    expect(body.messages[0].content[0].text).toContain('逐页转录');
    expect(body.messages[0].content[1].image_url.url).toMatch(/^data:application\/pdf;base64,/);
  });

  it('错误信息脱敏', async () => {
    const fetchImpl = mockFetch(false, `{"error":"key ${KEY} rejected"}`, 403);
    const decoder = createDecoder(config, keyProvider, { fetchImpl });
    try {
      await decoder.decode({ data: new Uint8Array([1]), materialType: 'png' });
      expect.unreachable();
    } catch (err) {
      expect(String(err)).not.toContain(KEY);
    }
  });
});

describe('redact 工具', () => {
  it('替换 key 子串；短 key 不误伤', () => {
    expect(redact(`认证失败：key ${KEY} 无效`, KEY)).toBe('认证失败：key *** 无效');
    expect(redact('正常文本', 'abc')).toBe('正常文本');
    expect(redact('正常文本', undefined)).toBe('正常文本');
  });
});
