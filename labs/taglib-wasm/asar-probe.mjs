// Package only this lab, never Rio's app or production dependencies.
import { createPackage } from "@electron/asar";
import { cp, mkdir, writeFile, copyFile } from "node:fs/promises";
import path from "node:path";
import { lab, generated } from "./lab.mjs";
const folder = path.join(generated, "asar-source"),
  resources = path.join(generated, "asar-resources");
await mkdir(folder, { recursive: true });
await mkdir(resources, { recursive: true });
await cp(path.join(lab, "node_modules"), path.join(folder, "node_modules"), {
  recursive: true,
});
for (const engine of ["web", "wasi"])
  await copyFile(
    path.join(lab, "node_modules/taglib-wasm/dist", `taglib-${engine}.wasm`),
    path.join(resources, `taglib-${engine}.wasm`),
  );
await writeFile(
  path.join(folder, "package.json"),
  JSON.stringify({
    name: "writer-asar-lab",
    version: "0.0.0",
    type: "module",
    main: "main.mjs",
  }),
);
await writeFile(
  path.join(folder, "main.mjs"),
  `
import { app } from 'electron';
import { TagLib } from './node_modules/taglib-wasm/dist/index.js';
import { mkdirSync, copyFileSync, writeFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
const root = ${JSON.stringify(generated)}, resources = ${JSON.stringify(resources)};
const profile = path.join(root,'asar-profile'); mkdirSync(profile,{recursive:true});
app.setPath('userData',profile); app.setPath('sessionData',profile); app.setAppLogsPath(path.join(profile,'logs'));
app.whenReady().then(async()=>{
  const result={electron:process.versions.electron,node:process.versions.node,cases:[]};
  try {
    for(const backend of ['wasi','emscripten']) for(const location of ['asar-default','external-wasm']) {
      const r={backend,location};result.cases.push(r);
      try {
        const t=await TagLib.initialize({forceWasmType:backend,...(location==='external-wasm'?{wasmUrl:path.join(resources,'taglib-'+(backend==='wasi'?'wasi':'web')+'.wasm')}:{})});
        r.actualBackend=t.module.isWasi?'wasi':'emscripten';
        const file=path.join(root,'asar-'+backend+'-'+location+'.flac');
        copyFileSync(path.join(root,'originals/sine.flac'),file);
        if(!realpathSync(file).startsWith(realpathSync(root)+path.sep))throw Error('LAB boundary');
        const f=await t.open(file,{partial:false}); try{f.setProperty('TITLE','ASAR fixture edit');await f.saveToFile();}finally{f.dispose();}
        const reload=await t.open(file,{partial:false});try{r.title=reload.tag().title;r.passed=r.title==='ASAR fixture edit';}finally{reload.dispose();}
      }catch(e){r.error=String(e);r.passed=false;}
    }
    writeFileSync(path.join(root,'asar.json'),JSON.stringify(result,null,2)+'\\n'); console.log(JSON.stringify(result)); app.exit(0);
  }catch(e){console.error(e);app.exit(1);}
});
`,
);
await createPackage(folder, path.join(generated, "writer-lab.asar"));
console.log(path.join(generated, "writer-lab.asar"));
