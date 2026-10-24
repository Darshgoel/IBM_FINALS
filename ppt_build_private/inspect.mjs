import fs from 'node:fs/promises';
import path from 'node:path';
import { FileBlob, PresentationFile } from 'file:///C:/Users/shobi/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/@oai/artifact-tool/dist/artifact_tool.mjs';
const input = 'C:/Users/shobi/OneDrive/Desktop/IBM_SkillsBuild_Finale_Template_PPT.pptx';
const outDir = 'C:/Users/shobi/OneDrive/Desktop/IBM_FINALS/ppt_build_private/template';
await fs.mkdir(outDir, {recursive:true});
const bytes = await fs.readFile(input);
const presentation = await PresentationFile.importPptx(new FileBlob(new Uint8Array(bytes), 'application/vnd.openxmlformats-officedocument.presentationml.presentation'));
const result = await presentation.inspect({select:'$.slides[*]', include:['id','index','layout','title','elements.id','elements.kind','elements.text','elements.alt','elements.title','notes.text']});
await fs.writeFile(path.join(outDir, 'content.ndjson'), result.ndjson, 'utf8');
console.log(result.ndjson);
console.log('Slide count:', presentation.slides.items.length);
console.log('Slide size:', JSON.stringify(presentation.slideSize));
for (let i=0;i<presentation.slides.items.length;i++) {
  const slide = presentation.slides.items[i];
  const png = await slide.export({format:'png', scale:1});
  await fs.writeFile(path.join(outDir, `slide-${String(i+1).padStart(2,'0')}.png`), new Uint8Array(await png.arrayBuffer()));
}
const montage = await presentation.export({format:'webp', montage:true, scale:0.35});
await fs.writeFile(path.join(outDir,'montage.webp'), new Uint8Array(await montage.arrayBuffer()));
