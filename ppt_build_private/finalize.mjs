import fs from 'node:fs/promises'; import path from 'node:path'; import crypto from 'node:crypto'; import {pathToFileURL} from 'node:url';
import {FileBlob,PresentationFile} from 'file:///C:/Users/shobi/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/@oai/artifact-tool/dist/artifact_tool.mjs';
const SKILL='C:/Users/shobi/.codex/plugins/cache/openai-primary-runtime/presentations/26.1022.11436/skills/presentations';
const workspace='C:/Users/shobi/OneDrive/Desktop/IBM_FINALS';
const template='C:/Users/shobi/OneDrive/Desktop/IBM_SkillsBuild_Finale_Template_PPT.pptx';
const draft=workspace+'/ppt_build_private/FoodBridge-draft.pptx';
const final=workspace+'/ppt_output/FoodBridge_National_Finale.pptx';
const sha=crypto.createHash('sha256').update(await fs.readFile(template)).digest('hex');
const {finalizePresentation}=await import(pathToFileURL(path.join(SKILL,'container_tools/artifact_tool_utils.mjs')).href);
const staging=workspace+'/ppt_build_private/finalizer'; await fs.mkdir(staging,{recursive:true}); await fs.mkdir(path.dirname(final),{recursive:true});
const requirements={explicitTotalSlideCount:3,sourceTemplatePath:template,requiredTemplateReferenceSlides:[1,2,3],minimumTemplateCoverageRatio:1};
const fontPolicy={basis:'reference',families:['IBM Plex Sans'],referencePath:template,referenceSha256:sha};
const result=await finalizePresentation({...requirements,workspaceDir:workspace,candidatePath:draft,finalPath:final,pythonExecutable:'C:/Users/shobi/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe',integrityValidatorPath:path.join(SKILL,'container_tools/inspect_presentation_package_integrity.py'),layoutValidatorPath:path.join(SKILL,'container_tools/inspect_presentation_layout_geometry.py'),layoutArgs:['--expected-slide-size-emu','12192000,6858000','--validate-bullet-geometry','--validate-heading-fit'],fontPolicy,verifyArtifactToolImport:true,receiptPath:staging+'/FoodBridge_National_Finale.validation.json'});
console.log(JSON.stringify(result,null,2));



