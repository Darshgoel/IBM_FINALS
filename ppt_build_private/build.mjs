import fs from 'node:fs/promises';
import path from 'node:path';
import { FileBlob, PresentationFile } from 'file:///C:/Users/shobi/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/@oai/artifact-tool/dist/artifact_tool.mjs';
const template='C:/Users/shobi/OneDrive/Desktop/IBM_SkillsBuild_Finale_Template_PPT.pptx';
const out='C:/Users/shobi/OneDrive/Desktop/IBM_FINALS/ppt_build_private/FoodBridge-draft.pptx';
const bytes=await fs.readFile(template);
const deck=await PresentationFile.importPptx(new FileBlob(new Uint8Array(bytes),'application/vnd.openxmlformats-officedocument.presentationml.presentation'));
const shapes=(i)=>deck.slides.items[i].shapes.items;
const find=(i,needle)=>shapes(i).find(s=>String(s.text).includes(needle));
find(0,'[Enter your project title]').text='FoodBridge';
find(0,'[College name]').text='College to be added';
find(0,'[Team name]').text='Team to be added';
find(0,'[Team members’ names]').text='Team member names to be added';
find(1,'Describe the problem you aim').text='Good food is wasted while nearby communities face shortages. Donors, NGOs and food banks often coordinate through fragmented manual channels, making suitable matches and safe, timely handoffs difficult.';
find(1,'Describe your proposed solution').text='FoodBridge connects verified donors, NGOs, food banks, recipients and recovery partners. It matches surplus with local demand, tracks handoffs, helps recipients find nearby access points and routes unsuitable food toward recovery.';
find(2,'Project Architecture & IBM Bob').text='FoodBridge Architecture & IBM Bob';
const architecture=find(2,'Provide an overview');
const bodyStyle={typeface:'IBM Plex Sans',fontSize:'18pt',color:'#222222'};
const sectionStyle={typeface:'IBM Plex Sans',fontSize:'16pt',bold:true,color:'#0072CE'};
architecture.text=[
  {runs:[{run:'ARCHITECTURE',style:sectionStyle}]},
  {runs:[{run:'Role portals → Express API (JWT, matching, alerts) → PostgreSQL',style:bodyStyle}]},
  {runs:[{run:'Render hosting  •  Leaflet + OpenStreetMap',style:bodyStyle}]},
  {runs:[{run:'',style:bodyStyle}]},
  {runs:[{run:'IBM BOB — DEVELOPMENT PARTNER',style:sectionStyle}]},
  {runs:[{run:'Design: ',style:{...bodyStyle,bold:true}},{run:'Co-designed five core interfaces and safety-first redistribution.',style:bodyStyle}]},
  {runs:[{run:'Build: ',style:{...bodyStyle,bold:true}},{run:'Web interfaces, Express backend, role access, matching, and alerts.',style:bodyStyle}]},
  {runs:[{run:'Test: ',style:{...bodyStyle,bold:true}},{run:'Helped debug and validate; 33/33 end-to-end tests passed.',style:bodyStyle}]},
];
await (await PresentationFile.exportPptx(deck)).save(out);
console.log('DRAFT',out);
console.log('slides',deck.slides.items.length);
for(let i=0;i<deck.slides.items.length;i++) console.log('slide',i+1,shapes(i).map(s=>String(s.text)).filter(Boolean));



