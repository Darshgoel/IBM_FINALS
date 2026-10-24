import fs from 'node:fs/promises';
import { FileBlob, PresentationFile } from 'file:///C:/Users/shobi/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/@oai/artifact-tool/dist/artifact_tool.mjs';
const b=await fs.readFile('C:/Users/shobi/OneDrive/Desktop/IBM_SkillsBuild_Finale_Template_PPT.pptx');
const p=await PresentationFile.importPptx(new FileBlob(new Uint8Array(b),'application/vnd.openxmlformats-officedocument.presentationml.presentation'));
console.log('slides',p.slides.items.length, 'keys',Object.keys(p));
for(let i=0;i<p.slides.items.length;i++){let s=p.slides.items[i]; console.log('slide',i,Object.keys(s)); console.log('shapes',s.shapes?.items?.length); for(const sh of (s.shapes?.items||[])){console.log(sh.id,sh.name,sh.geometry,sh.position, String(sh.text||''),Object.keys(sh));}}
console.log('methods help', typeof p.help, typeof p.inspect);
