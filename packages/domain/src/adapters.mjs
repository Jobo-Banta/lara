// Reference adapters owned by LARA. The filesystem store is for local and demo
// composition only (production requires the S3-compatible adapter, enforced by
// packages/config); the fixture scanner is never a production scanner.
import {mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {dirname,join,resolve,sep} from 'node:path';
import {fail} from './core.mjs';
import {FixtureScanner,MemoryEvidenceStore} from './evidence.mjs';

export class FilesystemEvidenceStore{
 constructor(root){this.root=resolve(root);}
 path(key){
  if(!/^[A-Za-z0-9_./-]{1,512}$/.test(key)||key.includes('..'))fail('VALIDATION_FAILED','Invalid object key.');
  const full=resolve(join(this.root,key));
  if(!full.startsWith(this.root+sep))fail('VALIDATION_FAILED','Object key escapes the bucket.');
  return full;
 }
 async put(key,bytes){const p=this.path(key);await mkdir(dirname(p),{recursive:true});await writeFile(p,bytes,{flag:'wx'}).catch(async e=>{if(e.code!=='EEXIST')throw e;});}
 async get(key){try{return await readFile(this.path(key));}catch(e){if(e.code==='ENOENT')fail('NOT_FOUND','Stored object missing.');throw e;}}
 async dispose(key){await rm(this.path(key),{force:true});}
}

export function evidenceStoreFromEnv(env=process.env){
 if(env.OBJECT_ADAPTER==='filesystem')return new FilesystemEvidenceStore(env.OBJECT_BUCKET||'.local/objects');
 if(env.OBJECT_ADAPTER==='memory')return new MemoryEvidenceStore();
 fail('DEPENDENCY_UNAVAILABLE','Object adapter '+env.OBJECT_ADAPTER+' is not available in this build; the S3-compatible adapter is qualified in a later release.');
}
export function scannerFromEnv(env=process.env){
 const adapter=env.SCANNER_ADAPTER||'fixture';
 if(adapter==='fixture'){if(['production','staging'].includes(env.LARA_MODE))fail('DEPENDENCY_UNAVAILABLE','The fixture scanner is forbidden outside local/demo.');return new FixtureScanner();}
 fail('DEPENDENCY_UNAVAILABLE','Scanner adapter '+adapter+' is not available in this build.');
}
