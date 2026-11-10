import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toZipBuffer, writePackageZip, writePackageDir, crc32 } from '../adapters/core/packageWriter.js';
import { exportCoursePackage, type PackageContentModel } from '../core/course/exportCoursePackage.js';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'nangying-pkg-'));
  dirs.push(d);
  return d;
}

const MODEL: PackageContentModel = {
  manifest: { packageName: 'test', title: '测试包', formats: ['markdown'], fileCount: 2, generatedBy: 'nangying-starmap' },
  files: [
    { path: 'a/hello.txt', content: '你好，囊萤星图' },
    { path: 'b/world.txt', content: 'hello world' },
  ],
};

describe('packageWriter', () => {
  it('CRC32 标准值', () => {
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
  });

  it('ZIP 结构可读：签名、条目数、EOCD、内容可定位', () => {
    const zip = toZipBuffer(MODEL);
    // 以 PK\x03\x04 起始
    expect(zip.readUInt32LE(0)).toBe(0x04034b50);
    // EOCD 在尾部：签名 + 条目数 2
    const eocdOffset = zip.length - 22;
    expect(zip.readUInt32LE(eocdOffset)).toBe(0x06054b50);
    expect(zip.readUInt16LE(eocdOffset + 10)).toBe(2);
    // 第二个 local header 存在于流中，且 UTF-8 内容原样存储
    const idx = zip.indexOf(Buffer.from('你好，囊萤星图'));
    expect(idx).toBeGreaterThan(0);
    expect(idx + Buffer.byteLength('你好，囊萤星图')).toBeLessThan(eocdOffset);
    // 确定性：两次序列化逐字节一致
    expect(toZipBuffer(MODEL).equals(zip)).toBe(true);
  });

  it('writePackageZip 写盘后可读回同样结构', () => {
    const dir = tempDir();
    const file = join(dir, 'out', 'pkg.zip');
    writePackageZip(MODEL, file);
    const zip = readFileSync(file);
    expect(zip.readUInt32LE(0)).toBe(0x04034b50);
    expect(zip.readUInt32LE(zip.length - 22)).toBe(0x06054b50);
  });

  it('writePackageDir 目录输出：文件存在且内容与模型一致', async () => {
    const dir = tempDir();
    const out = join(dir, 'pkg');
    const { exportCoursePackage } = await import('../core/course/exportCoursePackage.js');
    const r = await exportCoursePackage({
      script: {
        storyboardScript: [
          {
            lessonId: 'les-1', title: '课时一',
            scenes: [
              {
                id: 's1', lessonId: 'les-1', phase: '讲解', sceneType: 'PPT展示',
                visual: 'v', voiceover: '口播文本', subtitle: '口播文本',
                minutes: 5, startMinute: 0, conceptIds: [],
              },
            ],
          },
        ],
        voiceoverScript: [{ lessonId: 'les-1', title: '课时一', text: '口播文本' }],
        subtitleScript: [{ lessonId: 'les-1', sceneId: 's1', startMinute: 0, minutes: 5, text: '口播文本' }],
      },
      options: { formats: ['markdown', 'subtitles', 'scorm'] },
    });
    writePackageDir(r.data!.package, out);
    const md = readFileSync(join(out, 'markdown', 'package.md'), 'utf8');
    expect(md).toContain('口播文本');
    const srt = readFileSync(join(out, 'subtitles', 'course.zh.srt'), 'utf8');
    expect(srt).toContain('00:00:00,000');
    expect(existsSync(join(out, 'scorm', 'imsmanifest.xml'))).toBe(true);
    expect(existsSync(join(out, 'content', 'les-1.html'))).toBe(true);
  });
});
