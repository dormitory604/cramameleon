import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TextSection } from '../src/tools/localText.ts';

const run = promisify(execFile);
export const needsOcr = (text: string) => text.replace(/\s/g, '').length < 40;

// Bound CPU, image dimensions, output, and total elapsed time independently.
export async function ocrSparsePages(data: Uint8Array, sections: TextSection[],
 recognize?: (page: number, remainingMs: number) => Promise<string>) {
 const warnings: string[] = [];
 const candidates = sections.filter(s => needsOcr(s.text));
 if (!candidates.length) return warnings;
 let deadline = Date.now() + 35_000;
 let directory: string | undefined;
 let availablePages: Set<number> | undefined;
 let attempted = 0, recovered = 0;
 try {
  if (!recognize) {
   directory = await mkdtemp(join(tmpdir(), 'cram-ocr-'));
   const pdf = join(directory, 'input.pdf');
   await writeFile(pdf, data);
   const runtime = resolve(import.meta.dirname, '../ocr-runtime');
   const python = process.env.APP_OCR_PYTHON || join(runtime, 'venv/bin/python');
   const models = process.env.APP_OCR_MODELS || join(runtime, 'models');
   const helper = resolve(import.meta.dirname, 'ocr/recognize.py');
   const pages = candidates.slice(0, 16).map(section => section.page);
   let stdout: string;
   try {
    ({ stdout } = await run(python, [helper, models, pdf, JSON.stringify(pages), '--stream'],
     { timeout: 40_000, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024 }));
   } catch (error) {
    stdout = String((error as { stdout?: string }).stdout || '');
    warnings.push('自动公式 OCR 超时或中断，已保留完成识别的页面。');
   }
   const output = decodeOcrOutput(stdout);
   warnings.push(...output.warnings);
   const recognized = new Map(output.pages.map(item => [item.page, item.text]));
   availablePages = new Set(recognized.keys());
   recognize = async page => recognized.get(page) || '';
   deadline = Date.now() + 1000;

  }
  for (const section of candidates) {
   if (attempted >= 16 || Date.now() >= deadline) break;
   if (availablePages && !availablePages.has(section.page!)) continue;
   attempted++;
   try {
    const text = (await recognize(section.page!, deadline - Date.now())).trim();
    // Keep native text if OCR adds no meaningful content. Never erase good text.
    if (text.replace(/\s/g, '').length > Math.max(40, section.text.replace(/\s/g, '').length)) {
     section.text = section.text.trim() + '\n\n[OCR 自动识别，公式和符号需核对原图]\n' + text;
     section.location += '（含 OCR）';
     recovered++;
    }
   } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
     warnings.push('自动 OCR 不可用：服务器未安装公式 OCR 运行环境，请管理员运行安装脚本。');
     break;
    }
    warnings.push(`第 ${section.page} 页自动 OCR 失败或超时，保留原文本，请尝试其他资料。`);
   }
  }
 } catch {
  warnings.push('自动公式 OCR 暂不可用或超时，保留原文本，请尝试其他资料。');
 } finally {
  if (directory) await rm(directory, { recursive: true, force: true });
 }
 warnings.push(`已自动尝试 OCR ${attempted} 页，${recovered} 页补充了识别文本。OCR 可能误识别公式、上下标和选项，不能仅凭 OCR 字符匹配视为真题已核实。`);
 if (attempted < candidates.length) warnings.push(`另有 ${candidates.length - attempted} 页未完成 OCR（依赖不可用或达到 16 页/35 秒上限），请拆分文件或换资料。`);
 return warnings;
}

// Each complete line is a page checkpoint; a killed process may leave a partial final line.
export function decodeOcrOutput(stdout: string): { pages: { page: number; text: string }[]; warnings: string[] } {
 const result: { pages: { page: number; text: string }[]; warnings: string[] } = { pages: [], warnings: [] };
 for (const line of stdout.split('\n').slice(0, -1)) {
  if (!line.trim()) continue;
  const event = JSON.parse(line) as typeof result;
  result.pages.push(...event.pages);
  result.warnings.push(...event.warnings);
 }
 return result;
}
