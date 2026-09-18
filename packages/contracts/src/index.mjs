// Typed application contract derived from the reviewed OpenAPI document.
// Controllers look operations up by id and validate bodies with the compiled
// schemas; nothing here invents a second payload or state model.
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const Ajv=require('ajv/dist/2020.js').default;
const addFormats=require('ajv-formats').default;

const source=new URL('../../../docs/development/contracts/openapi.json',import.meta.url);
export const openapi=JSON.parse(readFileSync(source,'utf8'));
export const permissions=Object.freeze(JSON.parse(readFileSync(new URL('../../../docs/development/contracts/permissions.json',import.meta.url),'utf8')).permissions);
export const stateMachines=Object.freeze(JSON.parse(readFileSync(new URL('../../../docs/development/contracts/state-machines.json',import.meta.url),'utf8')).machines);

const ajv=new Ajv({strict:false,allErrors:true,coerceTypes:false,useDefaults:false,removeAdditional:false});
addFormats(ajv);
for(const [name,schema] of Object.entries(openapi.components.schemas))ajv.addSchema(schema,'#/components/schemas/'+name);
const compiled=new Map();
export function schemaFor(name){
 if(!openapi.components.schemas[name])throw new Error('Unknown contract schema: '+name);
 if(!compiled.has(name))compiled.set(name,ajv.compile({$ref:'#/components/schemas/'+name}));
 return compiled.get(name);
}

const refName=ref=>ref?ref.split('/').at(-1):null;
function bodySchema(content){return refName(content?.['application/json']?.schema?.$ref)||null;}
export const operations=Object.freeze(Object.fromEntries((()=>{
 const list=[];
 for(const [path,item] of Object.entries(openapi.paths))for(const [method,definition] of Object.entries(item)){
  if(!['get','post','put','patch','delete'].includes(method))continue;
  const parameters=definition.parameters||[];
  const success=Object.keys(definition.responses).map(Number).find(code=>code>=200&&code<300);
  list.push([definition.operationId,Object.freeze({
   operationId:definition.operationId,method:method.toUpperCase(),path,phase:definition['x-delivery-phase'],permission:definition['x-required-permission'],scope:definition['x-scope'],
   pathParams:parameters.filter(p=>p.in==='path').map(p=>p.name),
   queryParams:parameters.filter(p=>p.in==='query').map(p=>p.name),
   requiresEntity:parameters.some(p=>p.in==='header'&&p.name==='X-Entity-Id'&&p.required),
   requiresIdempotencyKey:parameters.some(p=>p.in==='header'&&p.name==='Idempotency-Key'&&p.required),
   requiresIfMatch:parameters.some(p=>p.in==='header'&&p.name==='If-Match'&&p.required),
   input:bodySchema(definition.requestBody?.content),
   successStatus:success,
   response:bodySchema(definition.responses[String(success)]?.content),
   isList:/ResourceList$|List$/.test(bodySchema(definition.responses[String(success)]?.content)||''),
  })]);
 }
 return list;
})()));

export function operationsForPhase(phase){return Object.values(operations).filter(o=>o.phase===phase);}
export function findOperation(method,path){
 const upper=method.toUpperCase();
 for(const op of Object.values(operations)){
  if(op.method!==upper)continue;
  const pattern=new RegExp('^'+op.path.replace(/\{[^}]+\}/g,'([^/]+)')+'$');
  const match=pattern.exec(path);
  if(match){const params={};op.pathParams.forEach((name,i)=>{params[name]=decodeURIComponent(match[i+1]);});return {operation:op,params};}
 }
 return null;
}

// Error shape from docs/development/06-api-and-workflows.md.
export const errorStatus=Object.freeze({VALIDATION_FAILED:422,UNAUTHENTICATED:401,FORBIDDEN:403,NOT_FOUND:404,FEATURE_NOT_ENABLED:409,STATE_CONFLICT:409,SELF_APPROVAL:403,PERIOD_LOCKED:409,UNBALANCED_ENTRY:422,DUPLICATE_SOURCE:409,ALLOCATION_EXCEEDS_BALANCE:409,RULE_PROFILE_NOT_APPROVED:409,EVIDENCE_NOT_READY:409,IDEMPOTENCY_CONFLICT:409,VERSION_CONFLICT:412,PRECONDITION_REQUIRED:428,RATE_LIMITED:429,DEPENDENCY_UNAVAILABLE:503});
export const retryableCodes=new Set(['RATE_LIMITED','DEPENDENCY_UNAVAILABLE']);

function fieldErrors(errors){
 return (errors||[]).map(e=>({path:(e.instancePath||'').replace(/^\//,'').replace(/\//g,'.')||(e.params?.missingProperty??e.params?.additionalProperty??''),message:e.keyword==='additionalProperties'?'Unknown field':e.keyword==='required'?'Required':e.message||'Invalid'}));
}
export function validate(schemaName,value){
 const check=schemaFor(schemaName);
 const ok=check(value);
 return ok?{ok:true,fieldErrors:[]}:{ok:false,fieldErrors:fieldErrors(check.errors)};
}
export function validateInput(operationId,body){
 const op=operations[operationId];
 if(!op)throw new Error('Unknown operation: '+operationId);
 if(!op.input)return body===undefined||body===null||(typeof body==='object'&&Object.keys(body).length===0)?{ok:true,fieldErrors:[]}:{ok:false,fieldErrors:[{path:'',message:'This operation takes no body'}]};
 return validate(op.input,body);
}
export function validateResponse(operationId,body){
 const op=operations[operationId];
 if(!op)throw new Error('Unknown operation: '+operationId);
 if(!op.response)return {ok:true,fieldErrors:[]};
 return validate(op.response,body);
}
export function assertTransition(machine,from,to){
 const rules=stateMachines[machine];
 if(!rules)throw new Error('Unknown state machine: '+machine);
 if(!rules[from])throw new Error('Unknown state '+from+' for '+machine);
 return rules[from].includes(to);
}
