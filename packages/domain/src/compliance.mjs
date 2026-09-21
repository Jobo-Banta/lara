// Compliance module (P07): regulatory profiles and reviewed schema artifacts
// (form mappings imported as evidence, never guessed), return runs computed
// deterministically from tax events at a frozen cutoff with source links and
// a tie-out (replay reproduces the hash), filing evidence recorded separately
// from preparation, e-invoice transmissions with immutable signed payloads,
// append-only attempts and status reconciliation before any resend, and
// registration packs that never stand for the authority's decision.
import {createHash,createHmac} from 'node:crypto';
import {assertInput,audit,contentHash,cursorClause,cursorScope,emit,enqueueJob,expectVersion,fail,isUuid,iso,page,pageArgs,requirePermission,requireEntity,resource} from './core.mjs';
import {linkEvidence} from './evidence.mjs';
import {micros,decimal} from './ledger.mjs';

const sha=b=>createHash('sha256').update(b).digest('hex');
const money=v=>decimal(micros(String(v)),2);
const signedMicros=v=>{const s=String(v);return s.startsWith('-')?-micros(s.slice(1)):micros(s);};
const SOURCE_QUERY_VERSION='tax-events-1';

// ---------------------------------------------------------------------------
// Capability and profile
// ---------------------------------------------------------------------------
export async function requireCompliance(tx,ctx,entityId){
 const active=(await tx.query("select 1 from lara.capability_activations where tenant_id=$1 and entity_id=$2 and capability='compliance' and status='active'",[ctx.tenantId,entityId])).rowCount;
 if(!active)fail('FEATURE_NOT_ENABLED','The compliance capability is not active for this entity.');
}
// The approved compliance profile: taxpayer identity, transport destination,
// the deadline the profile (not this code) sets, key and credential references
// resolved from the deployment environment, and the document kinds reported.
export async function complianceProfile(tx,ctx,entityId){
 const row=(await tx.query("select payload from lara.settings_versions where tenant_id=$1 and entity_id=$2 and kind='compliance_profile' and status='approved' order by version_number desc limit 1",[ctx.tenantId,entityId])).rows[0];
 if(!row)fail('RULE_PROFILE_NOT_APPROVED','An approved compliance profile (taxpayer identity, transport, deadline, key and credential references) is required.');
 const p=row.payload;
 if(typeof p.taxpayerId!=='string'||!p.taxpayerId.trim())fail('RULE_PROFILE_NOT_APPROVED','The compliance profile lacks the taxpayer identifier.');
 return {jurisdiction:typeof p.jurisdiction==='string'?p.jurisdiction:'PH',taxpayerId:p.taxpayerId.trim(),transport:typeof p.transport==='string'?p.transport:'fixture',destination:typeof p.destination==='string'&&p.destination?p.destination:'fixture-authority',deadlineHours:Number.isInteger(p.deadlineHours)?p.deadlineHours:null,signingKeyRef:typeof p.signingKeyRef==='string'?p.signingKeyRef:'EINVOICE_SIGNING_KEY',credentialsRef:typeof p.credentialsRef==='string'?p.credentialsRef:'EINVOICE_CREDENTIALS',reportedKinds:Array.isArray(p.reportedKinds)?p.reportedKinds:['invoice','credit_note'],profileVersion:typeof p.profileVersion==='string'&&p.profileVersion?p.profileVersion:'compliance-1'};
}

// ---------------------------------------------------------------------------
// Regulatory profiles and schema artifacts
// ---------------------------------------------------------------------------
const profileResource=r=>({id:r.id,version:Number(r.version),contentVersion:Number(r.content_version),state:r.status,jurisdiction:r.jurisdiction,versionNumber:r.version_number,coverage:r.coverage,validFrom:iso(r.valid_from),validTo:iso(r.valid_to),sourceHash:r.source_hash,evidenceIds:r.evidence_ids,approvedBy:r.approved_by,activatedAt:iso(r.activated_at),createdAt:iso(r.created_at),updatedAt:iso(r.updated_at),simulation:false});
export async function createRegulatoryProfile(tx,ctx,entityId,{jurisdiction='PH',coverage,validFrom,validTo=null,evidenceIds}){
 requirePermission(ctx,'return.edit');requireEntity(ctx,entityId);await requireCompliance(tx,ctx,entityId);
 if(!/^[A-Z]{2}$/.test(jurisdiction||''))fail('VALIDATION_FAILED','jurisdiction is a two-letter code.',{fieldErrors:[{path:'jurisdiction',message:'Invalid'}]});
 if(!Array.isArray(coverage)||!coverage.length||coverage.some(c=>!/^[A-Z0-9][A-Z0-9._-]{0,31}$/.test(c)))fail('VALIDATION_FAILED','coverage lists the enabled form codes.',{fieldErrors:[{path:'coverage',message:'Form codes'}]});
 if(!/^\d{4}-\d{2}-\d{2}$/.test(validFrom||''))fail('VALIDATION_FAILED','validFrom is a date.',{fieldErrors:[{path:'validFrom',message:'Date'}]});
 if(!Array.isArray(evidenceIds)||!evidenceIds.length)fail('VALIDATION_FAILED','A regulatory profile cites its source evidence.',{fieldErrors:[{path:'evidenceIds',message:'Required'}]});
 await linkEvidence(tx,ctx,entityId,evidenceIds,'regulatory_profile',entityId,1);
 const m={jurisdiction,coverage:[...coverage].sort(),validFrom,validTo,evidenceIds:[...evidenceIds].sort()};
 const next=((await tx.query('select coalesce(max(version_number),0)::int v from lara.regulatory_profiles where tenant_id=$1 and entity_id=$2 and jurisdiction=$3',[ctx.tenantId,entityId,jurisdiction])).rows[0].v)+1;
 const row=(await tx.query('insert into lara.regulatory_profiles(tenant_id,entity_id,jurisdiction,version_number,coverage,valid_from,valid_to,source_hash,evidence_ids,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *',[ctx.tenantId,entityId,jurisdiction,next,JSON.stringify(m.coverage),validFrom,validTo,contentHash(m),JSON.stringify(m.evidenceIds),ctx.principalId])).rows[0];
 await audit(tx,ctx,{entityId,action:'regulatory_profile.create',resourceType:'regulatory_profile',resourceId:row.id,resourceVersion:1,afterRef:row.source_hash});
 return profileResource(row);
}
export async function approveRegulatoryProfile(tx,ctx,entityId,id,{decision='approve',reason=null}={}){
 requirePermission(ctx,'return.approve');requireEntity(ctx,entityId);
 const row=(await tx.query('select * from lara.regulatory_profiles where tenant_id=$1 and entity_id=$2 and id=$3 for update',[ctx.tenantId,entityId,id])).rows[0];
 if(!row)fail('NOT_FOUND','Regulatory profile not found.');
 if(row.status!=='draft')fail('STATE_CONFLICT','Regulatory profile is '+row.status+'.');
 if(row.created_by===ctx.principalId)fail('SELF_APPROVAL','The profile author cannot approve it.');
 if(decision==='reject'&&!reason)fail('VALIDATION_FAILED','Rejection requires a reason.',{fieldErrors:[{path:'reason',message:'Required'}]});
 const updated=(await tx.query('update lara.regulatory_profiles set status=$3,approved_by=$4 where tenant_id=$1 and id=$2 returning *',[ctx.tenantId,id,decision==='approve'?'approved':'rejected',decision==='approve'?ctx.principalId:null])).rows[0];
 await audit(tx,ctx,{entityId,action:'regulatory_profile.'+decision,resourceType:'regulatory_profile',resourceId:id,resourceVersion:Number(updated.version),reason,afterRef:row.source_hash});
 return profileResource(updated);
}
// Activation supersedes the active profile of the jurisdiction; the activator is neither the author nor... the same as the approver is allowed, the author is not.
export async function activateRegulatoryProfile(tx,ctx,entityId,id,{reason}){
 requirePermission(ctx,'return.approve');requireEntity(ctx,entityId);
 const row=(await tx.query('select * from lara.regulatory_profiles where tenant_id=$1 and entity_id=$2 and id=$3 for update',[ctx.tenantId,entityId,id])).rows[0];
 if(!row)fail('NOT_FOUND','Regulatory profile not found.');
 if(row.status!=='approved')fail('STATE_CONFLICT','Only approved profiles activate.');
 if(row.created_by===ctx.principalId)fail('SELF_APPROVAL','The profile author cannot activate it.');
 await tx.query("update lara.regulatory_profiles set status='superseded' where tenant_id=$1 and entity_id=$2 and jurisdiction=$3 and status='active'",[ctx.tenantId,entityId,row.jurisdiction]);
 const updated=(await tx.query("update lara.regulatory_profiles set status='active',activated_by=$3,activated_at=now() where tenant_id=$1 and id=$2 returning *",[ctx.tenantId,id,ctx.principalId])).rows[0];
 await audit(tx,ctx,{entityId,action:'regulatory_profile.activate',resourceType:'regulatory_profile',resourceId:id,resourceVersion:Number(updated.version),reason:reason||null,afterRef:row.source_hash});
 await emit(tx,ctx,{entityId,aggregateType:'regulatory_profile',aggregateId:id,aggregateVersion:Number(updated.version),eventType:'rule.activated.v1',payload:{ruleProfileId:id,version:row.version_number,effectiveFrom:iso(row.valid_from)}});
 return profileResource(updated);
}
export async function listRegulatoryProfiles(tx,ctx,entityId){requirePermission(ctx,'return.read');requireEntity(ctx,entityId);return (await tx.query('select * from lara.regulatory_profiles where tenant_id=$1 and entity_id=$2 order by jurisdiction,version_number',[ctx.tenantId,entityId])).rows.map(profileResource);}
async function activeProfile(tx,ctx,entityId,{jurisdiction='PH',onDate}){
 const row=(await tx.query("select * from lara.regulatory_profiles where tenant_id=$1 and entity_id=$2 and jurisdiction=$3 and status='active'",[ctx.tenantId,entityId,jurisdiction])).rows[0];
 if(!row)fail('RULE_PROFILE_NOT_APPROVED','No active regulatory profile for '+jurisdiction+'; the tax lead approves and activates the current official artifacts first.');
 if(onDate&&(iso(row.valid_from)>onDate||(row.valid_to&&iso(row.valid_to)<onDate)))fail('RULE_PROFILE_NOT_APPROVED','The active regulatory profile is not valid on '+onDate+' (expired or not yet effective).');
 return row;
}
const artifactResource=a=>({id:a.id,version:Number(a.version),state:a.status,profileId:a.profile_id,artifactType:a.artifact_type,code:a.code,versionLabel:a.version_label,hash:a.hash,evidenceId:a.evidence_id,goldenCaseIds:a.golden_case_ids,approvedBy:a.approved_by,createdAt:iso(a.created_at),simulation:false});
export async function importArtifact(tx,ctx,entityId,{profileId,artifactType,code,versionLabel,evidenceId,goldenCaseIds=[]}){
 requirePermission(ctx,'return.edit');requireEntity(ctx,entityId);await requireCompliance(tx,ctx,entityId);
 const profile=(await tx.query('select * from lara.regulatory_profiles where tenant_id=$1 and entity_id=$2 and id=$3',[ctx.tenantId,entityId,profileId])).rows[0];
 if(!profile)fail('NOT_FOUND','Regulatory profile not found.');
 if(!['form_mapping','einvoice_schema','certificate_layout'].includes(artifactType))fail('VALIDATION_FAILED','artifactType is form_mapping, einvoice_schema or certificate_layout.',{fieldErrors:[{path:'artifactType',message:'Invalid'}]});
 const ev=(await tx.query("select * from lara.evidence where tenant_id=$1 and entity_id=$2 and id=$3",[ctx.tenantId,entityId,evidenceId])).rows[0];
 if(!ev)fail('NOT_FOUND','Evidence not found.');
 if(ev.status!=='available')fail('EVIDENCE_NOT_READY','The artifact evidence must be available.');
 if(artifactType==='form_mapping'&&ev.mime!=='text/csv')fail('VALIDATION_FAILED','Form mappings are imported as CSV evidence.',{fieldErrors:[{path:'evidenceId',message:'CSV required'}]});
 if(!/^[A-Z0-9][A-Z0-9._-]{0,31}$/.test(code||''))fail('VALIDATION_FAILED','code uses letters, digits, dots, underscores and hyphens.',{fieldErrors:[{path:'code',message:'Invalid'}]});
 const row=(await tx.query('insert into lara.schema_artifacts(tenant_id,entity_id,profile_id,artifact_type,code,version_label,hash,evidence_id,golden_case_ids,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *',[ctx.tenantId,entityId,profileId,artifactType,code,String(versionLabel||'').trim()||'1',ev.sha256,evidenceId,JSON.stringify([...goldenCaseIds].sort()),ctx.principalId])).rows[0];
 await audit(tx,ctx,{entityId,action:'schema_artifact.import',resourceType:'schema_artifact',resourceId:row.id,resourceVersion:1,afterRef:ev.sha256});
 return artifactResource(row);
}
export async function approveArtifact(tx,ctx,entityId,id,{reason=null}={}){
 requirePermission(ctx,'return.approve');requireEntity(ctx,entityId);
 const row=(await tx.query('select * from lara.schema_artifacts where tenant_id=$1 and entity_id=$2 and id=$3 for update',[ctx.tenantId,entityId,id])).rows[0];
 if(!row)fail('NOT_FOUND','Artifact not found.');
 if(row.status!=='draft')fail('STATE_CONFLICT','Artifact is '+row.status+'.');
 if(row.created_by===ctx.principalId)fail('SELF_APPROVAL','The importer cannot approve the artifact.');
 await tx.query("update lara.schema_artifacts set status='superseded' where tenant_id=$1 and profile_id=$2 and artifact_type=$3 and code=$4 and status='approved'",[ctx.tenantId,row.profile_id,row.artifact_type,row.code]);
 const updated=(await tx.query("update lara.schema_artifacts set status='approved',approved_by=$3 where tenant_id=$1 and id=$2 returning *",[ctx.tenantId,id,ctx.principalId])).rows[0];
 await audit(tx,ctx,{entityId,action:'schema_artifact.approve',resourceType:'schema_artifact',resourceId:id,resourceVersion:Number(updated.version),reason,afterRef:row.hash});
 return artifactResource(updated);
}
export async function listArtifacts(tx,ctx,entityId,{profileId=null}={}){requirePermission(ctx,'return.read');requireEntity(ctx,entityId);const params=[ctx.tenantId,entityId];const where=profileId?' and profile_id=$'+params.push(profileId):'';return (await tx.query('select * from lara.schema_artifacts where tenant_id=$1 and entity_id=$2'+where+' order by artifact_type,code,created_at',params)).rows.map(artifactResource);}

// Form mapping CSV contract: line_code, description, family (sales |
// purchases | withholding), tax_type, recognition (issue | accrual | payment
// | any), kinds (pipe-separated document kinds or any), measure (basis |
// amount), sign (1 | -1). Every line maps a set of tax events; an event the
// period holds that no line maps blocks preparation.
export function parseMappingCsv(text){
 const lines=text.replace(/\r\n/g,'\n').split('\n').filter(l=>l.trim());
 if(lines.length<2)fail('VALIDATION_FAILED','The mapping CSV needs a header and at least one line.');
 const cells=l=>{const out=[];let cur='',q=false;for(let i=0;i<l.length;i++){const ch=l[i];if(q){if(ch==='"'&&l[i+1]==='"'){cur+='"';i++;}else if(ch==='"')q=false;else cur+=ch;}else if(ch==='"')q=true;else if(ch===','){out.push(cur);cur='';}else cur+=ch;}out.push(cur);return out.map(c=>c.trim());};
 const header=cells(lines[0]).map(h=>h.toLowerCase());
 for(const r of ['line_code','description','family','tax_type','recognition','kinds','measure','sign'])if(!header.includes(r))fail('VALIDATION_FAILED','Mapping CSV header lacks '+r+'.',{fieldErrors:[{path:'header',message:'Missing '+r}]});
 return lines.slice(1).map((l,i)=>{const c=cells(l);const row={};header.forEach((h,j)=>{row[h]=c[j]??'';});
  if(!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(row.line_code))fail('VALIDATION_FAILED','Mapping row '+(i+1)+' has an invalid line code.',{fieldErrors:[{path:'rows.'+(i+1),message:'line_code'}]});
  if(!['sales','purchases','withholding'].includes(row.family))fail('VALIDATION_FAILED','Mapping row '+(i+1)+': family is sales, purchases or withholding.',{fieldErrors:[{path:'rows.'+(i+1),message:'family'}]});
  if(!['basis','amount'].includes(row.measure))fail('VALIDATION_FAILED','Mapping row '+(i+1)+': measure is basis or amount.',{fieldErrors:[{path:'rows.'+(i+1),message:'measure'}]});
  if(!['1','-1'].includes(row.sign))fail('VALIDATION_FAILED','Mapping row '+(i+1)+': sign is 1 or -1.',{fieldErrors:[{path:'rows.'+(i+1),message:'sign'}]});
  return {lineCode:row.line_code,description:row.description||row.line_code,family:row.family,taxType:row.tax_type.toLowerCase(),recognition:row.recognition.toLowerCase()||'any',kinds:row.kinds?row.kinds.toLowerCase().split('|').map(k=>k.trim()).filter(Boolean):['any'],measure:row.measure,sign:row.sign==='-1'?-1n:1n};});
}
const familyOf=e=>e.tax_type==='withholding'&&e.line_id===null?'withholding':['invoice'].includes(e.kind)||(e.kind==='credit_note'&&e.source_kind!=='bill')?'sales':'purchases';
const matches=(line,e)=>line.family===familyOf(e)&&line.taxType===e.tax_type&&(line.recognition==='any'||line.recognition===e.recognition)&&(line.kinds.includes('any')||line.kinds.includes(e.kind));

// ---------------------------------------------------------------------------
// Return runs
// ---------------------------------------------------------------------------
const returnResource=r=>resource({...r,status:r.state},{formCode:r.form_code,periodStart:iso(r.period_start),periodEnd:iso(r.period_end),profileVersion:r.profile_version,dataCutoff:iso(r.data_cutoff)});
export async function createReturn(tx,ctx,entityId,input,{supersedesId=null}={}){
 requirePermission(ctx,'return.create');requireEntity(ctx,entityId);assertInput('ReturnCreate',input);await requireCompliance(tx,ctx,entityId);
 if(input.periodEnd<input.periodStart)fail('VALIDATION_FAILED','periodEnd precedes periodStart.',{fieldErrors:[{path:'periodEnd',message:'Before start'}]});
 if(!/^[A-Z0-9][A-Z0-9._-]{0,31}$/.test(input.formCode))fail('VALIDATION_FAILED','formCode uses letters, digits, dots, underscores and hyphens.',{fieldErrors:[{path:'formCode',message:'Invalid'}]});
 if(supersedesId){const prior=(await tx.query("select state from lara.return_runs where tenant_id=$1 and entity_id=$2 and id=$3",[ctx.tenantId,entityId,supersedesId])).rows[0];if(!prior||!['approved','filed'].includes(prior.state))fail('STATE_CONFLICT','A correction links to an approved or filed run.');}
 const row=(await tx.query('insert into lara.return_runs(tenant_id,entity_id,form_code,period_start,period_end,profile_version,data_cutoff,supersedes_id,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *',[ctx.tenantId,entityId,input.formCode,input.periodStart,input.periodEnd,input.profileVersion.trim(),input.dataCutoff,supersedesId,ctx.principalId])).rows[0];
 await audit(tx,ctx,{entityId,action:'return.create',resourceType:'return',resourceId:row.id,resourceVersion:1});
 return returnResource(row);
}
async function loadReturn(tx,ctx,entityId,id,{lock=true}={}){if(!isUuid(id))fail('NOT_FOUND','Return not found.');const row=(await tx.query('select * from lara.return_runs where tenant_id=$1 and entity_id=$2 and id=$3'+(lock?' for update':''),[ctx.tenantId,entityId,id])).rows[0];if(!row)fail('NOT_FOUND','Return not found.');return row;}
export async function updateReturn(tx,ctx,entityId,id,expectedVersion,input){
 requirePermission(ctx,'return.edit');requireEntity(ctx,entityId);assertInput('ReturnCreate',input);
 const row=await loadReturn(tx,ctx,entityId,id);expectVersion(row,expectedVersion);
 if(row.state!=='draft')fail('STATE_CONFLICT','Prepared returns are frozen at their cutoff; reject to draft to change the parameters.');
 const updated=(await tx.query('update lara.return_runs set form_code=$3,period_start=$4,period_end=$5,profile_version=$6,data_cutoff=$7,content_version=content_version+1 where tenant_id=$1 and id=$2 returning *',[ctx.tenantId,id,input.formCode,input.periodStart,input.periodEnd,input.profileVersion.trim(),input.dataCutoff])).rows[0];
 await audit(tx,ctx,{entityId,action:'return.edit',resourceType:'return',resourceId:id,resourceVersion:Number(updated.version)});
 return returnResource(updated);
}
const rresult=(row,extra={})=>({resourceType:'return',resourceId:row.id,version:Number(row.version),state:row.state,...extra});
// Preparation freezes the cutoff and computes every line from the tax events
// of the period recorded on or before the cutoff, through the approved
// mapping artifact of the active profile. Unmapped events block; the lines,
// links and tie-out are written and the snapshot hash identifies the result.
export async function prepareReturn(tx,ctx,entityId,id,input,expectedVersion,{store}){
 requirePermission(ctx,'return.prepare');requireEntity(ctx,entityId);assertInput('Action',input||{});
 const row=await loadReturn(tx,ctx,entityId,id);if(expectedVersion!==undefined)expectVersion(row,expectedVersion);
 if(!['draft','prepared'].includes(row.state))fail('STATE_CONFLICT','Return is '+row.state+'.');
 const profile=await activeProfile(tx,ctx,entityId,{onDate:iso(row.period_end)});
 if(!profile.coverage.includes(row.form_code))fail('RULE_PROFILE_NOT_APPROVED','Form '+row.form_code+' is not in the active profile coverage.');
 const artifact=(await tx.query("select a.*,e.object_key from lara.schema_artifacts a join lara.evidence e on e.tenant_id=a.tenant_id and e.id=a.evidence_id where a.tenant_id=$1 and a.profile_id=$2 and a.artifact_type='form_mapping' and a.code=$3 and a.status='approved'",[ctx.tenantId,profile.id,row.form_code])).rows[0];
 if(!artifact)fail('RULE_PROFILE_NOT_APPROVED','No approved form mapping artifact for '+row.form_code+' under the active profile.');
 const bytes=await store.get(artifact.object_key);
 if(sha(bytes)!==artifact.hash)fail('STATE_CONFLICT','The mapping evidence no longer matches the reviewed artifact hash.');
 const mapping=parseMappingCsv(bytes.toString('utf8'));
 const events=(await tx.query("select e.*,d.kind,s.kind as source_kind,r.tax_type from lara.tax_events e join lara.documents d on d.tenant_id=e.tenant_id and d.id=e.document_id left join lara.documents s on s.tenant_id=d.tenant_id and s.id=d.source_document_id join lara.tax_rule_versions r on r.tenant_id=e.tenant_id and r.id=e.tax_rule_version_id where e.tenant_id=$1 and e.entity_id=$2 and e.tax_point between $3::date and $4::date and e.created_at<=$5::timestamptz and e.reversed_by is null and not exists (select 1 from lara.tax_events o where o.tenant_id=e.tenant_id and o.reversed_by=e.id) order by e.tax_point,e.created_at,e.id",[ctx.tenantId,entityId,iso(row.period_start),iso(row.period_end),iso(row.data_cutoff)])).rows;
 const lines=new Map(mapping.map(m=>[m.lineCode,{...m,basis:0n,amount:0n,count:0,links:[]}]));
 const unmapped=[];
 for(const e of events){
  const hit=mapping.filter(m=>matches(m,e));
  if(!hit.length){unmapped.push(e);continue;}
  const creditSign=e.kind==='credit_note'?-1n:1n;
  for(const m of hit){const l=lines.get(m.lineCode);l.basis+=m.sign*creditSign*micros(String(e.basis));l.amount+=m.sign*creditSign*micros(String(e.amount));l.count++;l.links.push({eventId:e.id,sign:Number(m.sign*creditSign)});}
 }
 if(unmapped.length)fail('STATE_CONFLICT','No mapping line covers '+unmapped.length+' tax event(s) in the period ('+[...new Set(unmapped.map(e=>familyOf(e)+'/'+e.tax_type+'/'+e.recognition+'/'+e.kind))].join(', ')+'); a missing mapping never produces a plausible zero.');
 const family=[...new Set(mapping.map(m=>m.family))];
 // Ledger tie: VAT forms tie the source amount to the control-account movement of the period through the recognition entries.
 let ledger=null;
 if(mapping.some(m=>m.taxType==='vat')){
  const ids=[...new Set(events.filter(e=>e.tax_type==='vat'&&e.recognition_entry_id).map(e=>e.recognition_entry_id))];
  const r=ids.length?(await tx.query("select coalesce(sum(case when a.control_type='output_tax' then l.txn_credit-l.txn_debit else l.txn_debit-l.txn_credit end),0)::text as movement from lara.journal_lines l join lara.accounts a on a.tenant_id=l.tenant_id and a.id=l.account_id where l.tenant_id=$1 and l.entry_id=any($2::uuid[]) and a.control_type in ('output_tax','input_tax')",[ctx.tenantId,ids])).rows[0]:{movement:'0'};
  ledger=signedMicros(r.movement);
 }
 const sourceBasis=events.reduce((t,e)=>t+(e.kind==='credit_note'?-1n:1n)*micros(String(e.basis)),0n),sourceAmount=events.reduce((t,e)=>t+(e.kind==='credit_note'?-1n:1n)*micros(String(e.amount)),0n);
 const vatAmount=events.filter(e=>e.tax_type==='vat').reduce((t,e)=>t+(e.kind==='credit_note'?-1n:1n)*micros(String(e.amount)),0n);
 const out=[...lines.values()].map(l=>({lineCode:l.lineCode,description:l.description,basis:decimal(l.basis),amount:decimal(l.amount),eventCount:l.count}));
 const totalBasis=[...lines.values()].reduce((t,l)=>t+l.basis,0n),totalAmount=[...lines.values()].reduce((t,l)=>t+l.amount,0n);
 const tieOut={events:events.length,sourceBasis:decimal(sourceBasis),sourceAmount:decimal(sourceAmount),returnBasis:decimal(totalBasis),returnAmount:decimal(totalAmount),ledgerTaxMovement:ledger===null?null:decimal(ledger),ties:ledger===null?true:ledger===vatAmount,family,sourceQueryVersion:SOURCE_QUERY_VERSION,artifactHash:artifact.hash,profileId:profile.id};
 const snapshotHash=contentHash({formCode:row.form_code,periodStart:iso(row.period_start),periodEnd:iso(row.period_end),dataCutoff:iso(row.data_cutoff),profileVersion:row.profile_version,artifactHash:artifact.hash,lines:out});
 await tx.query('delete from lara.return_source_links where tenant_id=$1 and run_id=$2',[ctx.tenantId,id]);
 await tx.query('delete from lara.return_lines where tenant_id=$1 and run_id=$2',[ctx.tenantId,id]);
 for(const l of lines.values()){
  await tx.query('insert into lara.return_lines(tenant_id,run_id,line_code,description,basis,amount,source_query_version,event_count) values($1,$2,$3,$4,$5,$6,$7,$8)',[ctx.tenantId,id,l.lineCode,l.description.slice(0,500),decimal(l.basis,6),decimal(l.amount,6),SOURCE_QUERY_VERSION,l.count]);
  for(const k of l.links)await tx.query('insert into lara.return_source_links(tenant_id,run_id,tax_event_id,line_code,sign) values($1,$2,$3,$4,$5) on conflict do nothing',[ctx.tenantId,id,k.eventId,l.lineCode,k.sign]);
 }
 const updated=(await tx.query("update lara.return_runs set state='prepared',regulatory_profile_id=$3,artifact_id=$4,snapshot_hash=$5,tie_out=$6,line_count=$7,total_basis=$8,total_amount=$9,prepared_by=$10,content_version=content_version+1 where tenant_id=$1 and id=$2 returning *",[ctx.tenantId,id,profile.id,artifact.id,snapshotHash,JSON.stringify(tieOut),out.length,decimal(totalBasis,6),decimal(totalAmount,6),ctx.principalId])).rows[0];
 await audit(tx,ctx,{entityId,action:'return.prepare',resourceType:'return',resourceId:id,resourceVersion:Number(updated.version),afterRef:snapshotHash,reason:tieOut.ties?'ties':'ledger movement '+tieOut.ledgerTaxMovement+' differs from source '+decimal(vatAmount)});
 return rresult(updated,{snapshotHash,lines:out.length,tieOut});
}
export async function approveReturn(tx,ctx,entityId,id,input,expectedVersion){
 requirePermission(ctx,'return.approve');requireEntity(ctx,entityId);assertInput('ApprovalDecision',input);
 const row=await loadReturn(tx,ctx,entityId,id);if(expectedVersion!==undefined)expectVersion(row,expectedVersion);
 if(row.state!=='prepared')fail('STATE_CONFLICT','Only prepared returns are decided.');
 if(row.created_by===ctx.principalId||row.prepared_by===ctx.principalId)fail('SELF_APPROVAL','The preparer cannot approve the return.');
 if(Number(row.content_version)!==input.contentVersion)fail('VERSION_CONFLICT','The return changed since review.',{resourceVersion:Number(row.version)});
 if(input.decision==='reject'&&!input.reason)fail('VALIDATION_FAILED','Rejection requires a reason.',{fieldErrors:[{path:'reason',message:'Required'}]});
 if(input.decision==='approve'&&row.tie_out?.ties===false&&!input.reason)fail('VALIDATION_FAILED','The return does not tie to the ledger; approval needs a reason recording the reviewed difference.',{fieldErrors:[{path:'reason',message:'Tie-out difference'}]});
 const updated=(await tx.query('update lara.return_runs set state=$3,approved_by=$4 where tenant_id=$1 and id=$2 returning *',[ctx.tenantId,id,input.decision==='approve'?'approved':'draft',input.decision==='approve'?ctx.principalId:null])).rows[0];
 await audit(tx,ctx,{entityId,action:'return.'+input.decision,resourceType:'return',resourceId:id,resourceVersion:Number(updated.version),reason:input.reason||null,afterRef:row.snapshot_hash});
 return rresult(updated);
}
// Filing is recorded from the authority's acknowledgement with evidence; the
// prepared pack never counts as filed. A filed run supersedes the run it corrects.
export async function fileReturn(tx,ctx,entityId,id,input,expectedVersion){
 requirePermission(ctx,'return.filed');requireEntity(ctx,entityId);assertInput('FilingEvidence',input);
 const row=await loadReturn(tx,ctx,entityId,id);if(expectedVersion!==undefined)expectVersion(row,expectedVersion);
 if(row.state==='filed')return rresult(row);
 if(row.state!=='approved')fail('STATE_CONFLICT','Only approved returns are recorded as filed.');
 await linkEvidence(tx,ctx,entityId,input.evidenceIds,'return',id,Number(row.version)+1);
 await tx.query('insert into lara.filing_records(tenant_id,run_id,external_reference,filed_at,evidence_ids,recorded_by) values($1,$2,$3,$4,$5,$6)',[ctx.tenantId,id,input.externalReference.trim(),input.filedAt,JSON.stringify([...input.evidenceIds].sort()),ctx.principalId]);
 if(row.supersedes_id)await tx.query("update lara.return_runs set state='superseded' where tenant_id=$1 and id=$2 and state in ('approved','filed')",[ctx.tenantId,row.supersedes_id]);
 const updated=(await tx.query("update lara.return_runs set state='filed' where tenant_id=$1 and id=$2 returning *",[ctx.tenantId,id])).rows[0];
 await audit(tx,ctx,{entityId,action:'return.filed',resourceType:'return',resourceId:id,resourceVersion:Number(updated.version),afterRef:input.externalReference.trim()});
 return rresult(updated);
}
export async function getReturn(tx,ctx,entityId,id){requirePermission(ctx,'return.read');requireEntity(ctx,entityId);return returnResource(await loadReturn(tx,ctx,entityId,id,{lock:false}));}
export async function listReturns(tx,ctx,entityId,query){
 requirePermission(ctx,'return.read');requireEntity(ctx,entityId);
 const scope=cursorScope(ctx,entityId,query||{});const {limit,after}=pageArgs(query,scope);const params=[ctx.tenantId,entityId,limit+1];
 let where='';if(query?.state)where+=' and state=$'+params.push(String(query.state));if(query?.formCode)where+=' and form_code=$'+params.push(String(query.formCode));
 const rows=(await tx.query('select * from lara.return_runs where tenant_id=$1 and entity_id=$2'+where+cursorClause(after,params)+' order by created_at,id limit $3',params)).rows;
 return page(rows,limit,returnResource,scope);
}
export async function returnLines(tx,ctx,entityId,id){
 requirePermission(ctx,'return.read');requireEntity(ctx,entityId);
 const row=await loadReturn(tx,ctx,entityId,id,{lock:false});
 const lines=(await tx.query('select * from lara.return_lines where tenant_id=$1 and run_id=$2 order by line_code',[ctx.tenantId,id])).rows.map(l=>({lineCode:l.line_code,description:l.description,basis:decimal(signedMicros(l.basis)),amount:decimal(signedMicros(l.amount)),eventCount:l.event_count,sourceQueryVersion:l.source_query_version}));
 const filing=(await tx.query('select * from lara.filing_records where tenant_id=$1 and run_id=$2',[ctx.tenantId,id])).rows[0];
 return {returnId:id,state:row.state,snapshotHash:row.snapshot_hash,tieOut:row.tie_out,totalBasis:decimal(signedMicros(row.total_basis)),totalAmount:decimal(signedMicros(row.total_amount)),lines,filing:filing?{externalReference:filing.external_reference,filedAt:iso(filing.filed_at),evidenceIds:filing.evidence_ids}:null};
}
export async function returnDrillDown(tx,ctx,entityId,id,lineCode){
 requirePermission(ctx,'return.read');requireEntity(ctx,entityId);await loadReturn(tx,ctx,entityId,id,{lock:false});
 return (await tx.query('select k.sign,e.id,e.document_id,d.official_number,d.kind,e.tax_point,e.recognition,e.basis::text as basis,e.amount::text as amount,e.recognition_entry_id from lara.return_source_links k join lara.tax_events e on e.tenant_id=k.tenant_id and e.id=k.tax_event_id join lara.documents d on d.tenant_id=e.tenant_id and d.id=e.document_id where k.tenant_id=$1 and k.run_id=$2 and k.line_code=$3 order by e.tax_point,e.id',[ctx.tenantId,id,lineCode])).rows.map(r=>({taxEventId:r.id,documentId:r.document_id,officialNumber:r.official_number,kind:r.kind,taxPoint:iso(r.tax_point),recognition:r.recognition,basis:money(r.basis),amount:money(r.amount),sign:r.sign,journalEntryId:r.recognition_entry_id}));
}

// ---------------------------------------------------------------------------
// E-invoice transmissions
// ---------------------------------------------------------------------------
const transmissionResource=t=>({id:t.id,documentId:t.document_id,version:Number(t.version),state:t.state,payloadVersion:t.payload_version,payloadHash:t.payload_hash,profileVersion:t.profile_version,deadlineAt:iso(t.deadline_at),remoteId:t.remote_id,attemptCount:t.attempt_count,simulation:false});
// The immutable payload: the issued document as posted, its party snapshot,
// lines and tax events. A transport-only re-encoding is a new payload version
// with the reason; the financial data is never changed here.
async function buildPayload(tx,ctx,entityId,document,{version,reason=null}){
 const lines=(await tx.query('select line_no,description,quantity::text as quantity,unit_price::text as unit_price,net::text as net,tax::text as tax,gross::text as gross,tax_rate::text as tax_rate from lara.document_lines where tenant_id=$1 and document_id=$2 order by line_no',[ctx.tenantId,document.id])).rows;
 const snapshot=(await tx.query('select immutable_json from lara.party_snapshots where tenant_id=$1 and document_id=$2',[ctx.tenantId,document.id])).rows[0]?.immutable_json||{};
 const events=(await tx.query('select tax_rule_version_id,recognition,basis::text as basis,amount::text as amount from lara.tax_events where tenant_id=$1 and document_id=$2 and reversed_by is null order by created_at',[ctx.tenantId,document.id])).rows;
 return {payloadVersion:version,documentId:document.id,kind:document.kind,officialNumber:document.official_number,documentDate:iso(document.document_date),accountingDate:iso(document.accounting_date),currency:document.currency,net:money(document.net),tax:money(document.tax),gross:money(document.gross),payloadHash:document.payload_hash,party:snapshot,lines:lines.map(l=>({lineNo:l.line_no,description:l.description,quantity:l.quantity,unitPrice:l.unit_price,net:money(l.net),tax:money(l.tax),gross:money(l.gross),rate:l.tax_rate})),taxEvents:events.map(e=>({ruleVersionId:e.tax_rule_version_id,recognition:e.recognition,basis:money(e.basis),amount:money(e.amount)})),...(reason?{reencodingReason:reason}:{})};
}
// Queues reporting for an issued document when the profile requires it.
// Called inside the issuing transaction by sales.
export async function queueTransmission(tx,ctx,entityId,documentId,{reason=null,commandId=null}={}){
 const document=(await tx.query('select * from lara.documents where tenant_id=$1 and entity_id=$2 and id=$3',[ctx.tenantId,entityId,documentId])).rows[0];
 if(!document||document.state!=='posted')fail('STATE_CONFLICT','Only issued documents are reported.');
 const profile=await complianceProfile(tx,ctx,entityId);
 const live=(await tx.query("select id from lara.transmission_jobs where tenant_id=$1 and document_id=$2 and destination=$3 and state in ('queued','sending','accepted','unknown','retry_wait')",[ctx.tenantId,documentId,profile.destination])).rows[0];
 if(live)fail('STATE_CONFLICT','Transmission '+live.id+' is already live for this document; reconcile or let it finish.');
 const version=((await tx.query('select coalesce(max(payload_version),0)::int v from lara.transmission_jobs where tenant_id=$1 and document_id=$2 and destination=$3',[ctx.tenantId,documentId,profile.destination])).rows[0].v)+1;
 const payload=await buildPayload(tx,ctx,entityId,document,{version,reason});
 const hash=contentHash(payload);
 const deadline=profile.deadlineHours===null?null:new Date(Date.parse(iso(document.posted_at))+profile.deadlineHours*3600000).toISOString();
 const row=(await tx.query('insert into lara.transmission_jobs(tenant_id,entity_id,document_id,destination,payload_version,payload_hash,payload_json,profile_version,deadline_at,reason,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning *',[ctx.tenantId,entityId,documentId,profile.destination,version,hash,JSON.stringify(payload),profile.profileVersion,deadline,reason,ctx.principalId])).rows[0];
 await tx.query("update lara.documents set reporting_state='queued' where tenant_id=$1 and id=$2",[ctx.tenantId,documentId]);
 const jobId=await enqueueJob(tx,ctx,{entityId,kind:'einvoice.transmit',payload:{transmissionId:row.id}});
 await audit(tx,ctx,{entityId,action:'transmission.queue',resourceType:'transmission',resourceId:row.id,resourceVersion:1,afterRef:hash,reason});
 return {transmission:transmissionResource(row),jobId};
}
const requestHashOf=(destination,payloadHash)=>sha(destination+':'+payloadHash);
// The transport contract: send({requestHash,payload,signature,credentials})
// → {outcome:'accepted',remoteId} | {outcome:'rejected',rejectionClass,reason}
// | {outcome:'unknown'}; status(requestHash) → the same shapes or {outcome:'unknown'}.
async function guardTransmission(tx,ctx,entityId,job,env){
 const document=(await tx.query('select * from lara.documents where tenant_id=$1 and id=$2',[ctx.tenantId,job.document_id])).rows[0];
 const profile=await complianceProfile(tx,ctx,entityId);
 await activeProfile(tx,ctx,entityId,{jurisdiction:profile.jurisdiction,onDate:iso(document.document_date)});
 const key=env[profile.signingKeyRef];
 if(!key)fail('DEPENDENCY_UNAVAILABLE','Signing key '+profile.signingKeyRef+' is not configured; unsigned payloads are never sent.');
 const credentials=env[profile.credentialsRef];
 if(!credentials)fail('DEPENDENCY_UNAVAILABLE','Taxpayer credentials '+profile.credentialsRef+' are not configured.');
 if(!credentials.startsWith(profile.taxpayerId+':'))fail('FORBIDDEN','The configured credentials belong to another taxpayer than the profile ('+profile.taxpayerId+').');
 const signature=createHmac('sha256',key).update(job.payload_hash).digest('hex');
 return {profile,signature,credentials,document};
}
// Worker: sends a queued or retry-wait transmission once; an unknown outcome
// is never resent (status query first).
export async function transmit(tx,ctx,entityId,transmissionId,{transport,env=process.env}){
 const job=(await tx.query('select * from lara.transmission_jobs where tenant_id=$1 and entity_id=$2 and id=$3 for update',[ctx.tenantId,entityId,transmissionId])).rows[0];
 if(!job)fail('NOT_FOUND','Transmission not found.');
 if(job.state==='accepted')return transmissionResource(job);
 if(job.state==='unknown')fail('STATE_CONFLICT','The last attempt has an unknown outcome; reconcile the remote status before any resend.');
 if(!['queued','retry_wait'].includes(job.state))fail('STATE_CONFLICT','Transmission is '+job.state+'.');
 // A blocked send (no key, wrong taxpayer, expired profile) waits with its reason; nothing is sent and the operator retries after fixing the gate.
 let guard;
 try{guard=await guardTransmission(tx,ctx,entityId,job,env);}
 catch(e){if(!(e instanceof Error)||!e.code)throw e;const blocked=(await tx.query("update lara.transmission_jobs set state='retry_wait',reason=$3,next_attempt_at=now()+interval '1 hour' where tenant_id=$1 and id=$2 returning *",[ctx.tenantId,transmissionId,'blocked ('+e.code+'): '+e.message])).rows[0];await tx.query("update lara.documents set reporting_state='retry_wait' where tenant_id=$1 and id=$2",[ctx.tenantId,job.document_id]);await audit(tx,ctx,{entityId,action:'transmission.blocked',resourceType:'transmission',resourceId:transmissionId,resourceVersion:Number(blocked.version),reason:e.code+': '+e.message});return {...transmissionResource(blocked),blocked:e.code,reason:e.message};}
 await tx.query("update lara.transmission_jobs set state='sending',signature=$3 where tenant_id=$1 and id=$2",[ctx.tenantId,transmissionId,guard.signature]);
 await tx.query("update lara.documents set reporting_state='sending' where tenant_id=$1 and id=$2",[ctx.tenantId,job.document_id]);
 const attempt=job.attempt_count+1,requestHash=requestHashOf(job.destination,job.payload_hash);
 let result;
 try{result=await transport.send({requestHash,payload:job.payload_json,signature:guard.signature,credentials:guard.credentials,destination:job.destination});}
 catch(e){result={outcome:'unknown',error:String(e.message||e)};}
 return recordOutcome(tx,ctx,entityId,{...job,attempt_count:attempt-1},attempt,requestHash,result,'send');
}
async function recordOutcome(tx,ctx,entityId,job,attempt,requestHash,result,mode){
 const outcome=['accepted','rejected','unknown'].includes(result.outcome)?result.outcome:'unknown';
 await tx.query('insert into lara.transmission_attempts(tenant_id,job_id,attempt,request_hash,outcome,response_json) values($1,$2,$3,$4,$5,$6)',[ctx.tenantId,job.id,attempt,requestHash,mode==='status'?'status_query':outcome,JSON.stringify({...result,mode})]);
 const patch={accepted:{state:'accepted',remote:result.remoteId||null,cls:null,reason:null},rejected:{state:'rejected',remote:null,cls:result.rejectionClass==='financial'?'financial':'envelope',reason:result.reason||'rejected'},unknown:{state:'unknown',remote:null,cls:null,reason:result.error||result.reason||'unknown outcome'}}[outcome];
 const updated=(await tx.query('update lara.transmission_jobs set state=$3,remote_id=coalesce($4,remote_id),rejection_class=$5,rejection_reason=$6,attempt_count=$7,next_attempt_at=null where tenant_id=$1 and id=$2 returning *',[ctx.tenantId,job.id,patch.state,patch.remote,patch.cls,patch.reason,mode==='send'?attempt:job.attempt_count])).rows[0];
 await tx.query('update lara.documents set reporting_state=$3 where tenant_id=$1 and id=$2',[ctx.tenantId,job.document_id,patch.state]);
 await audit(tx,ctx,{entityId,action:'transmission.'+(mode==='status'?'reconciled_':'')+outcome,resourceType:'transmission',resourceId:job.id,resourceVersion:Number(updated.version),afterRef:requestHash,reason:patch.reason});
 if(outcome==='accepted')await emit(tx,ctx,{entityId,aggregateType:'transmission',aggregateId:job.id,aggregateVersion:Number(updated.version),eventType:'transmission.accepted.v1',payload:{documentId:job.document_id,remoteId:patch.remote,payloadHash:job.payload_hash}});
 return transmissionResource(updated);
}
// Worker: a status query for an unknown or sending transmission resolves the
// remote outcome without a second submission.
export async function reconcile(tx,ctx,entityId,transmissionId,{transport}){
 const job=(await tx.query('select * from lara.transmission_jobs where tenant_id=$1 and entity_id=$2 and id=$3 for update',[ctx.tenantId,entityId,transmissionId])).rows[0];
 if(!job)fail('NOT_FOUND','Transmission not found.');
 if(['accepted','rejected','superseded'].includes(job.state))return transmissionResource(job);
 const requestHash=requestHashOf(job.destination,job.payload_hash);
 let result;
 try{result=await transport.status({requestHash,destination:job.destination});}catch(e){result={outcome:'unknown',error:String(e.message||e)};}
 if(result.outcome==='unknown'&&job.state==='sending')result={outcome:'unknown',reason:'no remote record of the request'};
 return recordOutcome(tx,ctx,entityId,job,job.attempt_count+1,requestHash,result,'status');
}
export async function requestReconcile(tx,ctx,entityId,id,input){
 requirePermission(ctx,'transmission.reconcile');requireEntity(ctx,entityId);assertInput('ReasonAction',input);
 const job=(await tx.query('select * from lara.transmission_jobs where tenant_id=$1 and entity_id=$2 and id=$3',[ctx.tenantId,entityId,id])).rows[0];
 if(!job)fail('NOT_FOUND','Transmission not found.');
 if(!['unknown','sending','retry_wait','queued'].includes(job.state))fail('STATE_CONFLICT','Transmission is '+job.state+'; nothing to reconcile.');
 const queued=await enqueueJob(tx,ctx,{entityId,kind:'einvoice.reconcile',payload:{transmissionId:id}});
 await audit(tx,ctx,{entityId,action:'transmission.reconcile',resourceType:'transmission',resourceId:id,resourceVersion:Number(job.version),reason:input.reason});
 return queued;
}
// Retry re-encodes the envelope as a new payload version after an envelope
// rejection; a financial rejection needs a correction document, never a retry.
export async function requestRetry(tx,ctx,entityId,id,input){
 requirePermission(ctx,'transmission.retry');requireEntity(ctx,entityId);assertInput('ReasonAction',input);
 const job=(await tx.query('select * from lara.transmission_jobs where tenant_id=$1 and entity_id=$2 and id=$3 for update',[ctx.tenantId,entityId,id])).rows[0];
 if(!job)fail('NOT_FOUND','Transmission not found.');
 if(job.state==='retry_wait'){const queued=await enqueueJob(tx,ctx,{entityId,kind:'einvoice.transmit',payload:{transmissionId:id}});await audit(tx,ctx,{entityId,action:'transmission.retry',resourceType:'transmission',resourceId:id,resourceVersion:Number(job.version),reason:input.reason});return queued;}
 if(job.state!=='rejected')fail('STATE_CONFLICT','Transmission is '+job.state+'; only rejected or waiting transmissions retry.');
 if(job.rejection_class==='financial')fail('STATE_CONFLICT','The authority rejected the financial content; issue a correction document (credit note or additional invoice) instead of re-sending.');
 await tx.query("update lara.transmission_jobs set state='superseded' where tenant_id=$1 and id=$2",[ctx.tenantId,id]);
 const r=await queueTransmission(tx,ctx,entityId,job.document_id,{reason:'Envelope repair: '+input.reason});
 await audit(tx,ctx,{entityId,action:'transmission.retry',resourceType:'transmission',resourceId:id,resourceVersion:Number(job.version)+1,reason:input.reason,afterRef:r.transmission.id});
 return r.jobId;
}
export async function getTransmission(tx,ctx,entityId,id){
 requirePermission(ctx,'transmission.read');requireEntity(ctx,entityId);
 if(!isUuid(id))fail('NOT_FOUND','Transmission not found.');
 const row=(await tx.query('select * from lara.transmission_jobs where tenant_id=$1 and entity_id=$2 and id=$3',[ctx.tenantId,entityId,id])).rows[0];
 if(!row)fail('NOT_FOUND','Transmission not found.');return transmissionResource(row);
}
export async function listTransmissions(tx,ctx,entityId,{state=null,documentId=null}={}){
 requirePermission(ctx,'transmission.read');requireEntity(ctx,entityId);
 const params=[ctx.tenantId,entityId];let where='';
 if(state)where+=' and t.state=$'+params.push(state);if(documentId)where+=' and t.document_id=$'+params.push(documentId);
 return (await tx.query('select t.*,d.official_number,d.kind,(select json_agg(json_build_object(\'attempt\',a.attempt,\'outcome\',a.outcome,\'sentAt\',a.sent_at,\'requestHash\',a.request_hash) order by a.attempt) from lara.transmission_attempts a where a.tenant_id=t.tenant_id and a.job_id=t.id) as attempts from lara.transmission_jobs t join lara.documents d on d.tenant_id=t.tenant_id and d.id=t.document_id where t.tenant_id=$1 and t.entity_id=$2'+where+' order by t.deadline_at nulls last,t.created_at,t.id',params)).rows.map(t=>({...transmissionResource(t),officialNumber:t.official_number,kind:t.kind,rejectionClass:t.rejection_class,rejectionReason:t.rejection_reason,reason:t.reason,attempts:t.attempts||[]}));
}

// ---------------------------------------------------------------------------
// Registration packs and cases
// ---------------------------------------------------------------------------
const caseResource=c=>({id:c.id,version:Number(c.version),state:c.status,authority:c.authority,scope:c.scope,packEvidenceId:c.pack_evidence_id,packHash:c.pack_hash,submittedAt:iso(c.submitted_at),decisionReference:c.decision_reference,decisionEvidenceId:c.decision_evidence_id,decidedAt:iso(c.decided_at),createdAt:iso(c.created_at),simulation:false});
// Worker: assembles the registration pack (entity, branches, approved bank
// accounts masked, active profile, available evidence manifest) as restricted
// evidence and records the case as pack_generated. Nothing here is a permit.
export async function generateRegistrationPack(tx,ctx,entityId,{authority,scope,store}){
 const entity=(await tx.query('select id,legal_name,base_currency,timezone,fiscal_year_start_month from lara.entities where tenant_id=$1 and id=$2',[ctx.tenantId,entityId])).rows[0];
 const branches=(await tx.query("select code,name,address_json from lara.branches where tenant_id=$1 and entity_id=$2 and status='active' order by code",[ctx.tenantId,entityId])).rows;
 const banks=(await tx.query("select bank_code,number_last4,currency from lara.bank_accounts where tenant_id=$1 and entity_id=$2 and status='approved' order by bank_code",[ctx.tenantId,entityId])).rows;
 const profile=(await tx.query("select id,jurisdiction,version_number,coverage,valid_from,valid_to,source_hash from lara.regulatory_profiles where tenant_id=$1 and entity_id=$2 and status='active'",[ctx.tenantId,entityId])).rows;
 const evidence=(await tx.query("select id,filename,sha256,mime,created_at from lara.evidence where tenant_id=$1 and entity_id=$2 and status='available' and classification<>'restricted' order by created_at",[ctx.tenantId,entityId])).rows;
 const pack={authority,scope,generatedAt:new Date().toISOString(),notice:'Generated application pack; the authority decision is recorded separately with its own evidence.',entity,branches:branches.map(b=>({code:b.code,name:b.name,address:b.address_json})),bankAccounts:banks.map(b=>({bankCode:b.bank_code,accountNumberMasked:'••••'+b.number_last4,currency:b.currency})),regulatoryProfiles:profile.map(p=>({id:p.id,jurisdiction:p.jurisdiction,version:p.version_number,coverage:p.coverage,validFrom:iso(p.valid_from),validTo:iso(p.valid_to),sourceHash:p.source_hash})),evidence:evidence.map(e=>({id:e.id,filename:e.filename,sha256:e.sha256,mime:e.mime,createdAt:iso(e.created_at)}))};
 const content=Buffer.from(JSON.stringify(pack,null,1));const hash=sha(content);
 const key='tenants/'+ctx.tenantId+'/entities/'+entityId+'/registration/'+hash;
 await store.put(key,content);
 const ev=(await tx.query("insert into lara.evidence(tenant_id,entity_id,object_key,filename,sha256,mime,byte_count,status,classification,created_by) values($1,$2,$3,$4,$5,'text/csv',$6,'available','restricted',$7) on conflict (object_key) do update set updated_at=now() returning id",[ctx.tenantId,entityId,key,'registration-pack-'+authority.toLowerCase()+'-'+hash.slice(0,8)+'.json',hash,content.length,ctx.principalId])).rows[0];
 const open=(await tx.query("select * from lara.registration_cases where tenant_id=$1 and entity_id=$2 and authority=$3 and scope=$4 and status in ('open','pack_generated') for update",[ctx.tenantId,entityId,authority,scope])).rows[0];
 const row=open?(await tx.query("update lara.registration_cases set status='pack_generated',pack_evidence_id=$3,pack_hash=$4 where tenant_id=$1 and id=$2 returning *",[ctx.tenantId,open.id,ev.id,hash])).rows[0]:(await tx.query("insert into lara.registration_cases(tenant_id,entity_id,authority,scope,status,pack_evidence_id,pack_hash,created_by) values($1,$2,$3,$4,'pack_generated',$5,$6,$7) returning *",[ctx.tenantId,entityId,authority,scope,ev.id,hash,ctx.principalId])).rows[0];
 await audit(tx,ctx,{entityId,action:'registration.pack',resourceType:'registration_case',resourceId:row.id,resourceVersion:Number(row.version),afterRef:hash});
 return {case:caseResource(row),evidenceId:ev.id,hash};
}
export async function submitRegistrationCase(tx,ctx,entityId,id,{submittedAt,evidenceIds=[]}){
 requirePermission(ctx,'registration.prepare');requireEntity(ctx,entityId);
 const row=(await tx.query('select * from lara.registration_cases where tenant_id=$1 and entity_id=$2 and id=$3 for update',[ctx.tenantId,entityId,id])).rows[0];
 if(!row)fail('NOT_FOUND','Registration case not found.');
 if(row.status!=='pack_generated')fail('STATE_CONFLICT','Generate the pack before recording the submission.');
 if(evidenceIds.length)await linkEvidence(tx,ctx,entityId,evidenceIds,'registration_case',id,Number(row.version)+1);
 const updated=(await tx.query("update lara.registration_cases set status='submitted',submitted_at=$3 where tenant_id=$1 and id=$2 returning *",[ctx.tenantId,id,submittedAt||new Date().toISOString()])).rows[0];
 await audit(tx,ctx,{entityId,action:'registration.submit',resourceType:'registration_case',resourceId:id,resourceVersion:Number(updated.version)});
 return caseResource(updated);
}
// The authority's decision is recorded from its own evidence; a generated
// pack or a submission never marks the permit as granted.
export async function recordRegistrationDecision(tx,ctx,entityId,id,{decision,reference,evidenceId,decidedAt}){
 requirePermission(ctx,'registration.prepare');requireEntity(ctx,entityId);
 const row=(await tx.query('select * from lara.registration_cases where tenant_id=$1 and entity_id=$2 and id=$3 for update',[ctx.tenantId,entityId,id])).rows[0];
 if(!row)fail('NOT_FOUND','Registration case not found.');
 if(!['approved','denied'].includes(decision))fail('VALIDATION_FAILED','decision is approved or denied.',{fieldErrors:[{path:'decision',message:'Invalid'}]});
 if(row.status!=='submitted')fail('STATE_CONFLICT','A decision is recorded on a submitted application; a generated pack is not a permit.');
 if(!isUuid(evidenceId)||!reference?.trim())fail('VALIDATION_FAILED','The authority decision needs its reference and evidence.',{fieldErrors:[{path:'evidenceId',message:'Required'}]});
 await linkEvidence(tx,ctx,entityId,[evidenceId],'registration_case',id,Number(row.version)+1);
 const updated=(await tx.query('update lara.registration_cases set status=$3,decision_reference=$4,decision_evidence_id=$5,decided_at=$6 where tenant_id=$1 and id=$2 returning *',[ctx.tenantId,id,decision,reference.trim(),evidenceId,decidedAt||new Date().toISOString()])).rows[0];
 await audit(tx,ctx,{entityId,action:'registration.'+decision,resourceType:'registration_case',resourceId:id,resourceVersion:Number(updated.version),afterRef:evidenceId,reason:reference.trim()});
 return caseResource(updated);
}
export async function listRegistrationCases(tx,ctx,entityId){requirePermission(ctx,'registration.prepare');requireEntity(ctx,entityId);return (await tx.query('select * from lara.registration_cases where tenant_id=$1 and entity_id=$2 order by created_at,id',[ctx.tenantId,entityId])).rows.map(caseResource);}
// Readiness: what the compliance workbench shows as ready, failed or not tested.
export async function readiness(tx,ctx,entityId,env=process.env){
 requirePermission(ctx,'return.read');requireEntity(ctx,entityId);
 const capability=(await tx.query("select 1 from lara.capability_activations where tenant_id=$1 and entity_id=$2 and capability='compliance' and status='active'",[ctx.tenantId,entityId])).rowCount>0;
 let profile=null;try{profile=await complianceProfile(tx,ctx,entityId);}catch{}
 const active=(await tx.query("select * from lara.regulatory_profiles where tenant_id=$1 and entity_id=$2 and status='active'",[ctx.tenantId,entityId])).rows;
 const artifacts=(await tx.query("select artifact_type,code,version_label,status from lara.schema_artifacts where tenant_id=$1 and entity_id=$2 and status='approved' order by artifact_type,code",[ctx.tenantId,entityId])).rows;
 const forms=active.flatMap(p=>p.coverage.map(code=>({code,jurisdiction:p.jurisdiction,mapping:artifacts.some(a=>a.artifact_type==='form_mapping'&&a.code===code)?'ready':'not_tested'})));
 return {capability:capability?'ready':'failed',complianceProfile:profile?'ready':'failed',regulatoryProfile:active.length?'ready':'failed',signingKey:profile?(env[profile.signingKeyRef]?'ready':'failed'):'not_tested',credentials:profile?(env[profile.credentialsRef]?(env[profile.credentialsRef].startsWith(profile.taxpayerId+':')?'ready':'failed'):'failed'):'not_tested',transport:profile?profile.transport:'not_tested',forms,einvoiceSchema:artifacts.some(a=>a.artifact_type==='einvoice_schema')?'ready':'not_tested'};
}

// ---------------------------------------------------------------------------
// Fixture transport: never a production adapter. Outcomes follow markers in
// the payload description; acceptances persist in the object store so a
// status query after a crash finds the remote record.
// ---------------------------------------------------------------------------
export class FixtureEInvoiceTransport{
 constructor(store){this.store=store;}
 async send({requestHash,payload,signature}){
  if(!signature)return {outcome:'rejected',rejectionClass:'envelope',reason:'unsigned'};
  const text=JSON.stringify(payload);
  let result;
  if(text.includes('REJECT-FINANCIAL'))result={outcome:'rejected',rejectionClass:'financial',reason:'Tax amount does not match the declared rate'};
  else if(text.includes('REJECT-ENVELOPE'))result={outcome:'rejected',rejectionClass:'envelope',reason:'Schema field format invalid'};
  else result={outcome:'accepted',remoteId:'FX-'+requestHash.slice(0,12)};
  await this.store.put('einvoice/'+requestHash,Buffer.from(JSON.stringify(result))).catch(()=>{});
  if(text.includes('LOSE-RESPONSE'))return {outcome:'unknown',reason:'response lost'};
  return result;
 }
 async status({requestHash}){
  const bytes=await this.store.get('einvoice/'+requestHash).catch(()=>null);
  return bytes?JSON.parse(bytes.toString()):{outcome:'unknown',reason:'no remote record of the request'};
 }
}
export function transportFromEnv(env=process.env,store){
 const adapter=env.EINVOICE_ADAPTER||'fixture';
 if(adapter==='fixture'){if(['production','staging'].includes(env.LARA_MODE))fail('DEPENDENCY_UNAVAILABLE','The fixture e-invoice transport is forbidden outside local/demo.');return new FixtureEInvoiceTransport(store);}
 fail('DEPENDENCY_UNAVAILABLE','E-invoice transport '+adapter+' is not available in this build; a provider adapter is a separate activation gate.');
}
