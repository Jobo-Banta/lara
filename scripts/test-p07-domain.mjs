// P07-02 compliance domain against real PostgreSQL through the runtime role:
// P07-T01 a form mapping with its golden fixture and each validation-failure
// class (missing mapping, missing artifact, expired profile); P07-T02 return,
// source and ledger totals tie and a replay of the same cutoff and profile
// reproduces the hash; P07-T03 a lost acknowledgement recovers by status
// query without a second submission; P07-T04 unsigned, wrong-taxpayer and
// expired-profile transmissions are blocked; P07-T05 a generated pack never
// marks the permit or the filing complete. Test tenants are removed at the end.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createHash,randomUUID,randomBytes} from 'node:crypto';
import {loadLocalEnv} from './local-env.mjs';
import {connectionOptions} from '../packages/database/src/connection.mjs';
import {DomainError,inTransaction,identity,organization,ledger,evidence,parties,sales,compliance} from '../packages/domain/src/index.mjs';
const {MemoryEvidenceStore,FixtureScanner}=evidence;
import {removeTenants} from './tenant-teardown.mjs';
loadLocalEnv();
process.env.FIELD_ENCRYPTION_KEY??=randomBytes(32).toString('hex');
const pg=createRequire(new URL('../packages/database/package.json',import.meta.url))('pg');
const client=url=>new pg.Client({...connectionOptions(url),connectionTimeoutMillis:15000,query_timeout:30000});
const api=client(process.env.DATABASE_URL),owner=client(process.env.LARA_MIGRATOR_DATABASE_URL||process.env.SUPABASE_LARA_MIGRATOR_DATABASE_URL||process.env.MIGRATION_DATABASE_URL||process.env.SUPABASE_OWNER_DATABASE_URL);
await Promise.all([api.connect(),owner.connect()]);
const sha=b=>createHash('sha256').update(b).digest('hex');
const suffix=randomBytes(3).toString('hex'),tenantId=randomUUID();
let step=0;const pass=l=>console.log('PASS '+(++step)+': '+l);
async function rejects(promise,code,label){try{await promise;}catch(e){assert.ok(e instanceof DomainError,label+': not a DomainError: '+e.stack);assert.equal(e.code,code,label+': '+e.message);return e;}assert.fail(label+' should fail with '+code);}
const run=(ctx,fn,db=api)=>inTransaction(db,ctx,fn);
const env={FIELD_ENCRYPTION_KEY:process.env.FIELD_ENCRYPTION_KEY};
try{
 const principals={},roles={};
 await run({tenantId,principalId:null},async tx=>{
  await organization.provisionTenant(tx,{id:tenantId,slug:'dom-comp-'+suffix,name:'Compliance domain',mode:'demo'});
  for(const n of ['billing','accountant','tax','controller','director','security'])principals[n]=(await identity.resolvePrincipal(tx,tenantId,{issuer:'https://identity.invalid',subject:n+'-'+suffix,displayName:n})).id;
  for(const code of ['billing','accountant','tax','controller','security_admin'])roles[code]=(await tx.query("insert into lara.roles(tenant_id,code,name,permissions,status,content_hash,created_by,protected) select $1,code,name,permissions,'approved',$2,$3,true from lara.role_templates where code=$4 returning id",[tenantId,sha(code),principals.security,code])).rows[0].id;
  for(const [p,r] of [['billing','billing'],['accountant','accountant'],['tax','tax'],['controller','controller'],['director','controller'],['security','security_admin']])await tx.query('insert into lara.memberships(tenant_id,principal_id,role_id,created_by) values($1,$2,$3,$4)',[tenantId,principals[p],roles[r],principals.security]);
 });
 const ctxFor=n=>run({tenantId,principalId:principals[n]},tx=>identity.actorContext(tx,tenantId,principals[n],{traceId:'comp-'+n}));
 let ctrl=await ctxFor('controller');
 const entityId=(await run(ctrl,tx=>organization.createEntity(tx,ctrl,{legalName:'Compliance Co',baseCurrency:'PHP',timezone:'Asia/Manila',fiscalYearStartMonth:1}))).id;
 ctrl=await ctxFor('controller');
 const bill=await ctxFor('billing'),acc=await ctxFor('accountant'),tax=await ctxFor('tax'),dir=await ctxFor('director');
 const branch=await run(ctrl,tx=>organization.createBranch(tx,ctrl,entityId,{code:'HQ',name:'Head office',address:'Makati'}));
 for(const cap of ['workspace','general_ledger','sales','purchasing','treasury'])await run(ctrl,tx=>tx.query("insert into lara.capability_activations(tenant_id,entity_id,capability,status,profile_version,approved_by,activated_at,created_by) values($1,$2,$3,'active','p.1',$4,now(),$5)",[tenantId,entityId,cap,principals.director,principals.controller]));
 const book=await run(ctrl,tx=>ledger.createBook(tx,ctrl,entityId,{code:'php-main',kind:'primary',functionalCurrency:'PHP',sourceOwner:'lara'}));
 const mk=(code,name,category,extra={})=>run(acc,tx=>ledger.createAccount(tx,acc,entityId,{bookId:book.id,code,name,category,controlType:'none',requiredDimensions:[],...extra}));
 const cash=await mk('1010','Cash','asset'),ar=await mk('1200','Receivables','asset',{controlType:'ar'}),outTax=await mk('2200','Output tax','liability',{controlType:'output_tax'}),revenue=await mk('4000','Revenue','income');
 for(const [s,e] of [['2026-07-01','2026-07-31'],['2026-08-01','2026-08-31'],['2026-09-01','2026-09-30']])await run(ctrl,tx=>ledger.createPeriod(tx,ctrl,entityId,{bookId:book.id,startsOn:s,endsOn:e}));
 const customer=await run(bill,tx=>parties.createParty(tx,bill,entityId,{legalName:'Acme Trading',roles:['customer'],identityStatus:'unknown',address:'Cebu'},env));
 const approve=async(kind,payload)=>{const s=await run(ctrl,tx=>organization.saveSettings(tx,ctrl,entityId,kind,payload));await run(dir,tx=>organization.approveSettings(tx,dir,entityId,s.id,{payloadHash:s.payloadHash}));};
 await approve('sales_profile',{arAccountId:ar.id,outputTaxAccountId:outTax.id,cashAccountId:cash.id,scale:2,dueDays:30,reportingRequired:false});
 await run(ctrl,tx=>tx.query("insert into lara.document_series(tenant_id,entity_id,branch_id,kind,prefix,profile_version,created_by) values($1,$2,$3,'invoice','INV','numbering-2026',$4),($1,$2,$3,'credit_note','CN','numbering-2026',$4)",[tenantId,entityId,branch.id,principals.controller]));
 const store=new MemoryEvidenceStore();
 const upload=async(name,content,mime='application/pdf',who=tax)=>{const bytes=Buffer.from(content);const reg=await run(who,tx=>evidence.registerUpload(tx,who,entityId,{filename:name,mime,byteCount:bytes.length,sha256:sha(bytes),classification:'internal'}));await run(who,tx=>evidence.completeUpload(tx,who,entityId,reg.evidenceId,bytes,store));await run({tenantId,principalId:null},tx=>evidence.recordScan(tx,{tenantId,principalId:null},entityId,reg.evidenceId,new FixtureScanner(),store));return reg.evidenceId;};
 const circular=await upload('rr-2026.pdf','%PDF-1.4 revenue regulation\n');
 const ruleBody=(code,rate,extra={})=>({code,taxType:'vat',validFrom:'2026-01-01',rate,basis:'net',recognition:'issue',rounding:'line_half_up',applicabilityProfileId:randomUUID(),sourceEvidenceIds:[circular],goldenCaseIds:['AC-01'],...extra});
 const vat=await run(tax,tx=>sales.createTaxRule(tx,tax,entityId,ruleBody('VAT12','0.12')));
 await run(ctrl,tx=>sales.approveTaxRule(tx,ctrl,entityId,vat.id,{decision:'approve',contentVersion:1}));await run(ctrl,tx=>sales.activateTaxRule(tx,ctrl,entityId,vat.id,{reason:'Effective'}));
 const line=(price,extra={})=>({description:'Services',quantity:'1',unitPrice:price,discount:'0',priceBasis:'exclusive',accountId:revenue.id,taxCodeId:vat.id,dimensions:{},...extra});
 const issue=async(kind,price,date,extra={})=>{const d=await run(bill,tx=>sales.createDocument(tx,bill,entityId,{kind,branchId:branch.id,bookId:book.id,partyId:customer.id,documentDate:date,accountingDate:date,currency:'PHP',ruleProfileVersion:'ph-2026',lines:[line(price,extra)],evidenceIds:[]}));await run(bill,tx=>sales.submitDocument(tx,bill,entityId,d.id,{}));await run(acc,tx=>sales.approveDocument(tx,acc,entityId,d.id,{decision:'approve',contentVersion:1}));return run(acc,tx=>sales.postDocument(tx,acc,entityId,d.id,{}));};
 const invA=await issue('invoice','10000','2026-07-05'),invB=await issue('invoice','5000','2026-08-20');
 const cn=await run(acc,tx=>sales.correctDocument(tx,acc,entityId,invA.resourceId,{kind:'credit_note',accountingDate:'2026-08-25',reason:'Scope reduced',lines:[line('2000')]}));
 await run(bill,tx=>sales.submitDocument(tx,bill,entityId,cn.resourceId,{}));await run(ctrl,tx=>sales.approveDocument(tx,ctrl,entityId,cn.resourceId,{decision:'approve',contentVersion:1}));await run(acc,tx=>sales.postDocument(tx,acc,entityId,cn.resourceId,{}));
 pass('fixture: VAT rule, two issued invoices (July 10,000; August 5,000) and an August credit note of 2,000 with their tax events');

 // Capability gate, compliance profile, regulatory profile and the mapping artifact.
 await rejects(run(tax,tx=>compliance.createReturn(tx,tax,entityId,{formCode:'2550Q',periodStart:'2026-07-01',periodEnd:'2026-09-30',profileVersion:'ph-2026',dataCutoff:new Date().toISOString()})),'FEATURE_NOT_ENABLED','returns before the compliance capability');
 await run(ctrl,tx=>tx.query("insert into lara.capability_activations(tenant_id,entity_id,capability,status,profile_version,approved_by,activated_at,created_by) values($1,$2,'compliance','active','p07.1',$3,now(),$4)",[tenantId,entityId,principals.director,principals.controller]));
 await approve('compliance_profile',{jurisdiction:'PH',taxpayerId:'123-456-789-000',transport:'fixture',destination:'fixture-authority',deadlineHours:72,signingKeyRef:'TEST_EINVOICE_KEY',credentialsRef:'TEST_EINVOICE_CREDENTIALS',reportedKinds:['invoice','credit_note'],profileVersion:'compliance-2026'});
 const cutoff=new Date().toISOString();
 const ret=await run(tax,tx=>compliance.createReturn(tx,tax,entityId,{formCode:'2550Q',periodStart:'2026-07-01',periodEnd:'2026-09-30',profileVersion:'ph-2026',dataCutoff:cutoff}));
 assert.equal(ret.state,'draft');
 await rejects(run(tax,tx=>compliance.prepareReturn(tx,tax,entityId,ret.id,{},undefined,{store})),'RULE_PROFILE_NOT_APPROVED','prepare without an active regulatory profile');
 const reg=await run(tax,tx=>compliance.createRegulatoryProfile(tx,tax,entityId,{jurisdiction:'PH',coverage:['2550Q','1601EQ'],validFrom:'2026-01-01',validTo:'2026-12-31',evidenceIds:[circular]}));
 await rejects(run(tax,tx=>compliance.approveRegulatoryProfile(tx,tax,entityId,reg.id)),'FORBIDDEN','tax officer approving the regulatory profile');
 await rejects(run(ctrl,tx=>compliance.activateRegulatoryProfile(tx,ctrl,entityId,reg.id,{reason:'x'})),'STATE_CONFLICT','activation before approval');
 await run(ctrl,tx=>compliance.approveRegulatoryProfile(tx,ctrl,entityId,reg.id));
 await run(ctrl,tx=>compliance.activateRegulatoryProfile(tx,ctrl,entityId,reg.id,{reason:'Current official artifacts reviewed'}));
 await rejects(run(tax,tx=>compliance.prepareReturn(tx,tax,entityId,ret.id,{},undefined,{store})),'RULE_PROFILE_NOT_APPROVED','prepare without an approved mapping artifact');
 const mappingCsv=['line_code,description,family,tax_type,recognition,kinds,measure,sign','12A,Vatable sales,sales,vat,any,invoice,basis,1','12B,Output tax due,sales,vat,any,invoice,amount,1','13A,Sales returns and credits,sales,vat,any,credit_note,basis,1','13B,Output tax on credits,sales,vat,any,credit_note,amount,1'].join('\n')+'\n';
 const mappingEvidence=await upload('2550q-mapping-v1.csv',mappingCsv,'text/csv');
 const art=await run(tax,tx=>compliance.importArtifact(tx,tax,entityId,{profileId:reg.id,artifactType:'form_mapping',code:'2550Q',versionLabel:'2026-v1',evidenceId:mappingEvidence,goldenCaseIds:['AC-01']}));
 assert.equal(art.hash,sha(Buffer.from(mappingCsv)));
 await rejects(run(tax,tx=>compliance.approveArtifact(tx,tax,entityId,art.id)),'FORBIDDEN','tax officer approving the artifact');
 await run(ctrl,tx=>compliance.approveArtifact(tx,ctrl,entityId,art.id));
 const ready=await run(tax,tx=>compliance.readiness(tx,tax,entityId,{TEST_EINVOICE_KEY:'k',TEST_EINVOICE_CREDENTIALS:'123-456-789-000:secret'}));
 assert.deepEqual([ready.capability,ready.regulatoryProfile,ready.signingKey,ready.credentials,ready.forms.map(f=>f.code+':'+f.mapping)],['ready','ready','ready','ready',['1601EQ:not_tested','2550Q:ready']]);
 pass('P07-T01: returns need the capability, an active regulatory profile approved and activated by another principal, and an approved mapping artifact imported from reviewed CSV evidence with its hash; readiness names each form as ready or not tested');

 // P07-T02: preparation computes lines from tax events at the cutoff, ties to the ledger, and replays to the same hash.
 const prepared=await run(tax,tx=>compliance.prepareReturn(tx,tax,entityId,ret.id,{},undefined,{store}));
 assert.equal(prepared.state,'prepared');
 const view=await run(tax,tx=>compliance.returnLines(tx,tax,entityId,ret.id));
 assert.deepEqual(view.lines.map(l=>[l.lineCode,l.basis,l.amount,l.eventCount]),[['12A','15000.00','1800.00',2],['12B','15000.00','1800.00',2],['13A','-2000.00','-240.00',1],['13B','-2000.00','-240.00',1]]);
 assert.deepEqual([view.tieOut.events,view.tieOut.sourceAmount,view.tieOut.ledgerTaxMovement,view.tieOut.ties],[3,'1560.00','1560.00',true]);
 const drill=await run(tax,tx=>compliance.returnDrillDown(tx,tax,entityId,ret.id,'12B'));
 assert.deepEqual(drill.map(d=>[d.officialNumber,d.amount]),[['INV-000001','1200.00'],['INV-000002','600.00']]);
 // A later invoice after the cutoff does not change the replay; the same cutoff and profile reproduce the hash.
 await issue('invoice','1000','2026-09-15');
 const replay=await run(tax,tx=>compliance.prepareReturn(tx,tax,entityId,ret.id,{},undefined,{store}));
 assert.equal(replay.snapshotHash,prepared.snapshotHash,'replay of the frozen cutoff reproduces the hash');
 const moved=await run(tax,tx=>compliance.createReturn(tx,tax,entityId,{formCode:'2550Q',periodStart:'2026-07-01',periodEnd:'2026-09-30',profileVersion:'ph-2026',dataCutoff:new Date().toISOString()}));
 const later=await run(tax,tx=>compliance.prepareReturn(tx,tax,entityId,moved.id,{},undefined,{store}));
 assert.notEqual(later.snapshotHash,prepared.snapshotHash);
 assert.equal((await run(tax,tx=>compliance.returnLines(tx,tax,entityId,moved.id))).lines[0].basis,'16000.00');
 // Missing mapping: an unmapped event class blocks preparation instead of a plausible zero.
 const partial=['line_code,description,family,tax_type,recognition,kinds,measure,sign','12A,Vatable sales,sales,vat,any,invoice,basis,1'].join('\n')+'\n';
 const partialEvidence=await upload('2550q-mapping-v2.csv',partial,'text/csv');
 const art2=await run(tax,tx=>compliance.importArtifact(tx,tax,entityId,{profileId:reg.id,artifactType:'form_mapping',code:'2550Q',versionLabel:'2026-v2',evidenceId:partialEvidence}));
 await run(ctrl,tx=>compliance.approveArtifact(tx,ctrl,entityId,art2.id));
 const blocked=await rejects(run(tax,tx=>compliance.prepareReturn(tx,tax,entityId,moved.id,{},undefined,{store})),'STATE_CONFLICT','unmapped credit note events');
 assert.match(blocked.message,/credit_note/);
 const art3=await run(tax,tx=>compliance.importArtifact(tx,tax,entityId,{profileId:reg.id,artifactType:'form_mapping',code:'2550Q',versionLabel:'2026-v3',evidenceId:mappingEvidence}));
 await run(ctrl,tx=>compliance.approveArtifact(tx,ctrl,entityId,art3.id));
 assert.deepEqual((await run(tax,tx=>compliance.listArtifacts(tx,tax,entityId,{profileId:reg.id}))).map(a=>a.state),['superseded','superseded','approved'],'one approved mapping per form; earlier versions superseded');
 pass('P07-T02: lines derive from the tax events of the period at the cutoff (12A 15,000 / 12B 1,800 / credits −2,000 / −240), source and ledger totals tie, drill-down reaches the documents, replay reproduces the hash while a new cutoff differs, and an unmapped event class blocks preparation');

 // Independent approval and filing evidence.
 await rejects(run(tax,tx=>compliance.approveReturn(tx,tax,entityId,ret.id,{decision:'approve',contentVersion:3})),'FORBIDDEN','tax officer approving the return');
 await rejects(run(ctrl,tx=>compliance.approveReturn(tx,ctrl,entityId,ret.id,{decision:'approve',contentVersion:1})),'VERSION_CONFLICT','approval binds the prepared content version');
 const current=await run(tax,tx=>compliance.getReturn(tx,tax,entityId,ret.id));
 await run(ctrl,tx=>compliance.approveReturn(tx,ctrl,entityId,ret.id,{decision:'approve',contentVersion:current.contentVersion}));
 await rejects(run(tax,tx=>compliance.prepareReturn(tx,tax,entityId,ret.id,{},undefined,{store})),'STATE_CONFLICT','re-preparing an approved return');
 await rejects(run(tax,tx=>tx.query('delete from lara.return_lines where tenant_id=$1 and run_id=$2',[tenantId,ret.id])),'STATE_CONFLICT','lines of an approved return deleted');
 await rejects(run(tax,tx=>compliance.fileReturn(tx,tax,entityId,ret.id,{externalReference:'BIR-ACK-1',filedAt:'2026-10-20T08:00:00Z',evidenceIds:[]})),'VALIDATION_FAILED','filing without evidence');
 const ack=await upload('efps-ack.pdf','%PDF-1.4 filing acknowledgement\n');
 const filed=await run(tax,tx=>compliance.fileReturn(tx,tax,entityId,ret.id,{externalReference:'BIR-ACK-1',filedAt:'2026-10-20T08:00:00Z',evidenceIds:[ack]}));
 assert.equal(filed.state,'filed');
 assert.equal((await run(tax,tx=>compliance.returnLines(tx,tax,entityId,ret.id))).filing.externalReference,'BIR-ACK-1');
 // A correction run supersedes the filed one when it is filed.
 const correction=await run(tax,tx=>compliance.createReturn(tx,tax,entityId,{formCode:'2550Q',periodStart:'2026-07-01',periodEnd:'2026-09-30',profileVersion:'ph-2026',dataCutoff:new Date().toISOString()},{supersedesId:ret.id}));
 await run(tax,tx=>compliance.prepareReturn(tx,tax,entityId,correction.id,{},undefined,{store}));
 const cv=await run(tax,tx=>compliance.getReturn(tx,tax,entityId,correction.id));
 await run(ctrl,tx=>compliance.approveReturn(tx,ctrl,entityId,correction.id,{decision:'approve',contentVersion:cv.contentVersion}));
 await run(tax,tx=>compliance.fileReturn(tx,tax,entityId,correction.id,{externalReference:'BIR-ACK-2',filedAt:'2026-10-25T08:00:00Z',evidenceIds:[ack]}));
 assert.equal((await run(tax,tx=>compliance.getReturn(tx,tax,entityId,ret.id))).state,'superseded');
 pass('returns are approved by another principal against the prepared content version, frozen afterwards, recorded as filed only from the acknowledgement evidence, and corrected by a new linked run that supersedes the filed one');

 // Transmissions: reporting-required issuance queues an immutable signed payload; the worker functions send with the fixture transport.
 await approve('sales_profile',{arAccountId:ar.id,outputTaxAccountId:outTax.id,cashAccountId:cash.id,scale:2,dueDays:30,reportingRequired:true});
 const transport=new compliance.FixtureEInvoiceTransport(store);
 const good={TEST_EINVOICE_KEY:'test-signing-key',TEST_EINVOICE_CREDENTIALS:'123-456-789-000:secret'};
 const reported=await issue('invoice','800','2026-09-16');
 assert.ok(reported.jobId,'issuance queued the reporting job');
 const queued=(await run(tax,tx=>compliance.listTransmissions(tx,tax,entityId,{documentId:reported.resourceId})))[0];
 assert.deepEqual([queued.state,queued.payloadVersion,queued.attemptCount,queued.deadlineAt!==null],['queued',1,0,true]);
 assert.equal((await run(bill,tx=>sales.getDocument(tx,bill,entityId,reported.resourceId,{kinds:['invoice']}))).reportingState,'queued');
 // P07-T04: unsigned (no key), wrong taxpayer credentials and an expired profile are blocked and leave the job waiting.
 const noKey=await run(acc,tx=>compliance.transmit(tx,acc,entityId,queued.id,{transport,env:{TEST_EINVOICE_CREDENTIALS:good.TEST_EINVOICE_CREDENTIALS}}));
 assert.deepEqual([noKey.state,noKey.blocked,noKey.attemptCount],['retry_wait','DEPENDENCY_UNAVAILABLE',0],'no signing key: nothing sent');
 const wrongTaxpayer=await run(acc,tx=>compliance.transmit(tx,acc,entityId,queued.id,{transport,env:{TEST_EINVOICE_KEY:'k',TEST_EINVOICE_CREDENTIALS:'999-000-000-000:other'}}));
 assert.deepEqual([wrongTaxpayer.state,wrongTaxpayer.blocked],['retry_wait','FORBIDDEN'],'credentials of another taxpayer');
 assert.equal((await run(bill,tx=>sales.getDocument(tx,bill,entityId,reported.resourceId,{kinds:['invoice']}))).reportingState,'retry_wait');
 await run(ctrl,tx=>tx.query("update lara.regulatory_profiles set valid_to='2026-08-31' where tenant_id=$1 and id=$2",[tenantId,reg.id])).catch(()=>{});
 const expiredProfile=await run(tax,tx=>compliance.createRegulatoryProfile(tx,tax,entityId,{jurisdiction:'PH',coverage:['2550Q'],validFrom:'2026-01-01',validTo:'2026-08-31',evidenceIds:[circular]}));
 await run(ctrl,tx=>compliance.approveRegulatoryProfile(tx,ctrl,entityId,expiredProfile.id));await run(ctrl,tx=>compliance.activateRegulatoryProfile(tx,ctrl,entityId,expiredProfile.id,{reason:'test expiry'}));
 assert.equal((await run(acc,tx=>compliance.transmit(tx,acc,entityId,queued.id,{transport,env:good}))).blocked,'RULE_PROFILE_NOT_APPROVED','expired regulatory profile on the document date');
 const fresh=await run(tax,tx=>compliance.createRegulatoryProfile(tx,tax,entityId,{jurisdiction:'PH',coverage:['2550Q','1601EQ'],validFrom:'2026-01-01',validTo:null,evidenceIds:[circular]}));
 await run(ctrl,tx=>compliance.approveRegulatoryProfile(tx,ctrl,entityId,fresh.id));await run(ctrl,tx=>compliance.activateRegulatoryProfile(tx,ctrl,entityId,fresh.id,{reason:'current'}));
 const sent=await run(acc,tx=>compliance.transmit(tx,acc,entityId,queued.id,{transport,env:good}));
 assert.deepEqual([sent.state,sent.attemptCount,sent.remoteId?.startsWith('FX-')],['accepted',1,true]);
 assert.equal((await run(bill,tx=>sales.getDocument(tx,bill,entityId,reported.resourceId,{kinds:['invoice']}))).reportingState,'accepted');
 assert.equal((await run(acc,tx=>compliance.transmit(tx,acc,entityId,queued.id,{transport,env:good}))).attemptCount,1,'an accepted transmission is never resent');
 assert.equal((await run(acc,tx=>tx.query("select count(*)::int n from lara.outbox_events where tenant_id=$1 and event_type='transmission.accepted.v1'",[tenantId]))).rows[0].n,1);
 pass('P07-T04: a reporting-required issuance queues an immutable payload with the profile deadline; a missing signing key, another taxpayer\'s credentials and an expired regulatory profile block the send; with the current profile the signed payload is accepted once and the document reports accepted');

 // P07-T03: the response is lost after the authority accepted; reconciliation by status query recovers without a second submission.
 const lost=await issue('invoice','900','2026-09-17',{description:'Consulting LOSE-RESPONSE'});
 const lostJob=(await run(tax,tx=>compliance.listTransmissions(tx,tax,entityId,{documentId:lost.resourceId})))[0];
 const unknown=await run(acc,tx=>compliance.transmit(tx,acc,entityId,lostJob.id,{transport,env:good}));
 assert.deepEqual([unknown.state,unknown.attemptCount],['unknown',1]);
 await rejects(run(acc,tx=>compliance.transmit(tx,acc,entityId,lostJob.id,{transport,env:good})),'STATE_CONFLICT','resending an unknown outcome');
 await run(tax,tx=>compliance.requestReconcile(tx,tax,entityId,lostJob.id,{reason:'Worker lost the acknowledgement'}));
 const recovered=await run(tax,tx=>compliance.reconcile(tx,tax,entityId,lostJob.id,{transport}));
 assert.deepEqual([recovered.state,recovered.attemptCount,recovered.remoteId?.startsWith('FX-')],['accepted',1,true],'status query resolved the acceptance without a resend');
 const attempts=(await run(tax,tx=>compliance.listTransmissions(tx,tax,entityId,{documentId:lost.resourceId})))[0].attempts;
 assert.deepEqual(attempts.map(a=>a.outcome),['unknown','status_query']);
 // Envelope rejection retries as a new payload version; a financial rejection needs a correction document.
 const envelope=await issue('invoice','700','2026-09-18',{description:'Consulting REJECT-ENVELOPE'});
 const envJob=(await run(tax,tx=>compliance.listTransmissions(tx,tax,entityId,{documentId:envelope.resourceId})))[0];
 const rejected=await run(acc,tx=>compliance.transmit(tx,acc,entityId,envJob.id,{transport,env:good}));
 assert.equal(rejected.state,'rejected');
 await run(tax,tx=>compliance.requestRetry(tx,tax,entityId,envJob.id,{reason:'Fixed the schema field'}));
 const versions=await run(tax,tx=>compliance.listTransmissions(tx,tax,entityId,{documentId:envelope.resourceId}));
 assert.deepEqual(versions.map(v=>[v.payloadVersion,v.state]),[[1,'superseded'],[2,'queued']]);
 assert.notEqual(versions[1].payloadHash,versions[0].payloadHash,'a re-encoding is a new versioned hash');
 const financial=await issue('invoice','600','2026-09-19',{description:'Consulting REJECT-FINANCIAL'});
 const finJob=(await run(tax,tx=>compliance.listTransmissions(tx,tax,entityId,{documentId:financial.resourceId})))[0];
 await run(acc,tx=>compliance.transmit(tx,acc,entityId,finJob.id,{transport,env:good}));
 await rejects(run(tax,tx=>compliance.requestRetry(tx,tax,entityId,finJob.id,{reason:'again'})),'STATE_CONFLICT','retrying a financial rejection');
 await rejects(run(tax,tx=>tx.query("update lara.transmission_jobs set payload_json='{}' where tenant_id=$1 and id=$2",[tenantId,finJob.id])),'STATE_CONFLICT','payload edited');
 pass('P07-T03: a lost acknowledgement leaves the transmission unknown, a resend is refused, and the status query recovers the acceptance with no second submission; envelope rejections re-encode as a new payload version while financial rejections require a correction document');

 // P07-T05: the registration pack is evidence; neither the pack nor the submission marks the permit granted.
 await rejects(run(tax,tx=>compliance.recordRegistrationDecision(tx,tax,entityId,randomUUID(),{decision:'approved',reference:'x',evidenceId:ack})),'NOT_FOUND','decision on an unknown case');
 const packed=await run(tax,tx=>compliance.generateRegistrationPack(tx,tax,entityId,{authority:'BIR',scope:'2026-01-01..2026-12-31',store}));
 assert.equal(packed.case.state,'pack_generated');
 const pack=JSON.parse((await store.get((await run(tax,tx=>tx.query('select object_key from lara.evidence where tenant_id=$1 and id=$2',[tenantId,packed.evidenceId]))).rows[0].object_key)).toString());
 assert.deepEqual([pack.entity.legal_name,pack.regulatoryProfiles.length,pack.notice.includes('recorded separately')],['Compliance Co',1,true]);
 await rejects(run(tax,tx=>compliance.recordRegistrationDecision(tx,tax,entityId,packed.case.id,{decision:'approved',reference:'COR-1',evidenceId:ack})),'STATE_CONFLICT','decision on a generated pack');
 await run(tax,tx=>compliance.submitRegistrationCase(tx,tax,entityId,packed.case.id,{submittedAt:'2026-10-01T00:00:00Z'}));
 await rejects(run(tax,tx=>compliance.recordRegistrationDecision(tx,tax,entityId,packed.case.id,{decision:'approved',reference:'COR-1',evidenceId:randomUUID()})),'EVIDENCE_NOT_READY','decision without available evidence');
 const decided=await run(tax,tx=>compliance.recordRegistrationDecision(tx,tax,entityId,packed.case.id,{decision:'approved',reference:'COR-2026-001',evidenceId:ack,decidedAt:'2026-10-15T00:00:00Z'}));
 assert.deepEqual([decided.state,decided.decisionReference],['approved','COR-2026-001']);
 await rejects(run(tax,tx=>compliance.submitRegistrationCase(tx,tax,entityId,packed.case.id,{})),'STATE_CONFLICT','resubmitting a decided case');
 pass('P07-T05: the generated pack is restricted evidence for an application; the permit is recorded only from the authority\'s own decision reference and evidence after submission');
 console.log('P07-02 domain acceptance passed ('+step+' groups)');
}finally{
 await removeTenants(owner,[tenantId]);
 await Promise.all([api.end(),owner.end()]);
}
