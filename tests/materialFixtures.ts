import { zipSync, strToU8 } from 'fflate';
export const txt = '条件概率：当 P(B)>0 时，P(A|B)=P(A∩B)/P(B)。\n\n互斥事件：P(A∪B)=P(A)+P(B)。';
export function docx() {return zipSync({'word/document.xml':strToU8('<w:document xmlns:w="w"><w:body><w:p><w:r><w:t>条件</w:t></w:r><w:r><w:t>概率 DOCX</w:t></w:r></w:p><w:p><w:r><w:t>第二段真实位置</w:t></w:r></w:p></w:body></w:document>')});}
export function pptx() {return zipSync({
 'ppt/presentation.xml':strToU8('<p:presentation xmlns:p="p" xmlns:r="r"><p:sldIdLst><p:sldId id="256" r:id="r2"/><p:sldId id="257" r:id="r1"/></p:sldIdLst></p:presentation>'),
 'ppt/_rels/presentation.xml.rels':strToU8('<Relationships><Relationship Id="r1" Target="slides/slide1.xml"/><Relationship Id="r2" Target="slides/slide2.xml"/></Relationships>'),
 'ppt/slides/slide1.xml':strToU8('<p:sld xmlns:p="p" xmlns:a="a"><a:p><a:r><a:t>第二张：条件概率</a:t></a:r></a:p></p:sld>'),
 'ppt/slides/slide2.xml':strToU8('<p:sld xmlns:p="p" xmlns:a="a"><a:p><a:r><a:t>第一张：事件</a:t></a:r></a:p></p:sld>')
});}
export function pdf(empty=false,emptySecondPage=false) {
 const stream=empty?'':'BT /F1 12 Tf 72 700 Td (Conditional probability: P A given B) Tj ET';
 const secondStream=emptySecondPage?'':stream;
 const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>',
 '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R >>',
 `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
 '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>',
 `<< /Length ${secondStream.length} >>\nstream\n${secondStream}\nendstream`,'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
 let text='%PDF-1.4\n';const offsets=[0];
 for(const [i,obj] of objects.entries()){offsets.push(text.length);text+=`${i+1} 0 obj\n${obj}\nendobj\n`;}
 const xref=text.length;text+=`xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
 for(const offset of offsets.slice(1))text+=`${String(offset).padStart(10,'0')} 00000 n \n`;
 text+=`trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
 return strToU8(text);
}
