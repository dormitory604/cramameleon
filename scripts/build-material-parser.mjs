import { cp } from 'node:fs/promises';
import { build } from 'vite';

await build({
 configFile: false,
 ssr: { noExternal: true },
 build: {
  ssr: 'scripts/parse-remote-material.ts', outDir: 'material-parser', emptyOutDir: true, copyPublicDir: false,
  rollupOptions: { output: { entryFileNames: 'parse.mjs' } },
 },
});
await cp('node_modules/pdfjs-dist/legacy/build/pdf.min.mjs', 'material-parser/pdf.mjs');
await cp('node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs', 'material-parser/pdf.worker.mjs');
