import { cp, mkdir } from 'node:fs/promises';
await mkdir('public/pdfjs',{recursive:true});
for(const name of ['cmaps','standard_fonts'])await cp(`node_modules/pdfjs-dist/${name}`,`public/pdfjs/${name}`,{recursive:true});
