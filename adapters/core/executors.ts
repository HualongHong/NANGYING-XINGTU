/**
 * 共享技能执行器注册。
 * 技能描述符以 manifests/skills.registry.json 为单一事实源（import，不手抄；
 * 该文件由 scripts/gen-registry.mjs 从各契约 md 的「输入声明」段生成）。
 * 执行器职责：materialFile 的文件读取/解码归适配层（本模块，允许 Node API），
 * core 层只收纯文本；执行器原样透回 core 的 SkillResult。
 */
import { readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { isAbsolute, join, resolve as resolvePath, dirname } from 'node:path';
import type { LLMProvider, SkillContext } from '../../core/llm.js';
import type { SkillDescriptor, SkillResult } from '../../core/types.js';
import { looksBinary } from '../../core/decode/documentDecoder.js';
import { parseCourseMaterial, type ParseCourseMaterialOutput, type ParseOcrMeta } from '../../core/nlp/parseCourseMaterial.js';
import { extractKnowledgeGraph } from '../../core/graph/extractKnowledgeGraph.js';
import { designCourseStructure } from '../../core/course/designCourseStructure.js';
import { generateTeachingScript } from '../../core/course/generateTeachingScript.js';
import { translateMultilingual } from '../../core/i18n/translateMultilingual.js';
import { importGlossary, type Glossary } from '../../core/i18n/glossary.js';
import { buildQaKnowledgeBase } from '../../core/qa/buildQaKnowledgeBase.js';
import { recommendLearningPath } from '../../core/graph/recommendLearningPath.js';
import { fuseKnowledgeGraphs } from '../../core/graph/fuseKnowledgeGraphs.js';
import { diffKnowledgeGraphs } from '../../core/graph/diffKnowledgeGraphs.js';
import { generatePersonalizedFeedback } from '../../core/qa/generatePersonalizedFeedback.js';
import { manageCourseAssets, deserializeStore, type AssetOp, type AssetStore } from '../../core/course/manageCourseAssets.js';
import { loadAssetStore, saveAssetStore } from './assetStore.js';
import { getJob, listJobs, cancelJob, cleanupJobs } from './jobQueue.js';
import { readConfig, readApiKey, configDir } from './configStore.js';
import { createDecoder } from './decoders/factory.js';
import { exportCoursePackage } from '../../core/course/exportCoursePackage.js';
import { writePackageZip, writePackageDir } from './packageWriter.js';
import { registerTeacherAvatar } from '../../core/specialized/registerTeacherAvatar.js';
import { synthesizeSpeech } from '../../core/specialized/synthesizeSpeech.js';
import { generateDigitalHumanVideo } from '../../core/specialized/generateDigitalHumanVideo.js';
import { orchestrateMultiTeacher } from '../../core/specialized/orchestrateMultiTeacher.js';
import { matchTeachingScene } from '../../core/specialized/matchTeachingScene.js';
import { syncMultilingualAv } from '../../core/specialized/syncMultilingualAv.js';
import { realtimeQaStream } from '../../core/specialized/realtimeQaStream.js';
import { generateAssessment } from '../../core/qa/generateAssessment.js';
import { auditConsistency } from '../../core/qa/auditConsistency.js';
import { polishTeachingText } from '../../core/text/polishTeachingText.js';
import { syncBilingual } from '../../core/i18n/syncBilingual.js';
import { parseSrt, auditSubtitleTimeline, mergeEngineFindings, finalizeReport } from '../../core/qa/mediaAudit.js';
import { buildIndustryGraph } from '../../core/graph/buildIndustryGraph.js';
import { linkKnowledgeIndustry } from '../../core/graph/linkKnowledgeIndustry.js';
import type { AdapterBase } from './adapter.base.js';
import registry from '../../manifests/skills.registry.json' with { type: 'json' };

/** 已实现技能 ID 列表（执行器就绪；特化技能均为降级实现，level=degraded） */
const IMPLEMENTED_SKILLS = [
  'parse_course_material',
  'extract_knowledge_graph',
  'fuse_knowledge_graphs',
  'diff_knowledge_graphs',
  'design_course_structure',
  'generate_teaching_script',
  'translate_multilingual',
  'build_qa_knowledge_base',
  'recommend_learning_path',
  'generate_personalized_feedback',
  'manage_course_assets',
  'export_course_package',
  'register_teacher_avatar',
  'synthesize_speech',
  'generate_digital_human_video',
  'orchestrate_multi_teacher',
  'match_teaching_scene',
  'sync_multilingual_av',
  'realtime_qa_stream',
  'manage_async_tasks',
  'describe_capabilities',
  'generate_assessment',
  'audit_consistency',
  'polish_teaching_text',
  'sync_bilingual',
  'qa_media',
  'render_preview',
  'build_industry_graph',
  'link_knowledge_industry',
] as const;

type ImplementedSkillId = (typeof IMPLEMENTED_SKILLS)[number];

function descriptorOf(skillId: string): SkillDescriptor {
  const found = (registry as { skills: SkillDescriptor[] }).skills.find(
    (s) => s.skillId === skillId,
  );
  if (!found) throw new Error(`注册表中找不到技能 ${skillId}`);
  return found;
}

/** 二进制材料体积上限（默认 20MB）：超限不进解码链，直接结构化报错（大文件曾打挂整个 MCP 服务） */
const MAX_BINARY_BYTES = 20 * 1024 * 1024;
/** 二进制材料类型（按扩展名推断）：这些类型才适用体积上限与解码链 */
const BINARY_MATERIAL_TYPES = new Set(['pptx', 'ppt', 'pdf', 'docx', 'doc', 'image']);

/** 按扩展名推断材料类型（契约：解码归适配层） */
function inferMaterialType(filePath: string): string {
  const ext = filePath.slice(filePath.lastIndexOf('.') + 1).toLowerCase();
  switch (ext) {
    case 'md':
    case 'markdown':
    case 'txt':
    case 'text':
      return 'md';
    case 'pptx':
    case 'ppt':
      return 'pptx';
    case 'docx':
      return 'docx';
    case 'pdf':
      return 'pdf';
    case 'srt':
      return 'srt';
    case 'vtt':
      return 'vtt';
    case 'jpg':
    case 'jpeg':
    case 'png':
    case 'webp':
    case 'bmp':
    case 'gif':
    case 'tiff':
    case 'tif':
      return 'image';
    default:
      return ext || 'unknown';
  }
}

/**
 * 相对路径解析顺序：绝对路径原样 > workspaceRoot 拼接 > 进程 cwd（MCP 子进程 cwd
 * 常是宿主 profile 目录，与调用方工作区不一致，故 workspaceRoot 优先）。
 */
function resolveMaterialPath(filePath: string, workspaceRoot?: unknown): string {
  if (typeof workspaceRoot === 'string' && workspaceRoot && !isAbsolute(filePath)) {
    return resolvePath(join(workspaceRoot, filePath));
  }
  return filePath;
}

/** parse 文件类错误的统一结构化返回（回显解析后的绝对路径 + 中文引导） */
function fileErrorResult(
  message: string,
): { ok: false; result: SkillResult<ParseCourseMaterialOutput> } {
  return {
    ok: false,
    result: {
      skillId: 'parse_course_material',
      level: 'unavailable',
      degradationNote: message,
      errorCode: 'INVALID_INPUT',
      example: '{ "materialFile": "D:/path/to/课件.md", "workspaceRoot": "D:/path/to" }',
    },
  };
}

/** 解析 materialFile 输入：文件路径读取（二进制走解码链），或已解码 { content, materialType } 透传 */
async function resolveParseInput(
  materialFile: unknown,
  ctx: SkillContext,
  workspaceRoot?: unknown,
  ocr?: boolean,
): Promise<
  | { ok: true; content: string; materialType: string; ocr?: ParseOcrMeta }
  | { ok: false; result: SkillResult<ParseCourseMaterialOutput> }
> {
  if (typeof materialFile === 'string') {
    const resolved = resolveMaterialPath(materialFile, workspaceRoot);
    const materialType = inferMaterialType(resolved);
    // 大文件守卫：二进制材料超 20MB 不进解码链（曾致整个 MCP 服务崩溃、19 技能全挂）
    if (BINARY_MATERIAL_TYPES.has(materialType)) {
      let size: number;
      try {
        size = statSync(resolved).size;
      } catch {
        size = -1;
      }
      if (size > MAX_BINARY_BYTES) {
        return fileErrorResult(
          `文件过大（${(size / 1024 / 1024).toFixed(1)} MB > 20 MB 上限）：${resolved}。` +
          '大体积扫描件请先走异步与分段：① 传 async:true 提交异步作业（manage_async_tasks 轮询）；' +
          '② 用外部工具（如 pdftotext）先抽取文本再传 content；③ 分卷/截图后逐页解析',
        );
      }
    }
    let buf: Buffer;
    try {
      buf = readFileSync(resolved);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return fileErrorResult(
        `读取文件失败（${reason}）。已按以下路径解析：${resolved}` +
        (resolved !== materialFile ? `（原始输入 "${materialFile}"）` : '') +
        '；请使用绝对路径，或传 workspaceRoot 指定工作区根目录（相对路径按 workspaceRoot > 进程 cwd 解析）',
      );
    }
    // zip 魔数（PK\x03\x04 / PK\x05\x06 / PK\x07\x08）：docx/pptx/xlsx 一律走解码链——
    // 高熵 deflate 流可能不足 1% \x00 而被 looksBinary 误判为文本。
    // PDF 同样按扩展名路由：扫描件前 8KB 多为 ASCII 字典/图流，采样判定不可靠（R5-1/R6-2）。
    const isZipSignature =
      buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b && [3, 5, 7].includes(buf[2]);
    const routeAsBinary = isZipSignature || looksBinary(buf) || materialType === 'pdf';
    if (!routeAsBinary) {
      return { ok: true, content: buf.toString('utf8'), materialType };
    }
    const preNotes: string[] = [];
    // R6-2：原生 PDF 文本层优先——有实质文本（>100 字符）直接走文本路径，完全跳过 OCR
    //（PPT/Word 导出的幻灯片 PDF 有真实文本层+背景灰图，OCR 背景图只会产出乱码）
    if (materialType === 'pdf') {
      try {
        const { extractPdfText, PDF_TEXT_SUBSTANTIAL_CHARS } = await import('./decoders/pdfTextExtract.js');
        const r = extractPdfText(new Uint8Array(buf));
        if (r && r.text.trim().length > PDF_TEXT_SUBSTANTIAL_CHARS) {
          return {
            ok: true,
            content: r.text,
            materialType: 'pdf',
            ocr: { engine: 'pdf-text-layer', language: '', pages: r.pages, elapsedMs: 0, auto: false, textLayer: true },
          };
        }
        if (r?.partial) preNotes.push('PDF 文本层部分流未解码（predictor/未知过滤器），已尝试 OCR 通道');
      } catch {
        preNotes.push('PDF 文本层解析异常，已尝试 OCR 通道');
      }
    }
    // 扫描件结构化 OCR（R5-1，反馈 a P0-3/N0）：护栏先行，错误回落既有解码链
    if (materialType === 'pdf' && ocr !== false) {
      const { tryScannedPdfOcr } = await import('./decoders/scannedParse.js');
      const outcome = await tryScannedPdfOcr(new Uint8Array(buf), ocr);
      if (outcome.kind === 'decoded') {
        return { ok: true, content: outcome.content, materialType: 'pdf', ocr: outcome.ocrMeta };
      }
      if (outcome.kind === 'error' && outcome.guard) {
        return fileErrorResult(outcome.message);
      }
      if (outcome.kind === 'error') {
        preNotes.push(`扫描件 OCR：${outcome.message}`);
      }
    }
    // 二进制文档：原生文本抽取（docx/pptx）→ ① 本地 OCR → ② 宿主注入 → ③ 配置解码器
    const { decoded, notes } = await tryDecodeBinary(new Uint8Array(buf), materialType, ctx);
    if (decoded) return { ok: true, ...decoded };
    // 解码链不可用：尽力提取可读文本，结果降级标注（附各通道失败原因）
    const attempted = await parseCourseMaterial(
      { content: bestEffortText(buf), materialType },
      ctx,
    );
    attempted.level = 'degraded';
    attempted.degradationNote =
      '检测到二进制文档，需文档解码引擎；已尽力提取可读文本。' +
      `解码通道尝试：${[...preNotes, ...notes].join('；')}`;
    return { ok: false, result: attempted };
  }
  if (
    typeof materialFile === 'object' &&
    materialFile !== null &&
    'content' in materialFile &&
    typeof (materialFile as { content: unknown }).content === 'string'
  ) {
    const { content, materialType } = materialFile as { content: string; materialType?: string };
    return { ok: true, content, materialType: materialType ?? 'txt' };
  }
  throw new Error('materialFile 必须是文件路径字符串或 { content, materialType } 对象');
}

/** 二进制解码链（供给阶梯，用户决策：本地为默认，宿主/配置为备选）：
 *  ⓪ docx 原生文本  → ① 本地 OCR（PPTX 原生文本优先、纯图片课件逐页 OCR）→
 *  ② ctx.decoder 宿主注入 → ③ 配置的外部解码器。全部失败返回 undefined 并附各通道失败原因。 */
async function tryDecodeBinary(
  data: Uint8Array,
  materialType: string,
  ctx: SkillContext,
): Promise<{ decoded?: { content: string; materialType: string }; notes: string[] }> {
  const notes: string[] = [];
  // 解码缓存：内容哈希命中即返回（键含 materialType/pageRange/解码器版本）
  const { decodeCacheKey, readDecodeCache, writeDecodeCache } = await import('./decoders/cache.js');
  const cacheKey = decodeCacheKey(data, materialType);
  const cached = readDecodeCache(cacheKey);
  if (cached !== undefined) {
    return { decoded: { content: cached, materialType }, notes };
  }
  const finish = (decoded: { content: string; materialType: string }) => {
    writeDecodeCache(cacheKey, decoded.content);
    return { decoded, notes };
  };
  // ⓪ 原生文本抽取：docx 是 zip，直接读 word/document.xml（OCR 对 zip 字节曾打挂进程）
  if (materialType === 'docx') {
    try {
      const { extractDocxText } = await import('./decoders/docxTextExtract.js');
      const text = extractDocxText(data);
      if (text.trim()) return finish({ content: text, materialType });
      notes.push('docx 原生抽取：无文本内容（可能为纯图片文档）');
    } catch (err) {
      notes.push(`docx 原生抽取：${err instanceof Error ? err.message : String(err)}`);
    }
  }
  // ① 本地 OCR（默认推荐：无需 API key）
  try {
    const { createLocalOcrDecoder } = await import('./decoders/localOcrDecoder.js');
    const doc = await createLocalOcrDecoder().decode({ data, materialType });
    return finish(stripPageMarkers(doc.content, doc.materialType));
  } catch (err) {
    notes.push(`本地 OCR：${err instanceof Error ? err.message : String(err)}`);
  }
  // ② 宿主注入
  if (ctx.decoder) {
    try {
      const doc = await ctx.decoder.decode({ data, materialType });
      return finish({ content: doc.content, materialType: doc.materialType });
    } catch (err) {
      notes.push(`宿主解码器：${err instanceof Error ? err.message : String(err)}`);
    }
  }
  // ③ 配置的外部解码器
  try {
    const config = readConfig();
    if (!config) {
      notes.push('配置解码器：未找到 settings.json');
    } else {
      const decoder = createDecoder(config, () => readApiKey());
      const doc = await decoder.decode({ data, materialType });
      return finish({ content: doc.content, materialType: doc.materialType });
    }
  } catch (err) {
    notes.push(`配置解码器：${err instanceof Error ? err.message : String(err)}`);
  }
  return { notes };
}

/** 去掉 OCR 页界标记（=== 第N页 ===），避免混入段落 */
function stripPageMarkers(content: string, materialType: string): { content: string; materialType: string } {
  const cleaned = content
    .split('\n')
    .filter((line) => !/^===\s*第\d+页\s*===$/.test(line.trim()))
    .join('\n');
  return { content: cleaned, materialType };
}

/** 尽力提取可读文本（替换不可打印字节） */
function bestEffortText(buf: Buffer): string {
  return buf.toString('utf8').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]+/g, ' ').trim();
}

// ---------- 输入防御层 ----------

const isObj = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x);

export interface FieldSpec {
  /** 支持点路径，如 structuredContent.paragraphs */
  name: string;
  kind: 'array' | 'object' | 'string' | 'number' | 'any';
  /** 期望形态说明（中文，进错误消息） */
  hint: string;
}

/** 返回 null = 通过；否则返回中文错误说明（含期望形态与下一步引导） */
export function validateInputs(inputs: unknown, specs: FieldSpec[]): string | null {
  if (!isObj(inputs)) return 'inputs 须为 JSON 对象';
  for (const spec of specs) {
    const parts = spec.name.split('.');
    let cur: unknown = inputs;
    for (const part of parts) {
      cur = isObj(cur) ? cur[part] : undefined;
    }
    if (cur === undefined || cur === null) {
      return `缺少必需输入 "${spec.name}"：${spec.hint}`;
    }
    const ok =
      spec.kind === 'any' ? true
      : spec.kind === 'array' ? Array.isArray(cur)
      : spec.kind === 'object' ? isObj(cur)
      : typeof cur === spec.kind;
    if (!ok) return `输入 "${spec.name}" 类型错误：${spec.hint}`;
  }
  return null;
}

/** 契约别名表（单一事实源 = 各 md「输入声明」段 → 注册表 aliases）：别名 → 契约真名 */
const INPUT_ALIASES: ReadonlyMap<string, Readonly<Record<string, string>>> = new Map(
  (registry as { skills: SkillDescriptor[] }).skills.map((s) => [
    s.skillId,
    Object.freeze(s.aliases ?? {}),
  ]),
);

/**
 * 输入归一化（别名改写 + 字符串 JSON.parse）：
 *  - 别名（如 knowledgeGraph/teachingObjectives）在契约真名缺省时改写为真名，旧名继续可用；
 *  - kind 为 object/array 的入参传 JSON 字符串时自动解析（MCP 调用方常整体字符串化）；
 *  - kind 为 array 的入参传单个对象时自动包成数组（fuse 单图幂等）。
 * 返回 parseErrors（非空 = 有字符串解析失败，调用方转 INVALID_INPUT）。
 */
export function normalizeInputs(
  skillId: string,
  inputs: Record<string, unknown>,
  specs: FieldSpec[],
): { inputs: Record<string, unknown>; parseErrors: string[] } {
  const out: Record<string, unknown> = { ...inputs };
  const aliasMap = INPUT_ALIASES.get(skillId) ?? {};
  for (const [alias, canonical] of Object.entries(aliasMap)) {
    if (alias in out && !(canonical in out)) {
      out[canonical] = out[alias];
      delete out[alias];
    }
  }
  const parseErrors: string[] = [];
  // R4-1：extract 的 experimental 模式（章节+字段形态）合成 parse 形 structuredContent，
  // 使统一校验/错误语义一致；rawExecutor 按 graphType 路由到实验图谱构建
  if (skillId === 'extract_knowledge_graph' && out.graphType === 'experimental' && out.structuredContent === undefined) {
    const sections = Array.isArray(out.sections) ? out.sections : [];
    let paraIdx = 0;
    const synthParagraphs: Array<{ index: number; text: string; sectionOrder: number }> = [];
    sections.forEach((s: unknown, i: number) => {
      const sec = s as { title?: string; fields?: Record<string, unknown> };
      for (const [k, v] of Object.entries(sec?.fields ?? {})) {
        const vals = Array.isArray(v) ? v.join('、') : String(v ?? '');
        synthParagraphs.push({ index: paraIdx++, text: `${sec?.title ?? `实验${i + 1}`}：${k}：${vals}`, sectionOrder: i });
      }
    });
    out.structuredContent = {
      structuredSections: sections.map((s: unknown, i: number) => ({
        title: (s as { title?: string })?.title ?? `实验${i + 1}`, level: 1, order: i,
      })),
      paragraphs: synthParagraphs,
      knowledgePointCandidates: [],
    };
  }
  for (const spec of specs) {
    if (spec.kind !== 'object' && spec.kind !== 'array') continue;
    if (spec.name.includes('.')) continue; // 仅顶层入参做字符串解析
    const value = out[spec.name];
    if (typeof value === 'string') {
      try {
        out[spec.name] = JSON.parse(value);
      } catch {
        parseErrors.push(spec.name);
      }
    }
    if (spec.kind === 'array' && isObj(out[spec.name])) {
      out[spec.name] = [out[spec.name]]; // 单图幂等：对象自动包成数组
    }
  }
  return { inputs: out, parseErrors };
}

function invalidResult(
  skillId: string,
  message: string,
  opts: {
    errorCode?: 'INVALID_INPUT' | 'INTERNAL_ERROR';
    requiredInputs?: string[];
    example?: string;
  } = {},
) {
  return {
    skillId,
    level: 'unavailable' as const,
    errorCode: (opts.errorCode ?? 'INVALID_INPUT') as 'INVALID_INPUT' | 'INTERNAL_ERROR',
    degradationNote: `${opts.errorCode === 'INTERNAL_ERROR' ? '内部错误' : '输入校验失败'}：${message}`,
    ...(opts.requiredInputs ? { requiredInputs: opts.requiredInputs } : {}),
    ...(opts.example ? { example: opts.example } : {}),
  };
}

/** 必填入参名（guarded 包装内按 specs 推定） */
function requiredNames(specs: FieldSpec[]): string[] {
  return specs.filter((s) => !s.name.includes('.')).map((s) => s.name);
}

/** 最小入参示例（由 specs 的 hint 拼出引导） */
function exampleFor(specs: FieldSpec[]): string | undefined {
  const first = specs.find((s) => !s.name.includes('.'));
  return first ? `{ "${first.name}": ${first.hint} }` : undefined;
}

/** 支持 async: true 异步提交的技能（长任务不受宿主 toolCallTimeoutMs 限制） */
const ASYNC_CAPABLE = new Set([
  'parse_course_material',
  'extract_knowledge_graph',
  'fuse_knowledge_graphs',
  'translate_multilingual',
]);

/** 包装执行器：归一化（别名/字符串解析）→ 类型校验 → （async 模式提交作业）/ 同步执行；异常转为结构化错误结果 */
function guarded(
  skillId: string,
  specs: FieldSpec[],
  fn: (inputs: Record<string, unknown>, ctx: SkillContext) => Promise<unknown>,
) {
  return async (inputs: Record<string, unknown>, ctx: SkillContext, opts?: { onProgress?: (d: number, t: number, m: string) => void }) => {
    const normalized = normalizeInputs(skillId, inputs, specs);
    if (normalized.parseErrors.length > 0) {
      const name = normalized.parseErrors[0];
      const spec = specs.find((s) => s.name === name);
      return invalidResult(
        skillId,
        `输入 "${name}" 是 JSON 字符串但解析失败；期望形态：${spec?.hint ?? '合法 JSON'}`,
        { requiredInputs: requiredNames(specs), example: exampleFor(specs) },
      );
    }
    inputs = normalized.inputs;
    if (inputs.async === true && !ASYNC_CAPABLE.has(skillId)) {
      return invalidResult(skillId, `技能 ${skillId} 不支持 async 模式；支持：${[...ASYNC_CAPABLE].join('、')}`);
    }
    const err = validateInputs(inputs, specs);
    if (err) {
      return invalidResult(skillId, err, { requiredInputs: requiredNames(specs), example: exampleFor(specs) });
    }
    if (inputs.async === true) {
      const jobInputs = { ...inputs };
      delete jobInputs.async;
      const onProgress = (done: number, total: number, message: string) => {
        opts?.onProgress?.(done, total, message);
        process.stderr.write(`[nangying-starmap] ${message}\n`);
      };
      const { submitJob } = await import('./jobQueue.js');
      const job = submitJob(
        ({ signal, reportProgress }) =>
          fn(jobInputs, {
            ...ctx,
            llmBatch: {
              ...ctx.llmBatch,
              budgetMs: Number.MAX_SAFE_INTEGER, // 异步模式不受同步预算限制
              signal,
              onProgress: (d, t, m) => {
                reportProgress(d, t, m);
                onProgress(d, t, m);
              },
            },
          }),
        { skill: skillId, label: typeof jobInputs.materialFile === 'string' ? String(jobInputs.materialFile) : undefined },
      );
      return {
        skillId,
        level: 'full',
        data: {
          jobId: job.jobId,
          status: job.status,
          message: '异步任务已提交（毫秒级返回）；用 manage_async_tasks 的 query 轮询结果',
        },
        degradationNote: '',
      };
    }
    try {
      const t0 = Date.now();
      const out = await fn(inputs, ctx);
      // 长任务软阈值（R5-2.3）：同步模式 >30s 显著提示改异步
      const elapsed = Date.now() - t0;
      if (elapsed > 30_000 && isObj(out) && typeof out.level === 'string') {
        const hint = `本次同步执行耗时 ${(elapsed / 60000).toFixed(1)} 分钟：长任务建议加 async:true 提交异步作业（manage_async_tasks 轮询，不受宿主超时限制）`;
        out.degradationNote = out.degradationNote ? `${out.degradationNote}；${hint}` : hint;
      }
      // core 层自检返回的 unavailable（如 diff 的「须为星图中枢 schema」）统一补错误码
      if (isObj(out) && out.level === 'unavailable' && out.errorCode === undefined) {
        return { ...out, errorCode: 'INVALID_INPUT' as const };
      }
      return out;
    } catch (e) {
      const stack = e instanceof Error ? (e.stack ?? '').split('\n').slice(0, 3).join(' | ') : '';
      return invalidResult(
        skillId,
        `执行异常：${e instanceof Error ? e.message : String(e)}${stack ? `（${stack}）` : ''}。` +
        '请核对输入形态（describe_capabilities 可查真实入参与别名）后重试',
        { errorCode: 'INTERNAL_ERROR', requiredInputs: requiredNames(specs), example: exampleFor(specs) },
      );
    }
  };
}

const PARSE_OUTPUT_HINT =
  '须为 parse_course_material 的完整输出（含 structuredSections/paragraphs/knowledgePointCandidates 数组）；请先调用 parse_course_material 并将其输出整体传入';

const rawExecutors: Record<
  ImplementedSkillId,
  (inputs: Record<string, unknown>, ctx: SkillContext) => Promise<unknown>
> = {
  parse_course_material: async (inputs, ctx) => {
    const t0 = Date.now();
    const ocrInput = (inputs as { ocr?: unknown }).ocr;
    const ocr = ocrInput === true ? true : ocrInput === false ? false : undefined;
    const resolved = await resolveParseInput(inputs.materialFile, ctx, inputs.workspaceRoot, ocr);
    if (!resolved.ok) return resolved.result;
    const { content, materialType } = resolved;
    const { options } = inputs as { options?: { extraStoplist?: string[]; llmFilter?: 'auto' | 'off'; normalize?: boolean; language?: string; glossary?: string[] } };
    const result = await parseCourseMaterial(
      {
        content,
        materialType,
        ...(options || resolved.ocr
          ? {
              options: {
                ...(options ?? {}),
                // 仅 OCR 路径标注来源；原生文本层是真实文本，不标 ocr
                ...(resolved.ocr && !resolved.ocr.textLayer ? { annotateSource: 'ocr' } : {}),
              },
            }
          : {}),
      },
      ctx,
    );
    // R5-1/R6-2：OCR/文本层 meta + 自动探测标注
    if (resolved.ocr && result.data) {
      result.data.meta = { ocr: resolved.ocr };
      if (resolved.ocr.textLayer) {
        result.degradationNote = `${result.degradationNote ? result.degradationNote + '；' : ''}textLayer:true（检测到实质文本层，已跳过 OCR 直接抽取）`;
      } else if (resolved.ocr.auto) {
        result.degradationNote = `${result.degradationNote ? result.degradationNote + '；' : ''}ocrAuto:true（探测到扫描件特征，已自动走 OCR 路径）`;
      }
    }
    // 长耗时提示：>5s 建议 async
    const elapsed = Date.now() - t0;
    if (!inputs.async && elapsed > 5000) {
      result.degradationNote = `${result.degradationNote ? result.degradationNote + '；' : ''}本次解析耗时 ${(elapsed / 1000).toFixed(1)}s：大材料建议加 async:true 提交异步作业（manage_async_tasks 轮询，不受宿主超时限制）`;
    }
    return result;
  },
  extract_knowledge_graph: async (inputs, ctx) => {
    const { structuredContent, options, graphType, sections, fieldMap, outputFormat } = inputs as {
      structuredContent: never;
      options?: { cooccurrenceThreshold?: number; candidateLimit?: number; semanticClustering?: boolean };
      graphType?: 'conceptual' | 'experimental';
      sections?: unknown[];
      fieldMap?: Record<string, string>;
      outputFormat?: 'json' | 'mermaid' | 'graphml' | 'csv' | 'jsonld';
    };
    // R4-1：graphType=experimental 走实验型图谱（章节+字段形态）
    if (graphType === 'experimental') {
      const { extractExperimentalGraph } = await import('../../core/graph/extractExperimentalGraph.js');
      return extractExperimentalGraph({ sections: sections as never, fieldMap }, ctx);
    }
    const result = await extractKnowledgeGraph(structuredContent, ctx, options ?? {});
    // R5-3：图谱导出格式（mermaid/graphml/csv/jsonld；json 为默认原样）
    if (outputFormat && outputFormat !== 'json' && result.data) {
      const { exportGraph } = await import('../../core/graph/graphExport.js');
      result.data.output = exportGraph(result.data, outputFormat) ?? undefined;
      result.data.format = outputFormat;
    }
    return result;
  },
  fuse_knowledge_graphs: async (inputs, ctx) => {
    const { graphs, sources, pools, options } = inputs as {
      graphs: never[];
      sources: Array<{ id: string; weight?: number }>;
      pools?: Array<Array<{ term: string; score?: number; occurrences?: number[] }>>;
      options?: { cooccurrenceThreshold?: number; semanticClustering?: boolean };
    };
    return fuseKnowledgeGraphs({ graphs, sources, pools }, ctx, options ?? {});
  },
  diff_knowledge_graphs: async (inputs, ctx) => {
    return diffKnowledgeGraphs(
      inputs as { graphA: never; graphB: never; labelA?: string; labelB?: string },
      ctx,
    );
  },
  design_course_structure: async (inputs, ctx) => {
    return designCourseStructure(inputs as { graph: never; objectives: never }, ctx);
  },
  generate_teaching_script: async (inputs, ctx) => {
    return generateTeachingScript(inputs as { structure: never; style?: never }, ctx);
  },
  translate_multilingual: async (inputs, ctx) => {
    const { targetLanguages, glossary } = inputs as {
      targetLanguages: string[];
      glossary?: Glossary | string;
    };
    const parsedGlossary =
      typeof glossary === 'string' ? importGlossary(glossary) : glossary;
    if ('script' in inputs) {
      return translateMultilingual(
        {
          script: inputs.script as never,
          targetLanguages: targetLanguages ?? [],
          ...(parsedGlossary ? { glossary: parsedGlossary } : {}),
        },
        ctx,
      );
    }
    return translateMultilingual(
      {
        paragraphs: (inputs.paragraphs as string[]) ?? [],
        targetLanguages: targetLanguages ?? [],
        ...(parsedGlossary ? { glossary: parsedGlossary } : {}),
      },
      ctx,
    );
  },
  build_qa_knowledge_base: async (inputs, ctx) => {
    return buildQaKnowledgeBase(
      inputs as { graph: never; paragraphs: never },
      ctx,
    );
  },
  recommend_learning_path: async (inputs, ctx) => {
    return recommendLearningPath(
      inputs as { graph: never; profile: never },
      ctx,
    );
  },
  generate_personalized_feedback: async (inputs, ctx) => {
    return generatePersonalizedFeedback(inputs as never, ctx);
  },
  manage_course_assets: async (inputs) => {
    const { store, storeJson, storePath: explicitStorePath } = inputs as {
      store?: AssetStore;
      storeJson?: string;
      storePath?: string;
    };
    // 默认落盘（register→list 跨调用不丢）：未给任何存储参数时持久化到本机登记簿
    // （configStore 路径约定：NANGYING_CONFIG_DIR 优先，否则 ~/.nangying-starmap/assets.json）
    const storePath = explicitStorePath ?? join(configDir(), 'assets.json');
    const explicit = store !== undefined || typeof storeJson === 'string';
    const base = explicit
      ? (store ?? deserializeStore(storeJson as string))
      : loadAssetStore(storePath);

    // 别名 assetOperations 的数组形态兼容：单元素自动解包，多元素顺序执行（中途失败即停）
    const rawOp = inputs.operation as AssetOp | AssetOp[];
    const ops: Array<AssetOp | { op: 'export' }> = Array.isArray(rawOp) ? rawOp : [rawOp];

    let current = base;
    let lastOutput: { result?: unknown } | undefined;
    const opNotes: string[] = [];
    for (const op of ops) {
      if (op.op === 'export') {
        saveAssetStore(current, storePath);
        opNotes.push(`export → ${storePath}`);
        continue;
      }
      const result = await manageCourseAssets({ operation: op, store: current });
      if (result.level !== 'full') {
        return {
          ...result,
          errorCode: 'INVALID_INPUT' as const,
          example: '{ "operation": { "op": "register", "asset": { "id": "a1", "type": "graph", "title": "课程图谱", "dependencies": [] } } }',
        };
      }
      current = result.data!.store;
      lastOutput = result.data!;
      opNotes.push(op.op);
    }

    // 变更类操作（含 export）成功后持久化；list/checkout 只读不落盘
    const mutating = ops.some((o) =>
      o.op === 'register' || o.op === 'update' || o.op === 'remove' ||
      o.op === 'tagDependency' || o.op === 'export');
    if (mutating) saveAssetStore(current, storePath);

    const exported = ops.some((o) => o.op === 'export');
    return {
      skillId: 'manage_course_assets',
      level: 'full',
      data: {
        store: current,
        result: exported && ops.length === 1
          ? ({ exportedTo: storePath } as never)
          : (lastOutput?.result as never),
        assetRegistry: current.assets,
        versionHistory: current.history,
        metadataRecords: current.history.map((h) => h.metadata),
        persisted: mutating,
        storePath,
        operations: opNotes,
      },
      degradationNote: '',
    };
  },
  export_course_package: async (inputs) => {
    const { outZip, outDir, outDocx, outPptx, outPdf, outXlsx, fontPath, outputPath, options: expOptions, tables, linkReport, handoutTables, ...rest } = inputs as {
      outZip?: string;
      outDir?: string;
      outDocx?: string;
      outPptx?: string;
      outPdf?: string;
      outXlsx?: string;
      fontPath?: string;
      outputPath?: string;
      tables?: Array<{ name?: string; header: string[]; rows: string[][] }>;
      linkReport?: { matched?: Array<Record<string, unknown>>; gaps?: Array<Record<string, unknown>>; coverage?: Array<Record<string, unknown>> };
      handoutTables?: Array<{ title?: string; rows: Array<Array<string | { text: string; colSpan?: number; rowSpan?: number; align?: 'left' | 'center' }>> }>;
      options?: { formats?: string[]; [k: string]: unknown };
      [k: string]: unknown;
    };
    // R7-3：handout-pdf / R10-1：xlsx 由适配层消费（真实字节，不进文本包模型）
    const wantsPdf = (expOptions?.formats ?? []).includes('handout-pdf');
    const wantsXlsx = (expOptions?.formats ?? []).includes('xlsx');
    const coreOptions = wantsPdf || wantsXlsx
      ? { ...expOptions, formats: expOptions!.formats!.filter((f) => f !== 'handout-pdf' && f !== 'xlsx') as never }
      : expOptions;
    const result = await exportCoursePackage({
      ...rest,
      ...(handoutTables ? { handoutTables } : {}),
      ...(coreOptions ? { options: coreOptions } : {}),
    } as never);
    // 压缩/落盘归适配层：给了 outZip/outDir 时写出真实产物
    if (result.data) {
      if (outZip) writePackageZip(result.data.package, outZip);
      if (outDir) writePackageDir(result.data.package, outDir);
      // OOXML 部件组装为真实 docx/pptx（stored zip，确定性字节）
      const writePartsZip = (prefix: string, outPath: string) => {
        const parts = result.data!.package.files
          .filter((f) => f.path.startsWith(prefix))
          .map((f) => ({ path: f.path.slice(prefix.length), content: f.content }));
        if (parts.length === 0) {
          throw new Error(`包内没有 ${prefix} 部件：请在 options.formats 中包含 ${prefix === 'handout/' ? "'handout-docx'" : "'slides-pptx'"}`);
        }
        writePackageZip({
          manifest: { packageName: prefix.replace(/\//g, ''), title: prefix.replace(/\//g, ''), formats: [], fileCount: parts.length, generatedBy: 'nangying-starmap' },
          files: parts,
        }, outPath);
      };
      if (outDocx) writePartsZip('handout/', outDocx);
      if (outPptx) writePartsZip('slides/', outPptx);
      // R7-3：handout-pdf 真实 PDF 写出（嵌入中文字体；无字体诚实降级为拉丁 PDF + degraded）
      if (wantsPdf) {
        const { buildPdf, parseTrueTypeFont } = await import('../../core/course/pdfRender.js');
        const script = (rest as {
          script: {
            storyboardScript: Array<{
              title: string;
              scenes: Array<{ phase: string; voiceover: string; minutes: number }>;
            }>;
          };
        }).script;
        const blocks = script.storyboardScript.flatMap((lesson) => [
          { kind: 'h2' as const, text: lesson.title },
          ...lesson.scenes.map((s) => ({
            kind: 'p' as const,
            text: `${s.phase}（${s.minutes}分钟）：${s.voiceover}`,
          })),
        ]);
        const title = result.data.package.manifest.title;
        let font: import('../../core/course/pdfRender.js').EmbeddedFont | null = null;
        const candidates = [
          fontPath,
          'C:\\Windows\\Fonts\\msyh.ttc',
          'C:\\Windows\\Fonts\\simsun.ttc',
          'C:\\Windows\\Fonts\\simhei.ttf',
          '/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc',
          '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
          '/System/Library/Fonts/PingFang.ttc',
        ].filter((x): x is string => typeof x === 'string');
        for (const p of candidates) {
          try {
            const parsed = parseTrueTypeFont(new Uint8Array(readFileSync(p)));
            if (parsed) { font = parsed; break; }
          } catch { /* 尝试下一个路径 */ }
        }
        const built = buildPdf({ title, blocks, font });
        const pdfTargets: string[] = [];
        if (outPdf) pdfTargets.push(outPdf);
        if (outputPath) pdfTargets.push(join(resolvePath(outputPath), 'handout.pdf'));
        for (const target of pdfTargets) {
          mkdirSync(dirname(target), { recursive: true });
          writeFileSync(target, Buffer.from(built.bytes));
          result.data.writtenFiles = result.data.writtenFiles ?? [];
          result.data.writtenFiles.push(resolvePath(target));
        }
        if (!built.embeddedFont) {
          result.level = 'degraded';
          const note = built.replacedChars > 0
            ? `未找到中文字体（fontPath 未给且系统探测失败）：已产出仅英文/数字可用的 PDF（${built.replacedChars} 个非拉丁字符以 ? 代替）；中文试卷请用 handout-docx 或传 fontPath 指向 .ttf/.otf/.ttc`
            : '未找到中文字体：已产出仅英文/数字可用的 PDF；如需中文请传 fontPath 或用 handout-docx';
          result.degradationNote = result.degradationNote ? `${result.degradationNote}；${note}` : note;
        }
      }
      // R10-1：xlsx 真实写出（零依赖 zip；linkReport 缺省用 tables，两者皆无抛结构化错误）
      if (wantsXlsx) {
        const { buildXlsx, linkReportToTables } = await import('../../core/course/xlsxRender.js');
        const xlsxTables = linkReport ? linkReportToTables(linkReport) : tables;
        if (!xlsxTables || xlsxTables.length === 0) {
          throw new Error(JSON.stringify({
            error: 'EXPORT_XLSX_NO_TABLES',
            message: "formats 含 'xlsx' 时需要 tables（通用表格数组）或 linkReport（产教分析包输出）输入",
          }));
        }
        const built = buildXlsx(xlsxTables);
        const xlsxTargets: string[] = [];
        if (outXlsx) xlsxTargets.push(outXlsx);
        if (outputPath) xlsxTargets.push(join(resolvePath(outputPath), 'tables.xlsx'));
        if (xlsxTargets.length === 0) {
          throw new Error(JSON.stringify({
            error: 'EXPORT_XLSX_NO_TARGET',
            message: "formats 含 'xlsx' 时需要 outXlsx 或 outputPath 指定写出位置",
          }));
        }
        for (const target of xlsxTargets) {
          mkdirSync(dirname(target), { recursive: true });
          writeFileSync(target, Buffer.from(built.bytes));
          result.data.writtenFiles = result.data.writtenFiles ?? [];
          result.data.writtenFiles.push(resolvePath(target));
        }
      }
      // R5-5.1：outputPath 落盘（整包 + 组装件），报告绝对路径
      if (outputPath) {
        const absDir = resolvePath(outputPath);
        writePackageDir(result.data.package, absDir);
        const written: string[] = result.data.package.files.map((f) => resolvePath(join(absDir, f.path)));
        if (result.data.package.files.some((f) => f.path.startsWith('handout/'))) {
          const p = join(absDir, 'handout.docx');
          writePartsZip('handout/', p);
          written.push(resolvePath(p));
        }
        if (result.data.package.files.some((f) => f.path.startsWith('slides/'))) {
          const p = join(absDir, 'slides.pptx');
          writePartsZip('slides/', p);
          written.push(resolvePath(p));
        }
        result.data.writtenFiles = [...(result.data.writtenFiles ?? []), ...written];
        result.degradationNote = result.degradationNote || '';
      }
    }
    return result;
  },
  register_teacher_avatar: async (inputs) => {
    return registerTeacherAvatar(inputs as never);
  },
  synthesize_speech: async (inputs) => {
    return synthesizeSpeech(inputs as never);
  },
  generate_digital_human_video: async (inputs) => {
    return generateDigitalHumanVideo(inputs as never);
  },
  orchestrate_multi_teacher: async (inputs) => {
    return orchestrateMultiTeacher(inputs as never);
  },
  match_teaching_scene: async (inputs) => {
    return matchTeachingScene(inputs as never);
  },
  sync_multilingual_av: async (inputs) => {
    return syncMultilingualAv(inputs as never);
  },
  realtime_qa_stream: async (inputs) => {
    return realtimeQaStream(inputs as never);
  },
  manage_async_tasks: async (inputs) => {
    const { operation, jobId, olderThanHours } = inputs as { operation: string; jobId?: string; olderThanHours?: number };
    if (operation === 'list') {
      return {
        skillId: 'manage_async_tasks',
        level: 'full',
        data: { jobs: listJobs() },
        degradationNote: '',
      };
    }
    if (operation === 'cleanup' || operation === 'gc') {
      const hours = typeof olderThanHours === 'number' && olderThanHours > 0 ? olderThanHours : 24;
      const { removed, remaining } = cleanupJobs(hours);
      return {
        skillId: 'manage_async_tasks',
        level: 'full',
        data: { removed, remaining, olderThanHours: hours },
        degradationNote: '',
      };
    }
    if (!jobId) {
      return { skillId: 'manage_async_tasks', level: 'unavailable', degradationNote: `operation "${operation}" 需要 jobId 参数` };
    }
    if (operation === 'query') {
      const job = getJob(jobId);
      return job
        ? { skillId: 'manage_async_tasks', level: 'full', data: { job }, degradationNote: '' }
        : { skillId: 'manage_async_tasks', level: 'unavailable', errorCode: 'INVALID_INPUT' as const, degradationNote: `作业 ${jobId} 不存在（完成结果保留 24 小时，超时已清理）` };
    }
    if (operation === 'cancel') {
      const job = cancelJob(jobId);
      return job
        ? { skillId: 'manage_async_tasks', level: 'full', data: { job }, degradationNote: job.status === 'cancelled' ? '' : '作业已终态或已中断，无需取消' }
        : { skillId: 'manage_async_tasks', level: 'unavailable', errorCode: 'INVALID_INPUT' as const, degradationNote: `作业 ${jobId} 不存在` };
    }
    return { skillId: 'manage_async_tasks', level: 'unavailable', errorCode: 'INVALID_INPUT' as const, degradationNote: `未知 operation：${operation}（可选 query/list/cancel/cleanup）` };
  },
  generate_assessment: async (inputs, ctx) => {
    const { graph, count, difficulty, bloomLevels, includeExplanations, commonErrors } = inputs as {
      graph: never;
      count?: number;
      difficulty?: 'easy' | 'medium' | 'hard' | 'mixed';
      bloomLevels?: string[];
      includeExplanations?: boolean;
      commonErrors?: boolean;
    };
    return generateAssessment(
      {
        graph,
        ...(count !== undefined ? { count } : {}),
        ...(difficulty ? { difficulty } : {}),
        ...(bloomLevels ? { bloomLevels: bloomLevels as never } : {}),
        ...(includeExplanations !== undefined ? { includeExplanations } : {}),
        ...(commonErrors !== undefined ? { commonErrors } : {}),
      },
      ctx,
    );
  },
  audit_consistency: async (inputs, ctx) => {
    const { assets } = inputs as {
      assets: Array<{ id: string; title?: string; text?: string; path?: string }>;
    };
    // path → text 读取归适配层（core 零 Node API）；ENOENT 结构化报错
    const resolved = (assets ?? []).map((a) => {
      if (typeof a?.text === 'string' && a.text) return { id: a.id, title: a.title, text: a.text };
      if (typeof a?.path === 'string' && a.path) {
        try {
          return { id: a.id, title: a.title, text: readFileSync(a.path, 'utf8') };
        } catch (err) {
          throw new Error(`资产 ${a.id} 的文件读取失败：${err instanceof Error ? err.message : String(err)}（path=${a.path}）`);
        }
      }
      return { id: a?.id, title: a?.title, text: '' };
    });
    return auditConsistency({ assets: resolved as never }, ctx);
  },
  polish_teaching_text: async (inputs, ctx) => {
    return polishTeachingText(inputs as never, ctx);
  },
  sync_bilingual: async (inputs, ctx) => {
    return syncBilingual(inputs as never, ctx);
  },
  qa_media: async (inputs) => {
    // R7-4：媒体验收门禁——引擎门控（ffmpeg），字幕静态检查永远可用
    const { mediaFile, subtitles, checks } = inputs as {
      mediaFile?: string;
      subtitles?: string;
      checks?: { keyframes?: boolean; silence?: boolean; subtitles?: boolean };
    };
    const wantSub = checks?.subtitles !== false;
    const wantKeyframes = checks?.keyframes !== false;
    const wantSilence = checks?.silence !== false;
    const subFindings = wantSub && typeof subtitles === 'string' && subtitles.trim()
      ? auditSubtitleTimeline(parseSrt(subtitles))
      : [];
    const cueCount = wantSub && typeof subtitles === 'string' ? parseSrt(subtitles).length : undefined;

    const { probeFfmpegAvailable, ffprobeMeta, detectSilence, sceneKeyframes } = await import('./mediaProbe.js');
    const hasEngine = await probeFfmpegAvailable();

    if (!hasEngine) {
      const hint = '安装 ffmpeg 并加入 PATH（https://ffmpeg.org/download.html 或 winget install ffmpeg）';
      if (!mediaFile) {
        return {
          skillId: 'qa_media',
          level: 'unavailable',
          errorCode: 'INVALID_INPUT',
          degradationNote: `未检测到 ffmpeg/ffprobe，且未提供字幕：无法执行媒体验收。${hint}`,
          example: '{ "mediaFile": "D:/课程/成品.mp4", "subtitles": "<SRT 文本>" }',
        };
      }
      const report = finalizeReport({ engine: 'none' as const, findings: subFindings, cueCount });
      return {
        ...report,
        skillId: 'qa_media',
        level: 'degraded' as const,
        degradationNote: `未检测到 ffmpeg/ffprobe：仅完成字幕时间轴静态检查（引擎检查已跳过）。${hint}`,
      };
    }

    // 引擎可用：元数据 + 静音 + 场景切换（R11-2：阈值自适应复扫）
    let meta = null;
    let silences: Array<[number, number]> | null = null;
    let sceneScan: import('../../core/qa/mediaAudit.js').SceneScanInfo | null = null;
    let keyframes: number[] | null = null;
    if (mediaFile) {
      try {
        meta = await ffprobeMeta(mediaFile);
      } catch { /* 元数据失败不阻塞其余检查 */ }
      if (wantSilence) silences = await detectSilence(mediaFile);
      if (wantKeyframes) {
        const scan = await sceneKeyframes(mediaFile);
        if (scan) {
          sceneScan = { thresholdUsed: scan.thresholdUsed, rescanned: scan.rescanned };
          keyframes = scan.timestampsMs;
        }
      }
    }
    const findings = mergeEngineFindings(
      subFindings,
      meta ?? undefined,
      keyframes ?? undefined,
      silences ?? undefined,
      meta?.durationMs,
      sceneScan ?? undefined,
    );
    return {
      skillId: 'qa_media',
      level: 'full' as const,
      data: finalizeReport({
        engine: 'ffmpeg',
        findings,
        video: meta ?? undefined,
        keyframeTimestampsMs: keyframes ?? undefined,
        sceneScan: sceneScan ?? undefined,
        silenceSegmentsMs: silences ?? undefined,
        cueCount,
      }),
      degradationNote: '',
    };
  },
  render_preview: async (inputs) => {
    // R8-1：结构化版面预览——路径读取归适配层
    const { file, detailLevel } = inputs as {
      file: string | { content: string; materialType?: string };
      detailLevel?: 'summary' | 'outline' | 'full';
    };
    const { renderPreviewBytes } = await import('./renderPreview.js');
    if (typeof file === 'string') {
      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(readFileSync(file));
      } catch (err) {
        return {
          skillId: 'render_preview',
          level: 'unavailable' as const,
          errorCode: 'INVALID_INPUT' as const,
          degradationNote: `文件读取失败：${err instanceof Error ? err.message : String(err)}；file 须为 docx/pptx/xlsx/pdf 路径`,
          example: '{ "file": "D:/课程/教案.docx", "detailLevel": "outline" }',
        };
      }
      const claimedExt = file.slice(file.lastIndexOf('.') + 1).toLowerCase();
      const extMap: Record<string, 'docx' | 'pptx' | 'xlsx' | 'pdf'> = {
        docx: 'docx', pptx: 'pptx', ppt: 'pptx', xlsx: 'xlsx', pdf: 'pdf',
      };
      const report = renderPreviewBytes(bytes, {
        detailLevel,
        claimed: { type: extMap[claimedExt] ?? 'unknown', claimed: claimedExt },
      });
      if (report.fileType === 'unknown') {
        return {
          skillId: 'render_preview',
          level: 'unavailable' as const,
          errorCode: 'INVALID_INPUT' as const,
          degradationNote: '无法识别的文件类型（既不是 zip 系的 docx/pptx/xlsx，也不是 %PDF）；支持 docx/pptx/xlsx/pdf',
        };
      }
      return {
        skillId: 'render_preview',
        level: report.contentMismatch ? 'degraded' as const : 'full' as const,
        data: report,
        degradationNote: report.contentMismatch
          ? `扩展名与内容不符：文件声明 .${report.claimedType}，实际为 ${report.fileType}——请核对文件来源（"文件与扩展名不符"高风险）`
          : '',
      };
    }
    if (file && typeof file === 'object' && typeof file.content === 'string') {
      const bytes = new Uint8Array(Buffer.from(file.content, 'utf8'));
      const report = renderPreviewBytes(bytes, {
        detailLevel,
        claimed: { type: 'unknown', claimed: file.materialType ?? 'unknown' },
      });
      if (report.fileType === 'unknown') {
        return {
          skillId: 'render_preview',
          level: 'unavailable' as const,
          errorCode: 'INVALID_INPUT' as const,
          degradationNote: '已解码内容无法识别为 docx/pptx/xlsx/pdf（需二进制内容；文本材料请用 parse_course_material）',
        };
      }
      return { skillId: 'render_preview', level: 'full' as const, data: report, degradationNote: '' };
    }
    return {
      skillId: 'render_preview',
      level: 'unavailable' as const,
      errorCode: 'INVALID_INPUT' as const,
      degradationNote: '输入校验失败：file 须为文件路径字符串或 { content, materialType } 对象',
      example: '{ "file": "D:/课程/教案.docx", "detailLevel": "outline" }',
    };
  },
  build_industry_graph: async (inputs, ctx) => {
    return buildIndustryGraph(inputs as never, ctx);
  },
  link_knowledge_industry: async (inputs, ctx) => {
    return linkKnowledgeIndustry(inputs as never, ctx);
  },
  // 能力自述：从注册表（gen-registry 生成，契约单一事实源的投影）输出真实入参契约
  describe_capabilities: async (inputs) => {
    const { skillId } = inputs as { skillId?: string };
    const all = (registry as { skills: SkillDescriptor[] }).skills;
    const picked = skillId ? all.filter((s) => s.skillId === skillId) : all;
    if (skillId && picked.length === 0) {
      return {
        skillId: 'describe_capabilities',
        level: 'unavailable',
        errorCode: 'INVALID_INPUT' as const,
        degradationNote: `技能 ${skillId} 不存在；可用技能（${all.length} 个）：${all.map((s) => s.skillId).join('、')}`,
        example: '{ "skillId": "manage_course_assets" }',
      };
    }
    // R5-4：引擎状态三分（builtin / optional-not-installed / not-provided），真实探测
    const { engineInfoOf } = await import('./engineStatus.js');
    const skills = await Promise.all(picked.map(async (s) => {
      const engine = await engineInfoOf(s.skillId, s.degradation);
      return {
        skillId: s.skillId,
        name: s.name,
        type: s.type,
        description: s.description,
        usage: s.usage ?? '',
        degradation: s.degradation,
        required: s.required ?? [],
        ...(engine ? { engine } : {}),
        inputs: (s.inputSpecs ?? []).map((i) => ({
          name: i.name,
          kind: i.kind,
          required: i.required,
          ...(i.aliases && i.aliases.length > 0 ? { aliases: i.aliases } : {}),
          ...(i.hint ? { hint: i.hint } : {}),
          ...(i.producer && i.producer.length > 0 ? { producer: i.producer } : {}),
        })),
      };
    }));
    return {
      skillId: 'describe_capabilities',
      level: 'full',
      data: { count: skills.length, skills },
      degradationNote: '',
    };
  },
};

// 输入防御包装：全部技能经 guarded 校验（缺失/类型错返回结构化中文错误，含期望形态与下一步引导）
const executors: Record<
  ImplementedSkillId,
  (inputs: Record<string, unknown>, ctx: SkillContext, opts?: { onProgress?: (done: number, total: number, message: string) => void }) => Promise<unknown>
> = {
  parse_course_material: guarded('parse_course_material', [
    { name: 'materialFile', kind: 'any', hint: '文件路径字符串（相对路径按 workspaceRoot > 进程 cwd 解析），或已解码对象 { content, materialType }；如 { "materialFile": "课件.pptx" }' },
  ], rawExecutors.parse_course_material),
  extract_knowledge_graph: guarded('extract_knowledge_graph', [
    { name: 'structuredContent', kind: 'object', hint: PARSE_OUTPUT_HINT },
    { name: 'structuredContent.paragraphs', kind: 'array', hint: PARSE_OUTPUT_HINT },
    { name: 'structuredContent.knowledgePointCandidates', kind: 'array', hint: PARSE_OUTPUT_HINT },
    { name: 'structuredContent.structuredSections', kind: 'array', hint: PARSE_OUTPUT_HINT },
  ], rawExecutors.extract_knowledge_graph),
  fuse_knowledge_graphs: guarded('fuse_knowledge_graphs', [
    { name: 'graphs', kind: 'array', hint: 'CourseKnowledgeGraph 数组（各单元 extract_knowledge_graph 的输出）；多材料融合请先逐材料 parse→extract' },
    { name: 'sources', kind: 'array', hint: '来源描述数组，与 graphs 等长：[{ id, weight? }]' },
  ], rawExecutors.fuse_knowledge_graphs),
  diff_knowledge_graphs: guarded('diff_knowledge_graphs', [
    { name: 'graphA', kind: 'object', hint: '星图中枢 schema 图谱对象（快照或 extract 输出）' },
    { name: 'graphB', kind: 'object', hint: '星图中枢 schema 图谱对象' },
  ], rawExecutors.diff_knowledge_graphs),
  design_course_structure: guarded('design_course_structure', [
    { name: 'graph', kind: 'object', hint: 'fuse_knowledge_graphs 或 extract_knowledge_graph 的输出' },
    { name: 'objectives', kind: 'object', hint: '教学目标对象，如 { audience: "本科生", totalMinutes: 90 }' },
  ], rawExecutors.design_course_structure),
  generate_teaching_script: guarded('generate_teaching_script', [
    { name: 'structure', kind: 'object', hint: 'design_course_structure 的输出（teachingStructure）' },
  ], rawExecutors.generate_teaching_script),
  translate_multilingual: guarded('translate_multilingual', [
    { name: 'targetLanguages', kind: 'array', hint: '目标语种数组，如 ["zh","en"]；正文走 script（TeachingScript）或 paragraphs 字段' },
  ], rawExecutors.translate_multilingual),
  build_qa_knowledge_base: guarded('build_qa_knowledge_base', [
    { name: 'graph', kind: 'object', hint: 'extract_knowledge_graph 的输出' },
    { name: 'paragraphs', kind: 'array', hint: 'parse_course_material 输出的 paragraphs 数组' },
  ], rawExecutors.build_qa_knowledge_base),
  recommend_learning_path: guarded('recommend_learning_path', [
    { name: 'graph', kind: 'object', hint: 'extract/fuse 的输出（含 prerequisiteGraph）' },
    { name: 'profile', kind: 'object', hint: '学习者画像，如 { knownConceptIds, goalConceptIds, availableMinutes }' },
  ], rawExecutors.recommend_learning_path),
  // R5-5.3：quiz 与 freeTextReport 二选一（可并存），core 守卫结构化报错——规格留空避免误拒 freeText 模式
  generate_personalized_feedback: guarded('generate_personalized_feedback', [], rawExecutors.generate_personalized_feedback),
  // R5-5.3：operation 与 assetOperations 数组形态兼容（单元素解包/多元素顺序执行）
  manage_course_assets: guarded('manage_course_assets', [
    { name: 'operation', kind: 'any', hint: '资产操作指令（对象），或别名 assetOperations 的数组形态（单元素解包/多元素顺序执行）；如 { op: "register", asset: { id, type, title, dependencies } }' },
  ], rawExecutors.manage_course_assets),
  export_course_package: guarded('export_course_package', [
    { name: 'script', kind: 'object', hint: 'generate_teaching_script 的输出（TeachingScript）' },
  ], rawExecutors.export_course_package),
  register_teacher_avatar: guarded('register_teacher_avatar', [
    { name: 'teacherProfile', kind: 'object', hint: '教师档案 { name, style?, ... }' },
  ], rawExecutors.register_teacher_avatar),
  synthesize_speech: guarded('synthesize_speech', [
    { name: 'script', kind: 'object', hint: 'TeachingScript 或 translate_multilingual 的同构多语脚本' },
  ], rawExecutors.synthesize_speech),
  generate_digital_human_video: guarded('generate_digital_human_video', [
    { name: 'script', kind: 'object', hint: 'generate_teaching_script 的输出' },
  ], rawExecutors.generate_digital_human_video),
  orchestrate_multi_teacher: guarded('orchestrate_multi_teacher', [
    { name: 'teachers', kind: 'array', hint: '教师列表 [{ name, role? }]' },
    { name: 'lessonSegments', kind: 'array', hint: '授课片段 [{ segmentId, title, minutes }]' },
  ], rawExecutors.orchestrate_multi_teacher),
  match_teaching_scene: guarded('match_teaching_scene', [
    { name: 'script', kind: 'object', hint: 'generate_teaching_script 的输出' },
  ], rawExecutors.match_teaching_scene),
  sync_multilingual_av: guarded('sync_multilingual_av', [
    { name: 'tracks', kind: 'array', hint: '字幕轨数组 [{ lang, format: "srt", content }]' },
  ], rawExecutors.sync_multilingual_av),
  realtime_qa_stream: guarded('realtime_qa_stream', [
    { name: 'question', kind: 'string', hint: '学习者提问文本' },
    { name: 'qaKnowledgeBase', kind: 'object', hint: 'build_qa_knowledge_base 的输出' },
  ], rawExecutors.realtime_qa_stream),
  manage_async_tasks: guarded('manage_async_tasks', [
    { name: 'operation', kind: 'string', hint: "操作类型 'query'|'list'|'cancel'|'cleanup'（gc 同 cleanup）" },
  ], rawExecutors.manage_async_tasks),
  describe_capabilities: guarded('describe_capabilities', [], rawExecutors.describe_capabilities),
  generate_assessment: guarded('generate_assessment', [
    { name: 'graph', kind: 'object', hint: 'extract_knowledge_graph 或 fuse_knowledge_graphs 的输出（含 entities 数组）' },
  ], rawExecutors.generate_assessment),
  audit_consistency: guarded('audit_consistency', [
    { name: 'assets', kind: 'array', hint: '≥2 项 [{ id, title?, text? | path? }]：课程材料纯文本或本地文件路径' },
  ], rawExecutors.audit_consistency),
  polish_teaching_text: guarded('polish_teaching_text', [
    { name: 'text', kind: 'string', hint: '待润色教学文本（非空字符串）' },
  ], rawExecutors.polish_teaching_text),
  sync_bilingual: guarded('sync_bilingual', [
    { name: 'primaryText', kind: 'string', hint: '中文主文档（mirror 模式逐字不动）' },
    { name: 'secondaryLang', kind: 'string', hint: '目标语种（en/ru/fr/ko…）' },
  ], rawExecutors.sync_bilingual),
  // qa_media 规格留空：mediaFile 与 subtitles 二选一（纯字幕检查合法），core 守卫结构化报错
  qa_media: guarded('qa_media', [], rawExecutors.qa_media),
  render_preview: guarded('render_preview', [
    { name: 'file', kind: 'any', hint: '文件路径（docx/pptx/xlsx/pdf），或已解码对象 { content, materialType }' },
  ], rawExecutors.render_preview),
  // 规格留空：sections 与 text 二选一，core 守卫结构化报错
  build_industry_graph: guarded('build_industry_graph', [], rawExecutors.build_industry_graph),
  link_knowledge_industry: guarded('link_knowledge_industry', [
    { name: 'courseGraph', kind: 'object', hint: '课程知识图谱（extract/fuse 输出；experimental 图谱兼容）' },
    { name: 'industryGraph', kind: 'object', hint: '产业图谱（#28 build_industry_graph 输出）' },
  ], rawExecutors.link_knowledge_industry),
};

/** 为适配器注册全部已实现共享技能（描述符来自注册表 + 执行器） */
export function registerSharedSkills(
  adapter: AdapterBase,
  opts: {
    llm?: LLMProvider;
    decoder?: SkillContext['decoder'];
    llmBatch?: Omit<import('../../core/llm.js').LlmBatchConfig, 'onProgress'>;
  } = {},
): void {
  const baseCtx: SkillContext = {};
  if (opts.llm) baseCtx.llm = opts.llm;
  if (opts.decoder) baseCtx.decoder = opts.decoder;
  if (opts.llmBatch) baseCtx.llmBatch = opts.llmBatch;
  for (const skillId of IMPLEMENTED_SKILLS) {
    adapter.registerSkill(descriptorOf(skillId), (inputs, _ctx, invokeOpts) =>
      executors[skillId](inputs, {
        ...baseCtx,
        llmBatch: invokeOpts?.onProgress
          ? { ...baseCtx.llmBatch, onProgress: invokeOpts.onProgress }
          : baseCtx.llmBatch,
      }, invokeOpts),
    );
  }
}
