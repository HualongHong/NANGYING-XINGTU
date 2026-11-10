import { describe, expect, it } from 'vitest';
import { exportCoursePackage } from '../core/course/exportCoursePackage.js';
import type { TeachingScript } from '../core/course/generateTeachingScript.js';

const SCRIPT: TeachingScript = {
  storyboardScript: [
    {
      lessonId: 'les-1',
      title: '监督学习',
      scenes: [
        {
          id: 'scene-1', lessonId: 'les-1', phase: '导入', sceneType: '标题卡',
          visual: '画面', voiceover: '同学们好，本节是监督学习。', subtitle: '同学们好，本节是监督学习。',
          minutes: 2, startMinute: 0, conceptIds: [],
        },
        {
          id: 'scene-2', lessonId: 'les-1', phase: '讲解', sceneType: 'PPT展示',
          visual: '画面', voiceover: '接下来我们看梯度下降。', subtitle: '接下来我们看梯度下降。',
          minutes: 8, startMinute: 2, conceptIds: ['con-b'],
        },
      ],
    },
  ],
  voiceoverScript: [{ lessonId: 'les-1', title: '监督学习', text: '同学们好。\n接下来我们看梯度下降。' }],
  subtitleScript: [
    { lessonId: 'les-1', sceneId: 'scene-1', startMinute: 0, minutes: 2, text: '同学们好，本节是监督学习。' },
    { lessonId: 'les-1', sceneId: 'scene-2', startMinute: 2, minutes: 8, text: '接下来我们看梯度下降。' },
  ],
};

const EN_SCRIPT: TeachingScript = {
  ...SCRIPT,
  subtitleScript: SCRIPT.subtitleScript.map((c) => ({ ...c, text: `EN: ${c.text}` })),
};

describe('export_course_package', () => {
  it('全格式内容模型：manifest 字段、文件路径规范、SCORM XML 关键字段', async () => {
    const r = await exportCoursePackage({
      script: SCRIPT,
      translations: [{ lang: 'en', script: EN_SCRIPT }],
      meta: { title: '机器学习基础' },
      options: { packageName: 'ml-basics' },
    });
    expect(r.level).toBe('full');
    const { manifest, files } = r.data!.package;
    expect(manifest).toMatchObject({
      packageName: 'ml-basics',
      title: '机器学习基础',
      generatedBy: 'nangying-starmap',
    });
    expect(manifest.formats).toEqual(['scorm', 'ims', 'markdown', 'subtitles', 'multilingual', 'starmap-svg', 'starmap-html']);
    expect(manifest.fileCount).toBe(files.length);
    // 路径规范：POSIX 相对路径，无反斜杠、无空路径
    for (const f of files) {
      expect(f.path).not.toContain('\\');
      expect(f.path.length).toBeGreaterThan(0);
    }
    // SCORM 1.2 manifest 关键字段
    const scorm = files.find((f) => f.path === 'scorm/imsmanifest.xml')!;
    expect(scorm.content).toContain('<schema>ADL SCORM</schema>');
    expect(scorm.content).toContain('<schemaversion>1.2</schemaversion>');
    expect(scorm.content).toContain('identifier="MANIFEST-');
    expect(scorm.content).toContain('identifierref="RES-1"');
    expect(scorm.content).toContain('href="content/les-1.html"');
    // IMS CC manifest
    const ims = files.find((f) => f.path === 'ims/imsmanifest.xml')!;
    expect(ims.content).toContain('IMS Common Cartridge');
    expect(ims.content).toContain('identifier="imscc-');
    // 内容页存在
    expect(files.some((f) => f.path === 'content/les-1.html')).toBe(true);
    // 契约输出字段映射
    expect(r.data!.scormPackage).toBe('scorm/imsmanifest.xml');
    expect(r.data!.imsPackage).toBe('ims/imsmanifest.xml');
    expect(r.data!.multilingualPackage).toBe('multilingual/');
    expect(r.data!.subtitleFiles).toEqual([
      'multilingual/en/course.en.srt',
      'subtitles/course.zh.srt',
    ]);
  });

  it('markdown 含口播文本；SRT 时码合法', async () => {
    const r = await exportCoursePackage({
      script: SCRIPT,
      options: { formats: ['markdown', 'subtitles'] },
    });
    const md = r.data!.package.files.find((f) => f.path === 'markdown/package.md')!;
    expect(md.content).toContain('接下来我们看梯度下降');
    expect(md.content).toContain('## 监督学习');
    const srt = r.data!.package.files.find((f) => f.path.endsWith('.srt'))!;
    expect(srt.content).toMatch(/\d{2}:\d{2}:\d{2},\d{3} --> \d{2}:\d{2}:\d{2},\d{3}/);
  });

  it('多语分目录输出', async () => {
    const r = await exportCoursePackage({
      script: SCRIPT,
      translations: [{ lang: 'en', script: EN_SCRIPT }],
      options: { formats: ['multilingual', 'subtitles'] },
    });
    const paths = r.data!.package.files.map((f) => f.path);
    expect(paths).toContain('multilingual/en/package.md');
    expect(paths).toContain('multilingual/en/course.en.srt');
    expect(paths).toContain('subtitles/course.zh.srt');
  });

  it('不支持的格式触发契约降级：兜底 markdown+subtitles 且标 degraded', async () => {
    const r = await exportCoursePackage({
      script: SCRIPT,
      // @ts-expect-error 故意传入非法格式
      options: { formats: ['scorm', 'hologram'] },
    });
    expect(r.level).toBe('degraded');
    expect(r.degradationNote).toContain('hologram');
    const paths = r.data!.package.files.map((f) => f.path);
    expect(paths).toEqual(['markdown/package.md', 'subtitles/course.zh.srt']);
  });

  it('空脚本 → degraded 空包骨架', async () => {
    const r = await exportCoursePackage({
      script: { storyboardScript: [], voiceoverScript: [], subtitleScript: [] },
    });
    expect(r.level).toBe('degraded');
    expect(r.data!.package.files).toEqual([]);
  });

  it('确定性：两次全格式导出一致', async () => {
    const input = {
      script: SCRIPT,
      translations: [{ lang: 'en', script: EN_SCRIPT }],
      meta: { title: '机器学习基础' },
    };
    const a = await exportCoursePackage(input);
    const b = await exportCoursePackage(input);
    expect(JSON.stringify(a.data)).toBe(JSON.stringify(b.data));
  });
});

describe('R12-1 starmap-svg/starmap-html 产物推送点', () => {
  const GRAPH = {
    schemaVersion: '1.2',
    entities: [
      { id: 'con-1', kind: 'concept' as const, label: '梯度下降', level: 0, order: 0 },
      { id: 'con-2', kind: 'concept' as const, label: '损失函数', level: 0, order: 1 },
    ],
    relations: [{ id: 'e1', from: 'con-1', to: 'con-2', type: 'related' as const, weight: 2 }],
    hierarchy: [{ id: 'sec-0', title: '第一章', level: 1, order: 0, children: [] }],
    prerequisiteGraph: { nodes: ['con-1', 'con-2'], edges: [], topoOrder: ['con-1', 'con-2'] },
  };

  it('formats 含 starmap-svg/starmap-html + graph → 产出真实 svg/html（含节点与图例内容）', async () => {
    const r = await exportCoursePackage({
      script: SCRIPT,
      graph: GRAPH,
      meta: { title: 'ML' },
      options: { formats: ['starmap-svg', 'starmap-html'] },
    });
    expect(r.level).toBe('full');
    const files = r.data!.package.files;
    const svg = files.find((f) => f.path === 'starmap/starmap.svg')!;
    const html = files.find((f) => f.path === 'starmap/index.html')!;
    expect(svg).toBeDefined();
    expect(html).toBeDefined();
    expect(svg.content).toContain('<svg');
    expect(svg.content).toContain('梯度下降');
    expect(svg.content).toContain('第一章');
    expect(svg.content).toContain('class="edge-r"');
    expect(html.content).toContain('<!DOCTYPE html>');
    expect(html.content).not.toContain('starmap.svg'); // HTML 内联 SVG 而非引用
    expect(html.content).toContain('<svg');
    // 确定性
    const r2 = await exportCoursePackage({
      script: SCRIPT, graph: GRAPH, meta: { title: 'ML' },
      options: { formats: ['starmap-svg', 'starmap-html'] },
    });
    expect(JSON.stringify(r2.data)).toBe(JSON.stringify(r.data));
  });

  it('产业图谱走 starmap 格式 → R11 类型识别渲染（产业星图 + 图例）', async () => {
    const { buildIndustryGraph } = await import('../core/graph/buildIndustryGraph.js');
    const ind = await buildIndustryGraph({ sections: [{ title: '检测', fields: { 岗位: ['质检工程师'], 技能要求: ['分光光度法'] } }] });
    const r = await exportCoursePackage({
      script: SCRIPT,
      graph: ind.data!,
      options: { formats: ['starmap-svg'] },
    });
    const svg = r.data!.package.files.find((f) => f.path === 'starmap/starmap.svg')!;
    expect(svg.content).toContain('产业星图');
    expect(svg.content).toContain('class="legend"');
    expect(svg.content).toContain('岗位 ×1');
  });

  it('缺 graph → 跳过星图产物并诚实注明', async () => {
    const r = await exportCoursePackage({
      script: SCRIPT,
      options: { formats: ['starmap-svg', 'starmap-html'] },
    });
    expect(r.data!.package.files).toHaveLength(0);
    expect(r.degradationNote).toContain('graph');
  });

  it('outputPath 落盘：starmap/ 真实文件 + writtenFiles 追加', async () => {
    const { LocalAdapter } = await import('../adapters/core/local.adapter.js');
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { existsSync, readFileSync } = await import('node:fs');
    const dir = mkdtempSync(join(tmpdir(), 'ny-starmap-'));
    const adapter = new LocalAdapter();
    const r = await adapter.invokeSkill('export_course_package', {
      inputs: {
        script: SCRIPT,
        graph: GRAPH,
        meta: { title: 'ML' },
        options: { formats: ['markdown', 'starmap-svg', 'starmap-html'] },
        outputPath: dir,
      },
    });
    expect(existsSync(join(dir, 'starmap', 'starmap.svg'))).toBe(true);
    expect(existsSync(join(dir, 'starmap', 'index.html'))).toBe(true);
    expect(readFileSync(join(dir, 'starmap', 'starmap.svg'), 'utf8')).toContain('梯度下降');
    const data = r.data as { writtenFiles?: string[] };
    expect(data.writtenFiles?.some((f) => f.endsWith('starmap.svg'))).toBe(true);
    expect(data.writtenFiles?.some((f) => f.endsWith('index.html'))).toBe(true);
  });
});
