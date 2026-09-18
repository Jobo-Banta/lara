import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const bytes=await readFile('docs/development/contracts/openapi.json');
const source=JSON.parse(bytes);
const operations=[];
for(const [path,item] of Object.entries(source.paths))for(const [method,definition] of Object.entries(item))if(['get','post','put','patch','delete','head','options'].includes(method))operations.push({method:method.toUpperCase(),path,operationId:definition.operationId});
const result=JSON.stringify({source:'docs/development/contracts/openapi.json',sha256:createHash('sha256').update(bytes).digest('hex'),operations},null,2)+'\n';
const target='packages/contracts/generated/operations.json';
if(process.argv.includes('--check')){
 if(await readFile(target,'utf8')!==result)throw Error('Generated operation contract drift; run pnpm contracts:generate');
 console.log('PASS: generated operation contract matches reviewed OpenAPI');
}else{await mkdir('packages/contracts/generated',{recursive:true});await writeFile(target,result);console.log('Generated operation contract');}
