import type { TextSection } from './localText.ts';

// This is a warning heuristic, not proof that a page is blank or needs OCR.
export function pdfTextWarnings(sections: TextSection[], ocrAttempted = false): string[] {
 const empty = sections.filter(section => !section.text.trim());
 const sparse = sections.filter(section => {
  const length = section.text.replace(/\s/g, '').length;
  return length > 0 && length < 40;
 });
 const warnings = ['PDF 按文本层提取，多栏、表格和公式的顺序可能不完整，请对照原文。'];
 if (empty.length) warnings.push(`${empty.length} 页未提取到文字，可能为空白页或扫描图像；${ocrAttempted ? '自动 OCR 未恢复这些页，请查看 OCR 告警' : '本地导入暂不支持 OCR'}。`);
 if (sparse.length) {
  const pages = sparse.slice(0, 20).map(section => section.page).join('、');
  warnings.push(`第 ${pages}${sparse.length > 20 ? ' 等' : ''} 页提取文字很少，可能仅有页眉页脚，图片中的题干和公式可能缺失；不能据此认定原页空白。优先尝试其他相关资料；若必须使用本文件，请核对原 PDF，${ocrAttempted ? '查看 OCR 告警，必要时提供更清晰的文件' : '必要时再考虑 OCR'}。`);
 }
 return warnings;
}
