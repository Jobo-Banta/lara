// P02-02 domain rules against real PostgreSQL through the runtime role:
// tenant isolation (T01), revocation denies queued work (T02), settings
// approval binding (T03), missing-evidence task resolution without
// duplicates (T04), upload rejection paths (T05), entity activation
// maker-checker, party identity/merge, obligations from versioned templates
// and idempotent command receipts. Test tenants are removed at the end.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createHash,randomUUID,randomBytes} from 'node:crypto';
import {loadLocalEnv} from './local-env.mjs';
import {connectionOptions} from '../packages/database/src/connection.mjs';
import {DomainError,command,inTransaction,identity,organization,parties,evidence,workflow,enqueueJob} from '../packages/domain/src/index.mjs';
loadLocalEnv();
process.env.FIELD_ENCRYPTION_KEY??=randomBytes(32).toString('hex');
const pg=createRequire(new URL('../packages/database/package.json',import.meta.url))('pg');
const client=url=>new pg.Client({...connectionOptions(url),connectionTimeoutMillis:15000,query_timeout:30000});
const api=client(process.env.DATABASE_URL);
const owner=client(process.env.LARA_MIGRATOR_DATABASE_URL||process.env.SUPABASE_LARA_MIGRATOR_DATABASE_URL||process.env.MIGRATION_DATABASE_URL||process.env.SUPABASE_OWNER_DATABASE_URL);
await Promise.all([api.connect(),owner.connect()]);
const sha=b=>createHash('sha256').update(b).digest('hex');
const suffix=randomBytes(3).toString('hex');
let step=0;const pass=l=>console.log('PASS '+(++step)+': '+l);
async function rejects(promise,code,label){try{await promise;}catch(e){assert.ok(e instanceof DomainError,label+': not a DomainError: '+e.message);assert.equal(e.code,code,label+': '+e.message);return e;}assert.fail(label+' should fail with '+code);}
const tenants=[];

// Operator provisioning: tenant, principals, approved roles and tenant-wide
// memberships. P02-03 exposes this as an operations command.
async function bootstrap(slug){
 const tenantId=randomUUID();tenants.push(tenantId);
 const boot={tenantId,principalId:null};
 const principals={};
 await inTransaction(api,boot,async tx=>{
  await organization.provisionTenant(tx,{id:tenantId,slug,name:'Domain test '+slug,mode:'demo'});
  for(const name of ['security','preparer','controller','clerk','exporter'])principals[name]=(await identity.resolvePrincipal(tx,tenantId,{issuer:'https://identity.invalid',subject:name+'-'+slug,displayName:name})).id;
  const roles={};
  const custom={preparer:['entity.create','entity.edit','entity.read','branch.create','branch.edit','branch.read','party.create','party.edit','party.archive','party.read','task.create','task.edit','task.assign','task.resolve','task.comments','task.read','evidence.upload','evidence.read','obligation.create','obligation.edit','obligation.complete','obligation.read','membership.read','session.read','command.read','job.read']};
  for(const [code,perms] of Object.entries(custom))roles[code]=(await tx.query("insert into lara.roles(tenant_id,code,name,permissions,status,content_hash,created_by) values($1,$2,$2,$3,'approved',$4,$5) returning id",[tenantId,code,JSON.stringify(perms),sha(code),principals.security])).rows[0].id;
  for(const code of ['security_admin','controller','clerk','auditor'])roles[code]=(await tx.query("insert into lara.roles(tenant_id,code,name,permissions,status,content_hash,created_by,protected) select $1,code,name,permissions,'approved',$2,$3,true from lara.role_templates where code=$4 returning id",[tenantId,sha(code),principals.security,code])).rows[0].id;
  const grant=async(p,r)=>tx.query('insert into lara.memberships(tenant_id,principal_id,role_id,created_by) values($1,$2,$3,$4)',[tenantId,principals[p],roles[r],principals.security]);
  await grant('security','security_admin');await grant('preparer','preparer');await grant('controller','controller');await grant('clerk','clerk');
  boot.roles=roles;
 });
 return {tenantId,principals,roles:boot.roles};
}
const ctxFor=async(t,name)=>inTransaction(api,{tenantId:t.tenantId,principalId:t.principals[name]},tx=>identity.actorContext(tx,t.tenantId,t.principals[name],{traceId:'trace-'+name}));
const run=(ctx,fn)=>inTransaction(api,ctx,fn);

try{
 const A=await bootstrap('dom-a-'+suffix),B=await bootstrap('dom-b-'+suffix);
 let prep=await ctxFor(A,'preparer'),ctrl=await ctxFor(A,'controller'),clerk=await ctxFor(A,'clerk');
 assert.ok(prep.permissions.has('entity.create')&&!prep.permissions.has('entity.activate'));
 assert.ok(ctrl.permissions.has('entity.activate'));
 pass('actor context derives permissions from approved roles through active memberships');

 // Entity setup and maker-checker activation
 const entity=await run(prep,tx=>organization.createEntity(tx,prep,{legalName:'  LARA Domain Entity  ',baseCurrency:'PHP',timezone:'Asia/Manila',fiscalYearStartMonth:1}));
 assert.equal(entity.state,'draft');assert.equal(entity.legalName,'LARA Domain Entity');
 await rejects(run(prep,tx=>organization.createEntity(tx,prep,{legalName:'X',baseCurrency:'PHP',timezone:'Mars/Olympus',fiscalYearStartMonth:1})),'VALIDATION_FAILED','bad timezone');
 prep=await ctxFor(A,'preparer');ctrl=await ctxFor(A,'controller');clerk=await ctxFor(A,'clerk');
 const blocked=await rejects(run(prep,tx=>organization.requestActivation(tx,prep,entity.id,{reason:'Go live'})),'STATE_CONFLICT','activation without branch');
 assert.match(blocked.message,/branch/);
 const branch=await run(prep,tx=>organization.createBranch(tx,prep,entity.id,{code:'hq',name:'Head office',address:'Makati'}));
 assert.equal(branch.code,'HQ');
 const requested=await run(prep,tx=>organization.requestActivation(tx,prep,entity.id,{reason:'Setup complete'}));
 assert.equal(requested.state,'pending_activation');
 await rejects(run(prep,tx=>organization.activateEntity(tx,prep,entity.id,{reason:'self'})),'FORBIDDEN','preparer lacks entity.activate');
 const edited=await run(prep,tx=>organization.updateEntity(tx,prep,entity.id,requested.version,{legalName:'LARA Domain Entity Inc',baseCurrency:'PHP',timezone:'Asia/Manila',fiscalYearStartMonth:1}));
 assert.equal(edited.state,'draft');assert.equal(edited.contentVersion,2);
 await rejects(run(ctrl,tx=>organization.activateEntity(tx,ctrl,entity.id,{reason:'approve'})),'STATE_CONFLICT','activate after material edit needs a new request');
 const again=await run(prep,tx=>organization.requestActivation(tx,prep,entity.id,{reason:'Re-request'}));
 const same=await run(prep,tx=>organization.updateEntity(tx,prep,entity.id,again.version,{legalName:'LARA Domain Entity Inc',baseCurrency:'PHP',timezone:'Asia/Manila',fiscalYearStartMonth:1}));
 assert.equal(same.contentVersion,2);assert.equal(same.state,'pending_activation','non-material edit keeps the pending request');
 const active=await run(ctrl,tx=>organization.activateEntity(tx,ctrl,entity.id,{reason:'Reviewed setup'}));
 assert.equal(active.state,'active');
 prep=await ctxFor(A,'preparer');ctrl=await ctxFor(A,'controller');clerk=await ctxFor(A,'clerk');
 assert.deepEqual(await run(ctrl,tx=>organization.activeCapabilities(tx,ctrl,entity.id)),['workspace']);
 await rejects(run(ctrl,tx=>organization.activateEntity(tx,ctrl,entity.id,{reason:'twice'})),'STATE_CONFLICT','double activation');
 pass('entity activation requires a branch, an independent controller, a fresh request after material edits and a different approver; workspace capability activates with it');

 // P02-T03 settings versions
 const s1=await run(prep,tx=>organization.saveSettings(tx,prep,entity.id,'approval_thresholds',{journalReview:'50000.00'}));
 assert.equal(s1.versionNumber,1);assert.equal(s1.state,'draft');
 await rejects(run(prep,tx=>organization.approveSettings(tx,prep,entity.id,s1.id,{payloadHash:s1.payloadHash})),'FORBIDDEN','preparer cannot approve settings');
 const s1b=await run(prep,tx=>organization.saveSettings(tx,prep,entity.id,'approval_thresholds',{journalReview:'50000.00'}));
 assert.equal(s1b.changed,false);assert.equal(s1b.id,s1.id,'unchanged payload does not create a version');
 const approved=await run(ctrl,tx=>organization.approveSettings(tx,ctrl,entity.id,s1.id,{payloadHash:s1.payloadHash}));
 assert.equal(approved.state,'approved');
 const s2=await run(prep,tx=>organization.saveSettings(tx,prep,entity.id,'approval_thresholds',{journalReview:'25000.00'}));
 assert.equal(s2.versionNumber,2);assert.equal(s2.state,'draft');
 await rejects(run(ctrl,tx=>organization.approveSettings(tx,ctrl,entity.id,s2.id,{payloadHash:s1.payloadHash})),'VERSION_CONFLICT','approval bound to the reviewed hash');
 const s2b=await run(prep,tx=>organization.saveSettings(tx,prep,entity.id,'approval_thresholds',{journalReview:'30000.00'}));
 assert.equal(s2b.id,s2.id);assert.equal(s2b.contentVersion,2,'draft edits stay on the same version number');
 await rejects(run(ctrl,tx=>organization.approveSettings(tx,ctrl,entity.id,s2.id,{payloadHash:s2.payloadHash})),'VERSION_CONFLICT','material change invalidates the earlier review');
 const s2ok=await run(ctrl,tx=>organization.approveSettings(tx,ctrl,entity.id,s2.id,{payloadHash:s2b.payloadHash}));
 assert.equal(s2ok.state,'approved');
 const states=(await run(ctrl,tx=>tx.query('select version_number,status from lara.settings_versions where tenant_id=$1 and entity_id=$2 order by version_number',[A.tenantId,entity.id]))).rows;
 assert.deepEqual(states,[{version_number:1,status:'superseded'},{version_number:2,status:'approved'}]);
 pass('settings versions: unchanged payload is a no-op, approval by another principal binds the hash, material change requires a new approval and supersedes the prior version');

 // P02-T01 isolation across tenants at the domain layer
 const prepB=await ctxFor(B,'preparer');
 const entityB=await run(prepB,tx=>organization.createEntity(tx,prepB,{legalName:'Other tenant',baseCurrency:'PHP',timezone:'Asia/Manila',fiscalYearStartMonth:6}));
 const prepBfresh=await ctxFor(B,'preparer');
 await rejects(run(prep,tx=>organization.getEntity(tx,prep,entityB.id)),'NOT_FOUND','foreign entity read');
 await rejects(run(prep,tx=>workflow.listTasks(tx,prep,entityB.id,{})),'NOT_FOUND','foreign entity task list');
 assert.deepEqual((await run(prep,tx=>organization.listEntities(tx,prep,{}))).items.map(e=>e.id),[entity.id]);
 assert.deepEqual((await run(prepBfresh,tx=>organization.listEntities(tx,prepBfresh,{}))).items.map(e=>e.id),[entityB.id]);
 pass('a principal sees only entities of its own tenant and memberships; foreign ids read as not found');

 // Parties
 const party=await run(prep,tx=>parties.createParty(tx,prep,entity.id,{legalName:'Northwind  Services',roles:['customer'],identityStatus:'unknown',address:'Cebu City'}));
 assert.equal(party.taxIdMasked,undefined);
 const identityTasks=async()=>(await run(prep,tx=>workflow.listTasks(tx,prep,entity.id,{sourceId:party.id}))).items;
 assert.equal((await identityTasks()).length,1,'unknown identity opens one task');
 await rejects(run(prep,tx=>parties.updateParty(tx,prep,entity.id,party.id,party.version,{legalName:'Northwind Services',roles:['customer'],identityStatus:'known',address:'Cebu City'})),'VALIDATION_FAILED','known identity requires tax id');
 await rejects(run(prep,tx=>parties.updateParty(tx,prep,entity.id,party.id,party.version,{legalName:'Northwind Services',roles:['customer'],identityStatus:'not_applicable',taxId:'123-456-789-000',address:'Cebu City'})),'VALIDATION_FAILED','not applicable cannot carry tax id');
 await rejects(run(prep,tx=>parties.updateParty(tx,prep,entity.id,party.id,99,{legalName:'Northwind Services',roles:['customer'],identityStatus:'unknown',address:'Cebu City'})),'VERSION_CONFLICT','stale version');
 const known=await run(prep,tx=>parties.updateParty(tx,prep,entity.id,party.id,party.version,{legalName:'Northwind Services',roles:['customer','supplier'],identityStatus:'known',taxId:'123-456-789-000',address:'Cebu City'}));
 assert.equal(known.taxIdMasked,'•••••••••000');assert.deepEqual(known.roles,['customer','supplier']);assert.equal(known.contentVersion,2);
 assert.equal((await identityTasks()).filter(t=>t.state!=='resolved').length,0,'identity task resolved by the update');
 const stored=(await run(prep,tx=>tx.query('select tax_id_encrypted from lara.party where id=$1',[party.id]))).rows[0].tax_id_encrypted;
 assert.ok(stored.startsWith('v1.')&&!stored.includes('123-456'));assert.equal(parties.decryptField(stored),'123-456-789-000');
 const kept=await run(prep,tx=>parties.updateParty(tx,prep,entity.id,party.id,known.version,{legalName:'Northwind Services',roles:['customer','supplier'],identityStatus:'known',address:'Cebu City, Lapu-Lapu'}));
 assert.equal(kept.taxIdMasked,'•••••••••000','known identity keeps its stored identifier when the edit omits it');
 const dup=await run(prep,tx=>parties.createParty(tx,prep,entity.id,{legalName:'North Wind Services',roles:['supplier'],identityStatus:'not_applicable',address:'Cebu'}));
 const search=await run(prep,tx=>parties.listParties(tx,prep,entity.id,{q:'northwind'}));
 assert.deepEqual(search.items.map(p=>p.id),[party.id]);
 const merged=await run(prep,tx=>parties.mergeParty(tx,prep,entity.id,dup.id,party.id,{reason:'Duplicate supplier record'}));
 assert.equal(merged.mergedSourceId,dup.id);
 const source=await run(prep,tx=>parties.getParty(tx,prep,entity.id,dup.id));
 assert.equal(source.state,'archived');assert.equal(source.mergedInto,party.id);
 await rejects(run(prep,tx=>parties.mergeParty(tx,prep,entity.id,dup.id,party.id,{reason:'again'})),'STATE_CONFLICT','double merge');
 await rejects(run(prep,tx=>parties.updateParty(tx,prep,entity.id,dup.id,source.version,{legalName:'x',roles:['supplier'],identityStatus:'not_applicable',address:'y'})),'STATE_CONFLICT','archived party immutable');
 pass('parties: unknown identity raises one task, known identity requires an encrypted tax id shown masked, roles only accumulate, search is normalized and merge archives the source as an alias');

 // P02-T05 evidence
 const store=new evidence.MemoryEvidenceStore(),scanner=new evidence.FixtureScanner();
 const pdf=Buffer.from('%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\n%%EOF\n');
 const reg=await run(prep,tx=>evidence.registerUpload(tx,prep,entity.id,{filename:'invoice.pdf',mime:'application/pdf',byteCount:pdf.length,sha256:sha(pdf),classification:'confidential'}));
 assert.equal(reg.state,'quarantined');
 const mismatch=await run(prep,tx=>evidence.completeUpload(tx,prep,entity.id,reg.evidenceId,Buffer.concat([pdf,Buffer.from('tampered')]),store));
 assert.equal(mismatch.outcome,'rejected');assert.match(mismatch.reasons.join(';'),/checksum/);
 assert.equal((await run(prep,tx=>evidence.getEvidence(tx,prep,entity.id,reg.evidenceId))).state,'rejected','rejection persisted after commit');
 assert.equal(store.objects.size,0,'nothing stored on rejection');
 const exe=Buffer.from('MZ     not really a pdf');
 const regExe=await run(prep,tx=>evidence.registerUpload(tx,prep,entity.id,{filename:'statement.pdf',mime:'application/pdf',byteCount:exe.length,sha256:sha(exe),classification:'internal'}));
 const exeResult=await run(prep,tx=>evidence.completeUpload(tx,prep,entity.id,regExe.evidenceId,exe,store));
 assert.equal(exeResult.outcome,'rejected');assert.match(exeResult.reasons.join(';'),/declared type/);
 const eicar=Buffer.from('date,amount\n2026-09-18,X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*\n');
 const regEicar=await run(prep,tx=>evidence.registerUpload(tx,prep,entity.id,{filename:'lines.csv',mime:'text/csv',byteCount:eicar.length,sha256:sha(eicar),classification:'internal'}));
 const eicarResult=await run(prep,tx=>evidence.completeUpload(tx,prep,entity.id,regEicar.evidenceId,eicar,store));
 assert.equal(eicarResult.outcome,'scanning');assert.equal(eicarResult.job.state,'queued');
 const workerCtx={tenantId:A.tenantId,principalId:null,traceId:'worker'};
 const scanned=await run(workerCtx,tx=>evidence.recordScan(tx,workerCtx,entity.id,regEicar.evidenceId,scanner,store));
 assert.equal(scanned.state,'rejected');assert.equal(store.objects.size,0,'infected object disposed');
 await rejects(run(prep,tx=>evidence.readContent(tx,prep,entity.id,regEicar.evidenceId,store)),'EVIDENCE_NOT_READY','rejected content never served');
 const regOk=await run(prep,tx=>evidence.registerUpload(tx,prep,entity.id,{filename:'invoice.pdf',mime:'application/pdf',byteCount:pdf.length,sha256:sha(pdf),classification:'confidential'}));
 const okResult=await run(prep,tx=>evidence.completeUpload(tx,prep,entity.id,regOk.evidenceId,pdf,store));
 assert.equal(okResult.outcome,'scanning');
 await rejects(run(prep,tx=>evidence.readContent(tx,prep,entity.id,regOk.evidenceId,store)),'EVIDENCE_NOT_READY','scanning content not served');
 const available=await run(workerCtx,tx=>evidence.recordScan(tx,workerCtx,entity.id,regOk.evidenceId,scanner,store));
 assert.equal(available.state,'available');
 const content=await run(prep,tx=>evidence.readContent(tx,prep,entity.id,regOk.evidenceId,store));
 assert.ok(content.bytes.equals(pdf));
 await rejects(run(prep,tx=>evidence.registerUpload(tx,prep,entity.id,{filename:'copy.pdf',mime:'application/pdf',byteCount:pdf.length,sha256:sha(pdf),classification:'confidential'})),'DUPLICATE_SOURCE','duplicate available content');
 await rejects(run(clerk,tx=>evidence.readContent(tx,clerk,entityB.id,regOk.evidenceId,store)),'NOT_FOUND','foreign entity content');
 const job=(await run(workerCtx,tx=>tx.query("select * from lara.jobs where tenant_id=$1 and kind='evidence.scan' order by created_at desc limit 1",[A.tenantId]))).rows[0];
 assert.equal(job.requested_by,A.principals.preparer);assert.ok(Number(job.revocation_version)>=1);
 pass('evidence: checksum mismatch, executable disguised as PDF and infected fixture never become available; clean content becomes available only after the scan and streams only to authorized members');
 const evidenceId=regOk.evidenceId;

 // P02-T04 missing-evidence task tied to an onboarding check
 const check=(await run(ctrl,tx=>tx.query("insert into lara.onboarding_checks(tenant_id,entity_id,check_code,created_by) values($1,$2,'retention_policy',$3) returning id",[A.tenantId,entity.id,A.principals.controller]))).rows[0];
 const t1=await run(prep,tx=>workflow.openTask(tx,prep,entity.id,{kind:'missing_evidence',sourceType:'onboarding_check',sourceId:check.id,reason:'Retention policy document required'},{causeKey:'retention_policy'}));
 const t2=await run(prep,tx=>workflow.openTask(tx,prep,entity.id,{kind:'missing_evidence',sourceType:'onboarding_check',sourceId:check.id,reason:'Retention policy document required'},{causeKey:'retention_policy'}));
 assert.equal(t1.created,true);assert.equal(t2.created,false);assert.equal(t2.task.id,t1.task.id);
 const assigned=await run(prep,tx=>workflow.assignTask(tx,prep,entity.id,t1.task.id,{ownerId:A.principals.clerk,reason:'Clerk collects documents'}));
 assert.equal(assigned.state,'assigned');
 await rejects(run(clerk,tx=>workflow.updateTask(tx,clerk,entity.id,t1.task.id,assigned.version,{kind:'missing_evidence',sourceType:'onboarding_check',sourceId:check.id,reason:'Waiting for supplier'},{state:'waiting_for_information'})),'STATE_CONFLICT','waiting requires due date');
 const waiting=await run(clerk,tx=>workflow.updateTask(tx,clerk,entity.id,t1.task.id,assigned.version,{kind:'missing_evidence',sourceType:'onboarding_check',sourceId:check.id,reason:'Waiting for supplier',dueAt:'2026-09-25T00:00:00Z'},{state:'waiting_for_information'}));
 assert.equal(waiting.state,'waiting_for_information');assert.equal(waiting.ownerId,A.principals.clerk);
 await rejects(run(clerk,tx=>workflow.resolveTask(tx,clerk,entity.id,t1.task.id,{reason:'Done'})),'EVIDENCE_NOT_READY','resolution needs evidence');
 await rejects(run(clerk,tx=>workflow.resolveTask(tx,clerk,entity.id,t1.task.id,{reason:'Done',evidenceIds:[regEicar.evidenceId]})),'EVIDENCE_NOT_READY','rejected evidence cannot resolve');
 const resolved=await run(clerk,tx=>workflow.resolveTask(tx,clerk,entity.id,t1.task.id,{reason:'Policy document attached',evidenceIds:[evidenceId]}));
 assert.equal(resolved.state,'resolved');
 const checkRow=(await run(ctrl,tx=>tx.query('select status,evidence_id from lara.onboarding_checks where id=$1',[check.id]))).rows[0];
 assert.deepEqual(checkRow,{status:'passed',evidence_id:evidenceId});
 assert.equal((await run(prep,tx=>workflow.listTasks(tx,prep,entity.id,{sourceId:check.id}))).items.length,1,'no duplicate task for the same check');
 await run(clerk,tx=>workflow.commentTask(tx,clerk,entity.id,t1.task.id,{body:'Filed under retention.',evidenceIds:[evidenceId]}));
 assert.equal((await run(clerk,tx=>workflow.taskComments(tx,clerk,entity.id,t1.task.id))).length,1);
 const mine=await run(clerk,tx=>workflow.listTasks(tx,clerk,entity.id,{ownerId:A.principals.clerk,status:'resolved'}));
 assert.deepEqual(mine.items.map(t=>t.id),[t1.task.id]);
 pass('tasks: one active task per cause, assignment and waiting states keep owner and due date, resolution needs available evidence and passes the related onboarding check without duplicates');

 // Obligations from versioned templates
 const o1=await run(prep,tx=>workflow.createObligation(tx,prep,entity.id,{kind:'vat_return',periodKey:'2026-09',dueAt:'2026-10-20T00:00:00Z',ownerId:A.principals.controller,ruleVersion:'2026.1'}));
 assert.equal(o1.created,true);
 const o1v2=await run(prep,tx=>workflow.createObligation(tx,prep,entity.id,{kind:'vat_return',periodKey:'2026-09',dueAt:'2026-10-25T00:00:00Z',ownerId:A.principals.controller,ruleVersion:'2026.2'}));
 assert.equal(o1v2.created,false);assert.equal(o1v2.obligation.id,o1.obligation.id);assert.equal(o1v2.obligation.ruleVersion,'2026.2');
 await rejects(run(prep,tx=>workflow.completeObligation(tx,prep,entity.id,o1.obligation.id,{reason:'Filed'})),'EVIDENCE_NOT_READY','completion needs evidence');
 const done=await run(ctrl,tx=>workflow.completeObligation(tx,ctrl,entity.id,o1.obligation.id,{reason:'Filed with confirmation',evidenceIds:[evidenceId]}));
 assert.equal(done.state,'completed');
 const o1v3=await run(prep,tx=>workflow.createObligation(tx,prep,entity.id,{kind:'vat_return',periodKey:'2026-09',dueAt:'2026-10-30T00:00:00Z',ownerId:A.principals.controller,ruleVersion:'2026.3'}));
 assert.equal(o1v3.retained,true);assert.equal(o1v3.obligation.ruleVersion,'2026.2','completed obligation keeps its rule version and evidence');
 await rejects(run(prep,tx=>workflow.updateObligation(tx,prep,entity.id,o1.obligation.id,o1v3.obligation.version,{kind:'vat_return',periodKey:'2026-09',dueAt:'2026-11-01T00:00:00Z',ownerId:A.principals.controller,ruleVersion:'2026.9'})),'STATE_CONFLICT','completed obligation immutable');
 const calendar=await run(prep,tx=>workflow.listObligations(tx,prep,entity.id,{from:'2026-10-01T00:00:00Z',to:'2026-10-31T00:00:00Z'}));
 assert.equal(calendar.items.length,1);
 pass('obligations instantiate once per kind, period and profile; template re-runs update open obligations and retain completed evidence');

 // P02-T02 revocation denies queued export
 const security=await ctxFor(A,'security');
 const exporterRole=(await run(security,tx=>identity.createRole(tx,security,{code:'exporter',name:'Exporter',permissions:['evidence.export','evidence.read','session.read']})));
 await rejects(run(security,tx=>identity.approveRole(tx,security,exporterRole.id,{decision:'approve',contentVersion:1})),'FORBIDDEN','security admin holds no role approval authority');
 await rejects(run(ctrl,tx=>identity.approveRole(tx,ctrl,exporterRole.id,{decision:'approve',contentVersion:2})),'VERSION_CONFLICT','approval binds the reviewed content version');
 await run(ctrl,tx=>identity.approveRole(tx,ctrl,exporterRole.id,{decision:'approve',contentVersion:1}));
 await rejects(run(security,tx=>identity.createMembership(tx,security,entity.id,{principalId:A.principals.exporter,roleId:A.roles.clerk,branchIds:[randomUUID()]})),'NOT_FOUND','unknown branch scope');
 const membership=await run(security,tx=>identity.createMembership(tx,security,entity.id,{principalId:A.principals.exporter,roleId:exporterRole.id,branchIds:[]}));
 let exporter=await ctxFor(A,'exporter');
 assert.ok(exporter.permissions.has('evidence.export'));assert.ok(exporter.entityIds.has(entity.id));
 const exportJob=await run(exporter,tx=>enqueueJob(tx,exporter,{entityId:entity.id,kind:'export.tasks',payload:{format:'csv'}}));
 const jobRow=async()=>(await run(workerCtx,tx=>tx.query('select * from lara.jobs where id=$1',[exportJob.id]))).rows[0];
 const queued=await jobRow();
 await run(workerCtx,tx=>identity.assertJobStillAuthorized(tx,queued,'evidence.export'));
 await run(security,tx=>identity.revokeMembership(tx,security,entity.id,membership.id,{reason:'Contract ended'}));
 await rejects(run(workerCtx,tx=>identity.assertJobStillAuthorized(tx,queued,'evidence.export')),'FORBIDDEN','queued export denied after revocation');
 exporter=await ctxFor(A,'exporter');
 assert.equal(exporter.permissions.size,0);assert.equal(exporter.entityIds.size,0);
 await rejects(run(exporter,tx=>evidence.getEvidence(tx,exporter,entity.id,evidenceId)),'FORBIDDEN','revoked principal has no permissions');
 const widened=await run(security,tx=>identity.updateRole(tx,security,exporterRole.id,2,{code:'exporter',name:'Exporter',permissions:['evidence.export','evidence.read','session.read','period.lock']}));
 assert.equal(widened.state,'draft');assert.equal(widened.contentVersion,2,'editing an approved role opens a new content version awaiting approval');
 await rejects(run(security,tx=>identity.createMembership(tx,security,entity.id,{principalId:A.principals.exporter,roleId:exporterRole.id,branchIds:[]})),'STATE_CONFLICT','draft role cannot be assigned');
 pass('memberships: security admin cannot approve roles, approval binds the content version, exporter gains scoped permissions, revocation changes the revocation version so the already queued export is denied and the principal loses access');

 // Idempotent command envelope
 const key=randomUUID(),body={legalName:'Idempotent Party',roles:['customer'],identityStatus:'not_applicable',address:'Manila'};
 const first=await command(api,prep,{operation:'post_parties',idempotencyKey:key,entityId:entity.id,body,traceId:'t1'},async tx=>{const p=await parties.createParty(tx,prep,entity.id,body);return {resourceType:'party',resourceId:p.id,response:p};});
 const replay=await command(api,prep,{operation:'post_parties',idempotencyKey:key,entityId:entity.id,body,traceId:'t2'},async()=>assert.fail('must not execute twice'));
 assert.equal(replay.replayed,true);assert.equal(replay.resourceId,first.resourceId);assert.deepEqual(replay.response,first.response);
 await rejects(command(api,prep,{operation:'post_parties',idempotencyKey:key,entityId:entity.id,body:{...body,address:'Davao'}},async()=>assert.fail('conflict')),'IDEMPOTENCY_CONFLICT','same key different request');
 await rejects(command(api,prep,{operation:'post_parties',idempotencyKey:randomUUID(),entityId:entity.id,body},async tx=>{await parties.createParty(tx,prep,entity.id,body);throw new DomainError('STATE_CONFLICT','simulated failure');}),'STATE_CONFLICT','failure');
 assert.equal((await run(prep,tx=>parties.listParties(tx,prep,entity.id,{q:'idempotent'}))).items.length,1,'failed command left no party or receipt');
 await rejects(command(api,prep,{operation:'post_parties',entityId:entity.id,body},async()=>{}),'PRECONDITION_REQUIRED','missing key');
 const audits=(await run(ctrl,tx=>tx.query('select count(*)::int n,max(sequence)::int s from lara.audit_events where tenant_id=$1 and entity_id=$2',[A.tenantId,entity.id]))).rows[0];
 assert.ok(audits.n>20&&audits.n===audits.s,'audit chain is dense');
 const events=(await run(ctrl,tx=>tx.query('select event_type,count(*)::int n from lara.outbox_events where tenant_id=$1 group by 1 order by 1',[A.tenantId]))).rows;
 assert.ok(events.some(e=>e.event_type==='entity.activated.v1')&&events.some(e=>e.event_type==='evidence.available.v1')&&events.some(e=>e.event_type==='membership.changed.v1'));
 pass('commands replay by idempotency key, conflict on a different request, leave nothing behind on failure, and every effect wrote audit and outbox rows in the same transaction');
 console.log('PASS P02-02 domain: '+step+' groups');
}finally{
 await owner.query("select set_config('lara.maintenance','teardown',false)");
 for(const id of tenants){
  await owner.query("select set_config('lara.tenant_id',$1,false)",[id]);
  for(const table of ['audit_events','audit_chain_heads','inbox_receipts','outbox_events','jobs','command_receipts','approval_decisions','approval_requests','obligations','task_comments','tasks','evidence_links','party_bank_accounts','party_roles','party','evidence','settings_versions','onboarding_checks','capability_activations','approval_policies','delegation','memberships','roles','principals','books','branches','entities']){
   if(table==='inbox_receipts')await owner.query('delete from lara.inbox_receipts where event_id in (select event_id from lara.outbox_events where tenant_id=$1)',[id]);
   else await owner.query('delete from lara.'+table+' where tenant_id=$1',[id]);
  }
  await owner.query('delete from lara.tenants where id=$1',[id]);
 }
 await Promise.all([api.end(),owner.end()]);
}
