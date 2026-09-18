// Evidence module: upload registration (quarantine), completion verification
// (checksum, size, sniffed type) and scan outcome. Availability is the only
// state an approval may bind to. Storage and scanning are adapters owned by
// LARA; the fixture scanner flags the EICAR test string.
import {createHash,randomUUID} from 'node:crypto';
import {assertInput,audit,cursorClause,emit,enqueueJob,fail,page,pageArgs,requireEntity,requirePermission} from './core.mjs';

export const allowedMime=new Set(['application/pdf','image/jpeg','image/png','text/csv','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']);
export const maxBytes=20971520;

// Type sniffing: the declared MIME must match the bytes, never the extension.
export function sniffMime(bytes){
 const b=Buffer.from(bytes);
 if(b.length>=5&&b.subarray(0,5).toString('latin1')==='%PDF-')return 'application/pdf';
 if(b.length>=3&&b[0]===0xff&&b[1]===0xd8&&b[2]===0xff)return 'image/jpeg';
 if(b.length>=8&&b.subarray(0,8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a])))return 'image/png';
 if(b.length>=4&&b[0]===0x50&&b[1]===0x4b&&(b[2]===0x03||b[2]===0x05||b[2]===0x07))return 'application/zip-container';
 if(b.length>=2&&b[0]===0x4d&&b[1]===0x5a)return 'application/x-msdownload';
 if(b.length>=4&&b[0]===0x7f&&b.subarray(1,4).toString('latin1')==='ELF')return 'application/x-elf';
 if(b.length>=2&&b.subarray(0,2).toString('latin1')==='#!')return 'text/x-script';
 const sample=b.subarray(0,Math.min(b.length,4096));
 if(sample.length&&!sample.some(c=>c===0)&&sample.toString('utf8').split('\n')[0].includes(','))return 'text/csv';
 return 'application/octet-stream';
}
// XLSX is a zip container whose first entry names [Content_Types].xml; a zip
// that is not an OOXML package (or a nested archive bomb) is rejected.
export function sniffedMatches(declared,bytes){
 const sniffed=sniffMime(bytes);
 if(declared==='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')return sniffed==='application/zip-container'&&Buffer.from(bytes).subarray(0,4096).toString('latin1').includes('[Content_Types].xml');
 return sniffed===declared;
}

export class FixtureScanner{
 // Returns {clean:true} or {clean:false,reason}. Only for local/demo/CI.
 async scan(bytes){const text=Buffer.from(bytes).toString('latin1');return text.includes('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*')?{clean:false,reason:'Known test signature'}:{clean:true};}
}
export class MemoryEvidenceStore{
 constructor(){this.objects=new Map();}
 async put(key,bytes){this.objects.set(key,Buffer.from(bytes));}
 async get(key){const v=this.objects.get(key);if(!v)fail('NOT_FOUND','Stored object missing.');return v;}
 async dispose(key){this.objects.delete(key);}
}

export const evidenceResource=e=>({id:e.id,version:Number(e.version),filename:e.filename,mime:e.mime,byteCount:Number(e.byte_count),sha256:e.sha256,state:e.status,classification:e.classification,simulation:false});

// 1. Register: metadata and expected checksum create the quarantined record
// and a tenant-private object key. The upload URL is served by the API layer
// as an authenticated stream endpoint; storage keys are never public.
export async function registerUpload(tx,ctx,entityId,input,{uploadBase='/v1/evidence',ttlSeconds=900}={}){
 requirePermission(ctx,'evidence.upload');requireEntity(ctx,entityId);assertInput('EvidenceUpload',input);
 if(!allowedMime.has(input.mime))fail('VALIDATION_FAILED','Unsupported file type.',{fieldErrors:[{path:'mime',message:'Unsupported'}]});
 if(input.byteCount>maxBytes)fail('VALIDATION_FAILED','File exceeds 20 MB.',{fieldErrors:[{path:'byteCount',message:'Too large'}]});
 if(/[\\/\0]/.test(input.filename)||input.filename.length>255)fail('VALIDATION_FAILED','Invalid file name.',{fieldErrors:[{path:'filename',message:'Invalid'}]});
 const duplicate=(await tx.query("select id,status from lara.evidence where tenant_id=$1 and entity_id=$2 and sha256=$3 and status<>'rejected' limit 1",[ctx.tenantId,entityId,input.sha256])).rows[0];
 if(duplicate?.status==='available')fail('DUPLICATE_SOURCE','This file is already available as evidence '+duplicate.id+'.');
 const id=randomUUID(),key='tenants/'+ctx.tenantId+'/entities/'+entityId+'/evidence/'+id;
 const row=(await tx.query("insert into lara.evidence(id,tenant_id,entity_id,object_key,filename,sha256,mime,byte_count,classification,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *",[id,ctx.tenantId,entityId,key,input.filename,input.sha256,input.mime,input.byteCount,input.classification,ctx.principalId])).rows[0];
 await audit(tx,ctx,{entityId,action:'evidence.register',resourceType:'evidence',resourceId:row.id,resourceVersion:1});
 return {evidenceId:row.id,version:1,uploadUrl:uploadBase+'/'+row.id+'/content',expiresAt:new Date(Date.now()+ttlSeconds*1000).toISOString(),state:'quarantined'};
}

// 2. Complete: bytes are checked against the declared checksum, size and
// type. Any mismatch rejects the record; nothing mismatched is ever stored.
// Success stores the object and queues the scan job (state scanning).
export async function completeUpload(tx,ctx,entityId,id,bytes,store){
 requirePermission(ctx,'evidence.upload');requireEntity(ctx,entityId);
 const row=(await tx.query('select * from lara.evidence where tenant_id=$1 and entity_id=$2 and id=$3 for update',[ctx.tenantId,entityId,id])).rows[0];
 if(!row)fail('NOT_FOUND','Evidence not found.');
 if(row.status!=='quarantined')fail('STATE_CONFLICT','Upload is already '+row.status+'.');
 const reasons=[];
 const actual=createHash('sha256').update(bytes).digest('hex');
 if(actual!==row.sha256)reasons.push('checksum mismatch');
 if(bytes.length!==Number(row.byte_count))reasons.push('size mismatch');
 if(!sniffedMatches(row.mime,bytes))reasons.push('content does not match declared type '+row.mime);
 if(reasons.length){
  const rejected=(await tx.query("update lara.evidence set status='rejected',rejection_reason=$2 where id=$1 returning *",[id,reasons.join('; ')])).rows[0];
  await audit(tx,ctx,{entityId,action:'evidence.reject',resourceType:'evidence',resourceId:id,resourceVersion:Number(rejected.version),reason:reasons.join('; ')});
  // The rejection is the committed effect of this command; the API layer
  // reports it as a typed failure after commit so a retry shows the same result.
  return {outcome:'rejected',reasons,evidence:evidenceResource(rejected)};
 }
 await store.put(row.object_key,bytes);
 const scanning=(await tx.query("update lara.evidence set status='scanning' where id=$1 returning *",[id])).rows[0];
 const job=await enqueueJob(tx,ctx,{entityId,kind:'evidence.scan',payload:{evidenceId:id,objectKey:row.object_key}});
 await audit(tx,ctx,{entityId,action:'evidence.complete',resourceType:'evidence',resourceId:id,resourceVersion:Number(scanning.version)});
 return {outcome:'scanning',job:{id:job.id,state:job.state,statusUrl:'/v1/jobs/'+job.id,traceId:ctx.traceId||'',resultResourceType:'evidence',resultResourceId:id},evidence:evidenceResource(scanning)};
}

// 3. Scan outcome, executed by the worker holding the job. Infected or
// unreadable content is rejected and the stored object disposed.
export async function recordScan(tx,ctx,entityId,id,scanner,store){
 const row=(await tx.query('select * from lara.evidence where tenant_id=$1 and entity_id=$2 and id=$3 for update',[ctx.tenantId,entityId,id])).rows[0];
 if(!row)fail('NOT_FOUND','Evidence not found.');
 if(row.status!=='scanning')fail('STATE_CONFLICT','Evidence is '+row.status+', not scanning.');
 const bytes=await store.get(row.object_key);
 const result=await scanner.scan(bytes);
 if(!result.clean){
  await store.dispose(row.object_key);
  const rejected=(await tx.query("update lara.evidence set status='rejected',rejection_reason=$2 where id=$1 returning *",[id,'Scan failed: '+result.reason])).rows[0];
  await audit(tx,ctx,{entityId,action:'evidence.reject',resourceType:'evidence',resourceId:id,resourceVersion:Number(rejected.version),reason:result.reason});
  return evidenceResource(rejected);
 }
 const available=(await tx.query("update lara.evidence set status='available' where id=$1 returning *",[id])).rows[0];
 await audit(tx,ctx,{entityId,action:'evidence.available',resourceType:'evidence',resourceId:id,resourceVersion:Number(available.version)});
 await emit(tx,ctx,{entityId,aggregateType:'evidence',aggregateId:id,aggregateVersion:Number(available.version),eventType:'evidence.available.v1',payload:{evidenceId:id}});
 return evidenceResource(available);
}

export async function getEvidence(tx,ctx,entityId,id){
 requirePermission(ctx,'evidence.read');requireEntity(ctx,entityId);
 const row=(await tx.query('select * from lara.evidence where tenant_id=$1 and entity_id=$2 and id=$3',[ctx.tenantId,entityId,id])).rows[0];
 if(!row)fail('NOT_FOUND','Evidence not found.');
 return evidenceResource(row);
}
// Content downloads recheck membership on every request and stream through
// the API; quarantined or rejected content is never served.
export async function readContent(tx,ctx,entityId,id,store){
 const e=await getEvidence(tx,ctx,entityId,id);
 if(e.state!=='available')fail('EVIDENCE_NOT_READY','Evidence is '+e.state+'.');
 const row=(await tx.query('select object_key from lara.evidence where tenant_id=$1 and id=$2',[ctx.tenantId,id])).rows[0];
 await audit(tx,ctx,{entityId,action:'evidence.download',resourceType:'evidence',resourceId:id,resourceVersion:e.version});
 return {evidence:e,bytes:await store.get(row.object_key)};
}
export async function listEvidence(tx,ctx,entityId,query){
 requirePermission(ctx,'evidence.read');requireEntity(ctx,entityId);const {limit,after}=pageArgs(query);
 const params=[ctx.tenantId,entityId,limit+1];let where='';
 if(query?.status){params.push(String(query.status));where=' and status=$'+params.length;}
 const rows=(await tx.query('select * from lara.evidence where tenant_id=$1 and entity_id=$2'+where+cursorClause(after,params)+' order by created_at,id limit $3',params)).rows;
 return page(rows,limit,evidenceResource);
}
// Link available evidence to a resource version; the caller has already
// authorized the target resource.
export async function linkEvidence(tx,ctx,entityId,evidenceIds,resourceType,resourceId,resourceVersion){
 if(!evidenceIds?.length)return 0;
 const available=(await tx.query("select id from lara.evidence where tenant_id=$1 and entity_id=$2 and id=any($3::uuid[]) and status='available'",[ctx.tenantId,entityId,evidenceIds])).rows.map(r=>r.id);
 const missing=evidenceIds.filter(id=>!available.includes(id));
 if(missing.length)fail('EVIDENCE_NOT_READY','Evidence is not available: '+missing.join(', ')+'.');
 for(const id of available)await tx.query('insert into lara.evidence_links(tenant_id,entity_id,evidence_id,resource_type,resource_id,resource_version,created_by) values($1,$2,$3,$4,$5,$6,$7) on conflict do nothing',[ctx.tenantId,entityId,id,resourceType,resourceId,resourceVersion,ctx.principalId]);
 return available.length;
}
