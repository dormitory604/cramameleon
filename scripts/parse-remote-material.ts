import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AppError } from '../src/contracts/index.ts';
import { parseLocalBytes } from '../src/tools/localParser.ts';
import type { TextSection } from '../src/tools/localText.ts';

// PDF.js warnings must stay separate from the JSON response on stdout.
console.log = console.error;

async function readPdf(data: Uint8Array) {
 const pdfPath = pathToFileURL(resolve(import.meta.dirname, 'pdf.mjs')).href;
 const pdfjs: typeof import('pdfjs-dist') = await import(pdfPath);
 const assets = resolve(import.meta.dirname, '../dist/pdfjs');
 const task = pdfjs.getDocument({ data, disableFontFace: true, useSystemFonts: false, useWasm: false,
  cMapUrl: assets + '/cmaps/', cMapPacked: true, standardFontDataUrl: assets + '/standard_fonts/' });
 try {
  const doc = await task.promise;
  if (doc.numPages > 1000) throw new AppError('FILE_LIMIT', 'PDF 超过 1000 页，请拆分文件');
  const sections: TextSection[] = [];
  const warnings = ['PDF 按文本层提取，多栏、表格和公式的顺序可能不完整，请对照原文。'];
  let empty = 0, total = 0;
  for (let page = 1; page <= doc.numPages; page++) {
   const value = await doc.getPage(page);
   const content = await value.getTextContent();
   const text = content.items.map(item => 'str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : '').join('');
   total += text.length;
   if (total > 2_000_000) throw new AppError('FILE_LIMIT', '提取文本超过 200 万字，请拆分文件');
   if (!text.trim()) empty++;
   sections.push({ text, location: `第 ${page} 页`, page });
   value.cleanup();
  }
  if (empty) warnings.push(`${empty} 页未提取到文字，可能为空白页或扫描图像。`);
  return { sections, warnings };
 } catch (error) {
  if (error instanceof AppError) throw error;
  throw new AppError('FILE_PDF', error instanceof Error && error.name === 'PasswordException' ? 'PDF 已加密' : 'PDF 无法解析，请确认文件完整');
 } finally { await task.destroy(); }
}

try {
 const bytes: Buffer[] = [];
 for await (const chunk of process.stdin) bytes.push(chunk);
 const document = await parseLocalBytes(process.argv[2], new Uint8Array(Buffer.concat(bytes)), readPdf);
 process.stdout.write(JSON.stringify({ document }));
} catch (error) {
 const code = error instanceof AppError ? error.code : 'FILE_PARSE';
 const message = error instanceof AppError ? error.message : '文件解析失败，请检查格式';
 process.stdout.write(JSON.stringify({ error: { code, message } }));
}
