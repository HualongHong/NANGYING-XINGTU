/**
 * 引擎状态探测（R5-4，反馈 a P1-7）：区分 builtin / optional-not-installed / not-provided。
 *
 * 判定基于真实环境探测，不硬编码：
 *  - OCR（parse 依赖）：tesseract.js 可 require 且 tessdata/ 语言包存在（兼容仓库根） → builtin；
 *    tesseract.js 缺失或语言包缺失 → optional-not-installed（附安装指引）；
 *  - 7 个特化技能（数字人/视频/语音/多师/场景/多语同步/实时）：官方未接入外部引擎
 *    → not-provided（说明降级形态，来自契约 degradation 描述）。
 */
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type EngineStatus = 'builtin' | 'optional-not-installed' | 'not-provided';

export interface EngineInfo {
  status: EngineStatus;
  /** 状态说明（如降级形态） */
  detail?: string;
  /** 安装指引（optional-not-installed 时） */
  installHint?: string;
}

const SPECIALIZED_NOT_PROVIDED = new Set([
  'register_teacher_avatar',
  'generate_digital_human_video',
  'synthesize_speech',
  'orchestrate_multi_teacher',
  'match_teaching_scene',
  'sync_multilingual_av',
  'realtime_qa_stream',
]);

/** 仓库根：源码（adapters/core）与构建产物（dist/adapters/core）各差一层，双路径探测 */
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT_CANDIDATES = [join(HERE, '../..'), join(HERE, '../../..')];
function repoFile(rel: string): boolean {
  return REPO_ROOT_CANDIDATES.some((root) => existsSync(join(root, rel)));
}
let ocrProbe: Promise<EngineInfo> | null = null;

/** OCR 引擎探测（缓存一次进程生命周期） */
export function probeOcrEngine(): Promise<EngineInfo> {
  ocrProbe ??= (async (): Promise<EngineInfo> => {
    let tesseractOk = false;
    try {
      const mod = await import('tesseract.js');
      tesseractOk = typeof mod.createWorker === 'function';
    } catch {
      tesseractOk = false;
    }
    const langPacks = ['chi_sim.traineddata', 'eng.traineddata'].filter((f) => repoFile(`tessdata/${f}`) || repoFile(f));
    if (tesseractOk && langPacks.length === 2) {
      return { status: 'builtin', detail: '本地 OCR（tesseract.js + chi_sim/eng 语言包），扫描件结构化摄取可用' };
    }
    if (tesseractOk) {
      return {
        status: 'optional-not-installed',
        detail: `tesseract.js 已装，但语言包缺失（仅 ${langPacks.join('、') || '无'}）`,
        installHint: '下载 chi_sim.traineddata / eng.traineddata 放到 tessdata/ 目录（兼容仓库根；jie 版可从 tessdata 项目获取）',
      };
    }
    return {
      status: 'optional-not-installed',
      detail: 'tesseract.js 未安装（optionalDependencies）',
      installHint: 'pnpm add tesseract.js；语言包 chi_sim/eng.traineddata 放 tessdata/ 目录（兼容仓库根）',
    };
  })();
  return ocrProbe;
}

/** 技能引擎状态（describe_capabilities 输出用） */
export async function engineInfoOf(
  skillId: string,
  degradation: string,
): Promise<EngineInfo | null> {
  if (skillId === 'parse_course_material') {
    return probeOcrEngine();
  }
  if (skillId === 'qa_media') {
    // R7-4：ffmpeg 引擎探测（与 qa_media 执行器同一份探测逻辑）
    const ok = await (async () => {
      try {
        await new Promise<void>((resolve, reject) => {
          execFile('ffprobe', ['-version'], { timeout: 10_000, windowsHide: true }, (err) =>
            err ? reject(err) : resolve());
        });
        return true;
      } catch {
        return false;
      }
    })();
    if (ok) return { status: 'builtin', detail: 'ffmpeg/ffprobe 可用（PATH 探测）：场景切换/静音/元数据检查就绪' };
    return {
      status: 'optional-not-installed',
      detail: '未检测到 ffmpeg/ffprobe',
      installHint: '安装 ffmpeg 并加入 PATH（https://ffmpeg.org/download.html 或 winget install ffmpeg）；字幕静态时间轴检查无需引擎仍可用',
    };
  }
  if (SPECIALIZED_NOT_PROVIDED.has(skillId)) {
    return {
      status: 'not-provided',
      detail: `官方未接入外部引擎；降级形态：${degradation}`,
    };
  }
  return null; // 纯逻辑技能无外部引擎
}
