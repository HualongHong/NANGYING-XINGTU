/**
 * 课程包导出（export_course_package）——N4 收尾切片。
 *
 * core 零 Node API：产出"包内容模型"（manifest + 文件条目数组的确定性列表），
 * 压缩/落盘归适配层（adapters/core/packageWriter.ts）。
 *
 * 支持格式：scorm（SCORM 1.2 最小结构）/ ims（IMS CC 最小结构）/
 * markdown（讲稿）/ subtitles（SRT，复用 synthesizeSpeech 渲染）/ multilingual（多语分目录）。
 * 降级（契约）：请求的格式不被支持或输入为空时，兜底为 markdown+subtitles 并标 degraded。
 */
import type { SkillResult } from '../types.js';
import type { TeachingScript } from './generateTeachingScript.js';
import type { CourseKnowledgeGraph } from '../graph/extractKnowledgeGraph.js';
import type { QaKnowledgeBase } from '../qa/buildQaKnowledgeBase.js';
import { renderSrt } from '../specialized/synthesizeSpeech.js';
import { buildHandoutDocxParts, buildSlidesPptxParts, type OoxmlRow } from './ooxmlRender.js';
import { renderStarmapHtml, renderStarmapSvg } from '../graph/renderStarmap.js';

export const EXPORT_COURSE_PACKAGE_ID = 'export_course_package';

export type PackageFormat = 'scorm' | 'ims' | 'markdown' | 'subtitles' | 'multilingual' | 'starmap-svg' | 'starmap-html'
  | 'handout-docx' | 'slides-pptx';

export interface PackageFileEntry {
  /** 包内相对路径（POSIX 风格） */
  path: string;
  content: string;
}

export interface PackageContentModel {
  manifest: {
    packageName: string;
    title: string;
    formats: PackageFormat[];
    fileCount: number;
    generatedBy: 'nangying-starmap';
  };
  files: PackageFileEntry[];
}

export interface ExportCoursePackageInput {
  /** 教学脚本（必选） */
  script: TeachingScript;
  /** 多语版本（translate_multilingual 产物中的 script 字段） */
  translations?: Array<{ lang: string; script: TeachingScript }>;
  /** 课程知识图谱 JSON（可选，导出为 graph.json） */
  graph?: CourseKnowledgeGraph;
  /** 问答库（可选，导出为 qa.json） */
  qaKnowledgeBase?: QaKnowledgeBase;
  /** R14：handout-docx 附加表格（格子支持 { text, colSpan?, rowSpan?, align? } 合并单元格） */
  handoutTables?: Array<{ title?: string; rows: OoxmlRow[] }>;
  meta?: { title?: string; author?: string; lang?: string };
  options?: {
    formats?: PackageFormat[];
    packageName?: string;
    lang?: string;
    /** 自定义目录模板（R5-5.4）：如 "{lesson}/script.md"；令牌 {lesson} {lessonId} {index} {ext}；
     *  给出时按课时产出 markdown 文件替换默认 markdown/package.md，其余产物不变 */
    directoryTemplate?: string;
  };
}

export interface ExportCoursePackageOutput {
  /** 包内容模型（落盘/压缩归适配层） */
  package: PackageContentModel;
  /** 各格式产物路径速查（契约输出字段的映射） */
  scormPackage?: string;
  imsPackage?: string;
  videoFiles: string[];
  subtitleFiles: string[];
  multilingualPackage?: string;
  /** 落盘报告的绝对路径列表（R5-5.1：outputPath 提供时给出） */
  writtenFiles?: string[];
}

const ALL_FORMATS: PackageFormat[] = ['scorm', 'ims', 'markdown', 'subtitles', 'multilingual', 'starmap-svg', 'starmap-html'];
/** R4-3：可选写出格式（不进默认全集，显式请求才产出，缺省行为不变） */
const OPTIONAL_FORMATS: PackageFormat[] = ['handout-docx', 'slides-pptx'];
const KNOWN_FORMATS: PackageFormat[] = [...ALL_FORMATS, ...OPTIONAL_FORMATS];

function stableHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderMarkdown(script: TeachingScript, title: string): string {
  const lines: string[] = [`# ${title}`, ''];
  for (const lesson of script.storyboardScript) {
    lines.push(`## ${lesson.title}`, '');
    for (const scene of lesson.scenes) {
      lines.push(`### ${scene.phase}（${scene.minutes} 分钟）`, '', scene.voiceover, '');
    }
  }
  return lines.join('\n');
}

function renderSrtFor(script: TeachingScript): string {
  return renderSrt(script.subtitleScript.filter((c) => c.text.trim() !== ''));
}

function scormManifest(packageName: string, title: string, lessons: Array<{ id: string; title: string }>): string {
  const items = lessons
    .map(
      (l, i) =>
        `      <item identifier="ITEM-${i + 1}" identifierref="RES-${i + 1}">\n` +
        `        <title>${xmlEscape(l.title)}</title>\n      </item>`,
    )
    .join('\n');
  const resources = lessons
    .map(
      (l, i) =>
        `    <resource identifier="RES-${i + 1}" type="webcontent" adlcp:scormtype="sco" href="content/${l.id}.html"/>`,
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<manifest identifier="MANIFEST-${stableHash(packageName)}" version="1.2"
  xmlns="http://www.imsproject.org/xsd/imscp_rootv1p1p2"
  xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_rootv1p2">
  <metadata>
    <schema>ADL SCORM</schema>
    <schemaversion>1.2</schemaversion>
  </metadata>
  <organizations default="ORG-1">
    <organization identifier="ORG-1">
      <title>${xmlEscape(title)}</title>
${items}
    </organization>
  </organizations>
  <resources>
${resources}
  </resources>
</manifest>
`;
}

function imsManifest(packageName: string, title: string, lessons: Array<{ id: string; title: string }>): string {
  const items = lessons
    .map(
      (l, i) =>
        `      <item identifier="I_${i + 1}" identifierref="R_${i + 1}">\n` +
        `        <title>${xmlEscape(l.title)}</title>\n      </item>`,
    )
    .join('\n');
  const resources = lessons
    .map(
      (l, i) =>
        `    <resource identifier="R_${i + 1}" type="webcontent" href="content/${l.id}.html">` +
        `<file href="content/${l.id}.html"/></resource>`,
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<manifest identifier="imscc-${stableHash(packageName)}" version="1.1.0"
  xmlns="http://www.imsglobal.org/xsd/imsccv1p1/imscp_v1p1">
  <metadata>
    <schema>IMS Common Cartridge</schema>
    <schemaversion>1.1.0</schemaversion>
  </metadata>
  <organizations>
    <organization identifier="O_1" structure="rooted-hierarchy">
      <title>${xmlEscape(title)}</title>
${items}
    </organization>
  </organizations>
  <resources>
${resources}
  </resources>
</manifest>
`;
}

function contentPage(lesson: { title: string }, scenes: Array<{ phase: string; voiceover: string; subtitle: string }>): string {
  const body = scenes
    .map((s) => `<h2>${xmlEscape(s.phase)}</h2><p>${xmlEscape(s.voiceover)}</p>`)
    .join('\n');
  return `<!DOCTYPE html>
<html lang="zh"><head><meta charset="utf-8"><title>${xmlEscape(lesson.title)}</title></head>
<body>
<h1>${xmlEscape(lesson.title)}</h1>
${body}
</body></html>
`;
}

export async function exportCoursePackage(
  input: ExportCoursePackageInput,
): Promise<SkillResult<ExportCoursePackageOutput>> {
  const { script, translations = [], graph, qaKnowledgeBase, handoutTables, meta, options } = input;
  const packageName = options?.packageName ?? 'course-package';
  const lang = options?.lang ?? meta?.lang ?? 'zh';
  const title = meta?.title ?? script.storyboardScript[0]?.title ?? packageName;
  const lessons = script.storyboardScript.map((l) => ({ id: l.lessonId, title: l.title }));

  if (lessons.length === 0) {
    return {
      skillId: EXPORT_COURSE_PACKAGE_ID,
      level: 'degraded',
      data: {
        package: {
          manifest: { packageName, title, formats: [], fileCount: 0, generatedBy: 'nangying-starmap' },
          files: [],
        },
        videoFiles: [],
        subtitleFiles: [],
      },
      degradationNote: '教学脚本为空，仅返回空包骨架',
    };
  }

  // 格式解析：不支持的格式触发契约降级（兜底 markdown+subtitles）
  const requested = options?.formats ?? ALL_FORMATS;
  const unsupported = requested.filter((f) => !KNOWN_FORMATS.includes(f as PackageFormat));
  const formats: PackageFormat[] =
    unsupported.length > 0 ? ['markdown', 'subtitles'] : [...new Set(requested)];

  const files: PackageFileEntry[] = [];
  const push = (path: string, content: string) => files.push({ path, content });

  if (formats.includes('markdown')) {
    push('markdown/package.md', renderMarkdown(script, title));
  }
  if (formats.includes('subtitles')) {
    push(`subtitles/course.${lang}.srt`, renderSrtFor(script));
  }
  for (const t of formats.includes('multilingual') ? translations : []) {
    push(`multilingual/${t.lang}/package.md`, renderMarkdown(t.script, `${title}（${t.lang}）`));
    push(`multilingual/${t.lang}/course.${t.lang}.srt`, renderSrtFor(t.script));
  }
  for (const lesson of script.storyboardScript) {
    if (formats.includes('scorm') || formats.includes('ims')) {
      const scenes = lesson.scenes.map((s) => ({ phase: s.phase, voiceover: s.voiceover, subtitle: s.subtitle }));
      push(`content/${lesson.lessonId}.html`, contentPage(lesson, scenes));
    }
  }
  if (formats.includes('scorm')) {
    push('scorm/imsmanifest.xml', scormManifest(packageName, title, lessons));
  }
  if (formats.includes('ims')) {
    push('ims/imsmanifest.xml', imsManifest(packageName, title, lessons));
  }
  // R4-3（反馈 a P1-5）：OOXML 部件进包（适配层 outDocx/outPptx 可再打真实 zip 文件）
  if (formats.includes('handout-docx')) {
    for (const part of buildHandoutDocxParts(script, title, handoutTables)) {
      push(`handout/${part.path}`, part.content);
    }
  }
  if (formats.includes('slides-pptx')) {
    for (const part of buildSlidesPptxParts(script, title)) {
      push(`slides/${part.path}`, part.content);
    }
  }
  if (graph) push('graph/graph.json', JSON.stringify(graph, null, 2));
  // R12-1：starmap 产物推送点（修复"声明了 starmap-svg/starmap-html 却没有产物"的真 bug）。
  // 复用 R11 的 renderStarmap（conceptual/experimental/industry/fused 自动识别）；缺 graph 诚实注明。
  const wantsStarmapSvg = formats.includes('starmap-svg');
  const wantsStarmapHtml = formats.includes('starmap-html');
  if ((wantsStarmapSvg || wantsStarmapHtml) && graph) {
    if (wantsStarmapSvg) push('starmap/starmap.svg', renderStarmapSvg(graph));
    if (wantsStarmapHtml) push('starmap/index.html', renderStarmapHtml(graph, title));
  }
  if (qaKnowledgeBase) push('qa/qa.json', JSON.stringify(qaKnowledgeBase, null, 2));

  // R5-5.4：自定义目录模板——按课时产出 markdown 文件替换默认 markdown/package.md
  const tpl = options?.directoryTemplate;
  if (tpl && formats.includes('markdown')) {
    const defaultIdx = files.findIndex((f) => f.path === 'markdown/package.md');
    if (defaultIdx >= 0) files.splice(defaultIdx, 1);
    script.storyboardScript.forEach((lesson, index) => {
      const path = tpl
        .replace(/\{lessonId\}/g, lesson.lessonId)
        .replace(/\{lesson\}/g, lesson.title.replace(/[\\/:*?"<>|]/g, '_'))
        .replace(/\{index\}/g, String(index + 1).padStart(2, '0'))
        .replace(/\{ext\}/g, 'md');
      const body = [
        `# ${lesson.title}`,
        '',
        ...lesson.scenes.map((s) => `## ${s.phase}（${s.minutes} 分钟）\n\n${s.voiceover}`),
      ].join('\n');
      push(path, body);
    });
  }

  // 路径排序，保证确定性
  files.sort((a, b) => a.path.localeCompare(b.path));

  const output: ExportCoursePackageOutput = {
    package: {
      manifest: { packageName, title, formats, fileCount: files.length, generatedBy: 'nangying-starmap' },
      files,
    },
    videoFiles: [],
    subtitleFiles: files.filter((f) => f.path.endsWith('.srt')).map((f) => f.path),
  };
  if (formats.includes('scorm')) output.scormPackage = 'scorm/imsmanifest.xml';
  if (formats.includes('ims')) output.imsPackage = 'ims/imsmanifest.xml';
  if (formats.includes('multilingual') && translations.length > 0) {
    output.multilingualPackage = 'multilingual/';
  }

  return {
    skillId: EXPORT_COURSE_PACKAGE_ID,
    level: unsupported.length > 0 ? 'degraded' : 'full',
    data: output,
    degradationNote:
      unsupported.length > 0
        ? `不支持的格式：${unsupported.join('、')}，已降级为 Markdown+字幕最小包`
        : (wantsStarmapSvg || wantsStarmapHtml) && !graph
          ? 'formats 含 starmap-svg/starmap-html 但未提供 graph 输入：星图产物已跳过'
          : '',
  };
}
