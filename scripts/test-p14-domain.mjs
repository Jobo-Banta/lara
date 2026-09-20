// P14-02 firm workspace domain against real PostgreSQL through the runtime
// role with two client tenants and one firm tenant: P14-T01 revoking a
// mandate immediately invalidates the firm's cached counts and the
// delegate's queued work; P14-T02 staff assigned to client A cannot see or
// switch to client B; P14-T03 a bulk reminder fans out into independent
// per-client drafts without leakage; P14-T04 the same identity as maker
// through direct membership and approver through the firm stays prohibited;
// P14-T05 aggregates stay separated by entity and currency. Test tenants are
// removed at the end.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createHash,randomUUID,randomBytes} from 'node:crypto';
import {loadLocalEnv} from './local-env.mjs';
import {connectionOptions} from '../packages/database/src/connection.mjs';
import {DomainError,inTransaction,identity,organization,ledger,evidence,parties,sales,workflow,portals,firm} from '../packages/domain/src/index.mjs';
const {MemoryEvidenceStore,FixtureScanner}=evidence;
import {removeTenants} from './tenant-teardown.mjs';
loadLocalEnv();
process.env.FIELD_ENCRYPTION_KEY??=randomBytes(32).toString('hex');
const pg=createRequire(new URL('../packages/database/package.json',import.meta.url))('pg');
const client=url=>new pg.Client({...connectionOptions(url),connectionTimeoutMillis:15000,query_timeout:60000});
const api=client(process.env.DATABASE_URL),owner=client(process.env.LARA_MIGRATOR_DATABASE_URL||process.env.SUPABASE_LARA_MIGRATOR_DATABASE_URL||process.env.MIGRATION_DATABASE_URL||process.env.SUPABASE_OWNER_DATABASE_URL);
await Promise.all([api.connect(),owner.connect()]);
const sha=b=>createHash('sha256').update(b).digest('hex');
const suffix=randomBytes(3).toString('hex');
const T={firm:randomUUID(),a:randomUUID(),b:randomUUID()};
let step=0;const pass=l=>console.log('PASS '+(++step)+': '+l);
async function rejects(promise,code,label){try{await promise;}catch(e){assert.ok(e instanceof DomainError,label+': not a DomainError: '+e.stack);assert.equal(e.code,code,label+': '+e.message);return e;}assert.fail(label+' should fail with '+code);}
const run=(ctx,fn,db=api)=>inTransaction(db,ctx,fn);
const env={FIELD_ENCRYPTION_KEY:process.env.FIELD_ENCRYPTION_KEY};
const ISSUER='https://identity.invalid';
const store=new MemoryEvidenceStore();
const ctxFor=(tenantId,principalId,trace='firm')=>run({tenantId,principalId},tx=>identity.actorContext(tx,tenantId,principalId,{traceId:trace}));
// A client tenant with the workspace chain, a posted overdue invoice and the portal profile.
async function clientTenant(tenantId,slug,name,{overdueInvoice=true}={}){
 const principals={},roles={};
 await run({tenantId,principalId:null},async tx=>{
  await organization.provisionTenant(tx,{id:tenantId,slug,name,mode:'demo'});
  for(const n of ['billing','clerk','accountant','treasury','controller','director','security'])principals[n]=(await identity.resolvePrincipal(tx,tenantId,{issuer:ISSUER,subject:n+'-'+slug,displayName:n})).id;
  for(const code of ['billing','clerk','accountant','treasury','controller','security_admin'])roles[code]=(await tx.query("insert into lara.roles(tenant_id,code,name,permissions,status,content_hash,created_by,protected) select $1,code,name,permissions,'approved',$2,$3,true from lara.role_templates where code=$4 returning id",[tenantId,sha(code),principals.security,code])).rows[0].id;
  // No seeded template holds firm_mandate.create/edit/revoke or portal authorities; tenant roles cover the client's relations officer (noted for owner review).
  const role=async(code,perms)=>(await tx.query("insert into lara.roles(tenant_id,code,name,permissions,status,content_hash,created_by) values($1,$2,$2,$3,'approved',$4,$5) returning id",[tenantId,code,JSON.stringify(perms),sha(code),principals.security])).rows[0].id;
  roles.mandates=await role('mandates',['firm_mandate.create','firm_mandate.edit','firm_mandate.read','firm_mandate.revoke','firm_assignment.read','evidence.upload','evidence.read','message_request.read']);
  roles.approver=await role('mandate_approver',['firm_mandate.approve','firm_mandate.read','firm_assignment.read']);
  for(const [p,r] of [['billing','billing'],['clerk','clerk'],['accountant','accountant'],['treasury','treasury'],['controller','controller'],['controller','mandates'],['director','controller'],['director','approver'],['security','security_admin']])await tx.query('insert into lara.memberships(tenant_id,principal_id,role_id,created_by) values($1,$2,$3,$4)',[tenantId,principals[p],roles[r],principals.security]);
 });
 let ctrl=await ctxFor(tenantId,principals.controller);
 const entityId=(await run(ctrl,tx=>organization.createEntity(tx,ctrl,{legalName:name,baseCurrency:'PHP',timezone:'Asia/Manila',fiscalYearStartMonth:1}))).id;
 ctrl=await ctxFor(tenantId,principals.controller);
 const bill=await ctxFor(tenantId,principals.billing),clerk=await ctxFor(tenantId,principals.clerk),acc=await ctxFor(tenantId,principals.accountant),dir=await ctxFor(tenantId,principals.director);
 const branch=await run(ctrl,tx=>organization.createBranch(tx,ctrl,entityId,{code:'HQ',name:'Head office',address:'Makati'}));
 for(const cap of ['workspace','general_ledger','sales','purchasing','treasury','compliance','portals'])await run(ctrl,tx=>tx.query("insert into lara.capability_activations(tenant_id,entity_id,capability,status,profile_version,approved_by,activated_at,created_by) values($1,$2,$3,'active','p.1',$4,now(),$5)",[tenantId,entityId,cap,principals.director,principals.controller]));
 const book=await run(ctrl,tx=>ledger.createBook(tx,ctrl,entityId,{code:'php-main',kind:'primary',functionalCurrency:'PHP',sourceOwner:'lara'}));
 const mk=(code,name,category,extra={})=>run(acc,tx=>ledger.createAccount(tx,acc,entityId,{bookId:book.id,code,name,category,controlType:'none',requiredDimensions:[],...extra}));
 const cash=await mk('1010','Cash','asset'),ar=await mk('1200','Receivables','asset',{controlType:'ar'}),outTax=await mk('2200','Output tax','liability',{controlType:'output_tax'}),revenue=await mk('4000','Service revenue','income');
 for(const [s,e] of [['2026-06-01','2026-06-30'],['2026-10-01','2026-10-31']])await run(ctrl,tx=>ledger.createPeriod(tx,ctrl,entityId,{bookId:book.id,startsOn:s,endsOn:e}));
 const approve=async(kind,payload)=>{const s=await run(ctrl,tx=>organization.saveSettings(tx,ctrl,entityId,kind,payload));await run(dir,tx=>organization.approveSettings(tx,dir,entityId,s.id,{payloadHash:s.payloadHash}));};
 await approve('sales_profile',{arAccountId:ar.id,outputTaxAccountId:outTax.id,cashAccountId:cash.id,scale:2,dueDays:30});
 await approve('portal_profile',{messagingProvider:'local-mail',paymentProvider:'none',shareDays:14,termsVersion:'portal-2026',baseUrl:'https://portal.test.invalid'});
 await run(ctrl,tx=>tx.query("insert into lara.document_series(tenant_id,entity_id,branch_id,kind,prefix,profile_version,created_by) values($1,$2,$3,'invoice','INV','numbering-2026',$4)",[tenantId,entityId,branch.id,principals.controller]));
 const customer=await run(clerk,tx=>parties.createParty(tx,clerk,entityId,{legalName:name+' customer',roles:['customer'],identityStatus:'unknown',address:'Cebu'},env));
 if(overdueInvoice){const d=await run(bill,tx=>sales.createDocument(tx,bill,entityId,{kind:'invoice',branchId:branch.id,bookId:book.id,partyId:customer.id,documentDate:'2026-06-05',accountingDate:'2026-06-05',currency:'PHP',ruleProfileVersion:'ph-2026',lines:[{description:'Retainer',quantity:'1',unitPrice:'4000',discount:'0',priceBasis:'exclusive',accountId:revenue.id,dimensions:{}}],evidenceIds:[]}));await run(bill,tx=>sales.submitDocument(tx,bill,entityId,d.id,{}));await run(acc,tx=>sales.approveDocument(tx,acc,entityId,d.id,{decision:'approve',contentVersion:1}));await run(acc,tx=>sales.postDocument(tx,acc,entityId,d.id,{}));}
 await run(ctrl,tx=>workflow.createObligation(tx,ctrl,entityId,{kind:'vat_return',periodKey:'2026-06',dueAt:'2026-07-20T00:00:00Z',ownerId:principals.controller,ruleVersion:'bir-2026'}));
 const upload=async(who,name,content)=>{const bytes=Buffer.from(content);const reg=await run(who,tx=>evidence.registerUpload(tx,who,entityId,{filename:name,mime:'application/pdf',byteCount:bytes.length,sha256:sha(bytes),classification:'internal'}));await run(who,tx=>evidence.completeUpload(tx,who,entityId,reg.evidenceId,bytes,store));await run({tenantId,principalId:null},tx=>evidence.recordScan(tx,{tenantId,principalId:null},entityId,reg.evidenceId,new FixtureScanner(),store));return reg.evidenceId;};
 const engagement=await upload(ctrl,'engagement-letter.pdf','%PDF-1.4 engagement '+slug+String.fromCharCode(10));
 return {tenantId,entityId,principals,roles,ctrl,dir,acc,clerk,customer,engagement,book,branch,revenue};
}
try{
 // The firm tenant: a partner who owns the firm, a manager and a staff member.
 const firmPrincipals={};
 await run({tenantId:T.firm,principalId:null},async tx=>{
  await organization.provisionTenant(tx,{id:T.firm,slug:'dom-firm-'+suffix,name:'Ledger & Co',mode:'demo'});
  for(const n of ['partner','manager','staff','security'])firmPrincipals[n]=(await identity.resolvePrincipal(tx,tenantId(),{issuer:ISSUER,subject:n+'-firm-'+suffix,displayName:n})).id;
  function tenantId(){return T.firm;}
  const role=async(code,perms)=>(await tx.query("insert into lara.roles(tenant_id,code,name,permissions,status,content_hash,created_by) values($1,$2,$2,$3,'approved',$4,$5) returning id",[T.firm,code,JSON.stringify(perms),sha(code),firmPrincipals.security])).rows[0].id;
  const partnerRole=await role('firm_partner',['firm_assignment.create','firm_assignment.read','firm_mandate.read','session.read','entity.create','entity.read']),staffRole=await role('firm_staff',['firm_assignment.read','firm_mandate.read','session.read']);
  for(const [p,r] of [['partner',partnerRole],['manager',staffRole],['staff',staffRole]])await tx.query('insert into lara.memberships(tenant_id,principal_id,role_id,created_by) values($1,$2,$3,$4)',[T.firm,firmPrincipals[p],r,firmPrincipals.security]);
 });
 let partner=await ctxFor(T.firm,firmPrincipals.partner);
 await run(partner,tx=>organization.createEntity(tx,partner,{legalName:'Ledger & Co',baseCurrency:'PHP',timezone:'Asia/Manila',fiscalYearStartMonth:1}));
 partner=await ctxFor(T.firm,firmPrincipals.partner);
 const staff=await ctxFor(T.firm,firmPrincipals.staff),manager=await ctxFor(T.firm,firmPrincipals.manager);
 await rejects(run(staff,tx=>firm.createFirm(tx,staff,{name:'Ledger & Co'})),'FORBIDDEN','staff do not create the firm');
 const theFirm=await run(partner,tx=>firm.createFirm(tx,partner,{name:'Ledger & Co',plan:{tier:'standard'}}));
 await rejects(run(partner,tx=>firm.createFirm(tx,partner,{name:'Again'})),'STATE_CONFLICT','one firm per organization');
 await run(partner,tx=>firm.addStaff(tx,partner,theFirm.id,{principalId:firmPrincipals.manager,role:'manager'}));
 await run(partner,tx=>firm.addStaff(tx,partner,theFirm.id,{principalId:firmPrincipals.staff,role:'staff'}));
 await rejects(run(manager,tx=>firm.addStaff(tx,manager,theFirm.id,{principalId:firmPrincipals.staff,role:'partner'})),'FORBIDDEN','a manager does not enrol partners');
 assert.equal((await run(partner,tx=>firm.clientScopes(tx,partner))).items.length,0,'a firm identity reaches no client by itself');
 const A=await clientTenant(T.a,'dom-client-a-'+suffix,'Alpha Trading'),B=await clientTenant(T.b,'dom-client-b-'+suffix,'Beta Foods',{overdueInvoice:false});
 pass('fixture: a firm with a partner, a manager and staff, and two client organizations with their own books; the firm identity reaches no client until a client mandates it');

 // Mandates are granted and approved inside the client, never widened, and evidence-backed.
 const soon=new Date(Date.now()+90*86400000).toISOString();
 const perms=['task.read','obligation.read','open_item.read','period.read','invoice.read','party.read','message_request.create','message_request.read','journal.approve','firm_assignment.create','firm_assignment.read','firm_assignment.edit'];
 await rejects(run(A.ctrl,tx=>firm.createMandate(tx,A.ctrl,A.entityId,{firmId:randomUUID(),permissions:perms,entityIds:[A.entityId],validUntil:soon,evidenceIds:[A.engagement]})),'NOT_FOUND','unknown firm');
 await rejects(run(A.ctrl,tx=>firm.createMandate(tx,A.ctrl,A.entityId,{firmId:theFirm.id,permissions:['role.approve'],entityIds:[A.entityId],validUntil:soon,evidenceIds:[A.engagement]})),'VALIDATION_FAILED','security authorities are never delegated');
 await rejects(run(A.ctrl,tx=>firm.createMandate(tx,A.ctrl,A.entityId,{firmId:theFirm.id,permissions:perms,entityIds:[A.entityId],validUntil:new Date(Date.now()+400*86400000).toISOString(),evidenceIds:[A.engagement]})),'VALIDATION_FAILED','at most one year');
 await rejects(run(A.ctrl,tx=>firm.createMandate(tx,A.ctrl,A.entityId,{firmId:theFirm.id,permissions:perms,entityIds:[A.entityId],validUntil:soon,evidenceIds:[randomUUID()]})),'EVIDENCE_NOT_READY','evidence must be available');
 const mandateA=await run(A.ctrl,tx=>firm.createMandate(tx,A.ctrl,A.entityId,{firmId:theFirm.id,permissions:perms,entityIds:[A.entityId],validUntil:soon,evidenceIds:[A.engagement]}));
 await rejects(run(A.ctrl,tx=>firm.approveMandate(tx,A.ctrl,A.entityId,mandateA.id,{decision:'approve',contentVersion:1})),'FORBIDDEN','the drafter role does not approve');
 await rejects(run({...A.dir,principalId:A.ctrl.principalId},tx=>firm.approveMandate(tx,{...A.dir,principalId:A.ctrl.principalId},A.entityId,mandateA.id,{decision:'approve',contentVersion:1})),'SELF_APPROVAL','the drafter cannot approve');
 assert.equal((await run(partner,tx=>firm.clientScopes(tx,partner))).items.length,0,'a draft mandate grants nothing');
 const approvedA=await run(A.dir,tx=>firm.approveMandate(tx,A.dir,A.entityId,mandateA.id,{decision:'approve',contentVersion:1}));
 assert.equal(approvedA.state,'approved');
 await rejects(run(A.ctrl,tx=>firm.updateMandate(tx,A.ctrl,A.entityId,mandateA.id,2,{firmId:theFirm.id,permissions:[...perms,'journal.post'],entityIds:[A.entityId],validUntil:soon,evidenceIds:[A.engagement]})),'STATE_CONFLICT','an approved mandate never widens');
 const scopes=await run(partner,tx=>firm.clientScopes(tx,partner));
 assert.equal(scopes.items.length,1);assert.equal(scopes.items[0].entityName,'Alpha Trading');assert.deepEqual([...scopes.items[0].permissions].sort(),[...perms].sort());
 // The partner acts in Alpha as a delegated identity: the mandate's entity and permissions, nothing else.
 const partnerInA=await ctxFor(T.a,scopes.items[0].principalId);
 assert.equal(partnerInA.firm.mandateId,mandateA.id);assert.deepEqual([...partnerInA.entityIds],[A.entityId]);assert.ok(partnerInA.permissions.has('task.read')&&!partnerInA.permissions.has('journal.post'));
 assert.ok((await run(partnerInA,tx=>sales.listDocuments(tx,partnerInA,A.entityId,{},{kinds:['invoice']}))).items.length===1,'the delegate reads the client invoices under the mandate');
 await rejects(run(partnerInA,tx=>firm.createMandate(tx,partnerInA,A.entityId,{firmId:theFirm.id,permissions:perms,entityIds:[A.entityId],validUntil:soon,evidenceIds:[A.engagement]})),'FORBIDDEN','a delegate grants no mandate');
 pass('a mandate is granted inside the client with permitted authorities only, at most a year, on available evidence, approved by a second client principal (never the drafter), never widened afterwards; the firm owner becomes a delegated identity limited to the mandate');

 // P14-T02: staff assigned to Alpha only cannot see or switch to Beta.
 const mandateB=await run(B.ctrl,tx=>firm.createMandate(tx,B.ctrl,B.entityId,{firmId:theFirm.id,permissions:['task.read','obligation.read','open_item.read','period.read','message_request.create','firm_assignment.create','firm_assignment.read'],entityIds:[B.entityId],validUntil:soon,evidenceIds:[B.engagement]}));
 await run(B.dir,tx=>firm.approveMandate(tx,B.dir,B.entityId,mandateB.id,{decision:'approve',contentVersion:1}));
 assert.equal((await run(partner,tx=>firm.clientScopes(tx,partner))).items.length,2,'the partner now holds both clients');
 await rejects(run(partnerInA,tx=>firm.createAssignment(tx,partnerInA,A.entityId,{mandateId:mandateA.id,principalId:firmPrincipals.staff,entityIds:[A.entityId],permissionSubset:['task.read','journal.post']})),'VALIDATION_FAILED','a subset outside the mandate');
 await rejects(run(partnerInA,tx=>firm.createAssignment(tx,partnerInA,A.entityId,{mandateId:mandateA.id,principalId:randomUUID(),entityIds:[A.entityId],permissionSubset:['task.read']})),'NOT_FOUND','not firm staff');
 const staffAssignment=await run(partnerInA,tx=>firm.createAssignment(tx,partnerInA,A.entityId,{mandateId:mandateA.id,principalId:firmPrincipals.staff,entityIds:[A.entityId],permissionSubset:['task.read','obligation.read','open_item.read','period.read']}));
 assert.equal(staffAssignment.principalId,firmPrincipals.staff);
 const staffScopes=await run(staff,tx=>firm.clientScopes(tx,staff));
 assert.equal(staffScopes.items.length,1);assert.equal(staffScopes.items[0].tenantId,T.a);assert.ok(!staffScopes.items.some(s=>s.tenantId===T.b),'Beta is invisible to the staff member');
 const staffInA=await ctxFor(T.a,staffScopes.items[0].principalId);
 assert.ok(staffInA.permissions.has('task.read')&&!staffInA.permissions.has('invoice.read'));
 await rejects(run(staffInA,tx=>sales.listDocuments(tx,staffInA,A.entityId,{},{kinds:['invoice']})),'FORBIDDEN','the subset holds no invoice read');
 assert.equal((await run({tenantId:T.b,principalId:null},tx=>tx.query('select count(*)::int as n from lara.principals where tenant_id=$1 and oidc_subject=$2',[T.b,'staff-firm-'+suffix]))).rows[0].n,0,'no identity for the staff member exists in Beta: nothing to switch to');
 await rejects(run(staffInA,tx=>firm.createAssignment(tx,staffInA,A.entityId,{mandateId:mandateA.id,principalId:firmPrincipals.manager,entityIds:[A.entityId],permissionSubset:['task.read']})),'FORBIDDEN','staff without the assignment authority assign nobody');
 await rejects(run(partnerInA,tx=>firm.createAssignment(tx,partnerInA,A.entityId,{mandateId:mandateB.id,principalId:firmPrincipals.staff,entityIds:[B.entityId],permissionSubset:['task.read']})),'NOT_FOUND','Beta\'s mandate is not reachable from Alpha');
 pass('P14-T02: the partner assigns a staff member a subset of Alpha\'s mandate (never wider, only firm staff); the staff member sees Alpha alone with that subset, holds no identity in Beta to switch to, and cannot assign others');

 // P14-T05: the roll-up keeps every client and currency apart; snapshots record the mandate.
 await run(A.ctrl,async tx=>{const doc=(await tx.query("insert into lara.documents(tenant_id,entity_id,book_id,kind,branch_id,party_id,document_date,accounting_date,currency,rule_profile_version,payload_hash,created_by,net,tax,gross) values($1,$2,$3,'invoice',$4,$5,'2026-06-10','2026-06-10','USD','ph-2026',$6,$7,100,0,100) returning id",[T.a,A.entityId,A.book.id,A.branch.id,A.customer.id,sha('usd'),A.principals.billing])).rows[0].id;await tx.query("insert into lara.open_items(tenant_id,entity_id,document_id,side,party_id,original_amount,currency,due_date) values($1,$2,$3,'AR',$4,100,'USD','2026-07-10')",[T.a,A.entityId,doc,A.customer.id]);});
 const roll=await run(partner,tx=>firm.rollup(tx,partner));
 assert.equal(roll.items.length,2);
 const rowA=roll.items.find(i=>i.tenantId===T.a),rowB=roll.items.find(i=>i.tenantId===T.b);
 assert.equal(rowA.counts.openTasks,1,'the customer identity task');assert.equal(rowA.counts.overdueObligations,1);assert.equal(rowB.counts.openTasks,1);assert.equal(rowB.counts.openItems.length,0);
 assert.deepEqual(rowA.counts.openItems.map(i=>i.currency+':'+i.outstanding),['PHP:4000.000000','USD:100.000000'],'currencies stay separate rows, never summed');
 assert.ok(!('total' in rowA.counts)&&!('total' in roll),'no combined total');
 assert.equal(rowA.entityName,'Alpha Trading');assert.equal(rowB.entityName,'Beta Foods');
 const snaps=await run(partner,tx=>firm.listSnapshots(tx,partner));
 assert.equal(snaps.items.length,2);assert.ok(snaps.items.every(s=>[mandateA.id,mandateB.id].includes(s.mandateId)));
 const staffRoll=await run(staff,tx=>firm.rollup(tx,staff));
 assert.equal(staffRoll.items.length,1);assert.equal(staffRoll.items[0].counts.openItems.length,2,'the staff subset carries open_item.read');
 await rejects(run(partner,tx=>tx.query('select lara.firm_aggregate($1,$2,$3,$4)',[ISSUER,'staff-firm-'+suffix,T.b,B.entityId])),'FORBIDDEN','the aggregate function refuses a scope the identity does not hold');
 pass('P14-T05: the roll-up lists Alpha and Beta as separate labelled rows with their own task, obligation and period counts and open items per currency (PHP 4,000 and USD 100 side by side, no total), snapshots carry the mandate, the staff member sees Alpha only, and the aggregate function refuses an unheld scope');

 // P14-T03: bulk reminders fan out into independent per-client drafts.
 const bulk=await run(partner,tx=>firm.bulkReminders(tx,partner,{clients:[{tenantId:T.a,entityId:A.entityId},{tenantId:T.b,entityId:B.entityId},{tenantId:randomUUID(),entityId:randomUUID()}],templateVersion:'reminder-2026',channel:'email'},{portals}));
 assert.deepEqual(bulk.outcomes.map(o=>o.outcome),['drafted','nothing_due','refused']);
 assert.equal(bulk.outcomes[0].resourceIds.length,1);
 const draftA=await run(A.ctrl,tx=>portals.getMessage(tx,A.ctrl,A.entityId,bulk.outcomes[0].resourceIds[0]));
 assert.equal(draftA.state,'draft');assert.equal(draftA.recipientPartyId,A.customer.id);
 assert.equal((await run(B.ctrl,tx=>portals.listMessages(tx,B.ctrl,B.entityId,{}))).items.length,0,'nothing leaked into Beta');
 assert.equal((await run(A.ctrl,tx=>tx.query('select count(*)::int as n from lara.message_requests where tenant_id=$1',[T.a]))).rows[0].n,1);
 assert.equal((await run(A.ctrl,tx=>tx.query('select count(*)::int as n from lara.message_requests where tenant_id=$1',[T.b]))).rows[0].n,0,'Alpha cannot even count Beta');
 pass('P14-T03: the bulk reminder drafts one reminder in Alpha for its overdue customer, reports nothing due in Beta and refuses an unknown scope — three independent outcomes, no draft crosses tenants, and every draft still awaits the client\'s own authorization');

 // P14-T04: one identity, maker by direct membership and approver through the firm, stays prohibited.
 const accIdentity=(await run(A.acc,tx=>tx.query('select oidc_subject from lara.principals where tenant_id=$1 and id=$2',[T.a,A.principals.accountant]))).rows[0].oidc_subject;
 const accInFirm=(await run({tenantId:T.firm,principalId:null},tx=>identity.resolvePrincipal(tx,T.firm,{issuer:ISSUER,subject:accIdentity,displayName:'Alpha accountant moonlighting'}))).id;
 await run(partner,tx=>firm.addStaff(tx,partner,theFirm.id,{principalId:accInFirm,role:'staff'}));
 const dual=await run(partnerInA,tx=>firm.createAssignment(tx,partnerInA,A.entityId,{mandateId:mandateA.id,principalId:accInFirm,entityIds:[A.entityId],permissionSubset:['journal.approve','task.read']}));
 const dualPrincipal=(await run(A.ctrl,tx=>tx.query('select principal_id from lara.client_assignments where tenant_id=$1 and id=$2',[T.a,dual.id]))).rows[0].principal_id;
 assert.equal(dualPrincipal,A.principals.accountant,'the firm assignment lands on the same principal as the direct membership');
 const j=await run(A.acc,tx=>ledger.createJournal(tx,A.acc,A.entityId,{bookId:A.book.id,accountingDate:'2026-10-05',documentDate:'2026-10-05',currency:'PHP',description:'Accrual',lines:[{accountId:A.revenue.id,branchId:A.branch.id,debit:'10.00',credit:'0',dimensions:{}},{accountId:A.revenue.id,branchId:A.branch.id,debit:'0',credit:'10.00',dimensions:{}}],evidenceIds:[]}));
 await run(A.acc,tx=>ledger.submitJournal(tx,A.acc,A.entityId,j.id,{}));
 const accAgain=await ctxFor(T.a,A.principals.accountant);
 assert.ok(!accAgain.firm,'a direct member keeps its membership; the firm assignment adds no second identity');
 await rejects(run(accAgain,tx=>ledger.approveJournal(tx,accAgain,A.entityId,j.id,{decision:'approve',contentVersion:1})),'SELF_APPROVAL','maker through membership, approver through the firm: the same principal');
 pass('P14-T04: the client accountant enrolled as firm staff and assigned journal.approve is the same principal in the client; approving the journal they drafted is refused as self-approval');

 // P14-T01: revocation invalidates cached counts and queued work at once.
 const before=await run(partner,tx=>firm.listSnapshots(tx,partner));
 assert.ok(before.items.some(s=>s.mandateId===mandateA.id));
 const jobBefore={tenant_id:T.a,entity_id:A.entityId,requested_by:scopes.items[0].principalId,revocation_version:partnerInA.revocationVersion};
 await run(partnerInA,tx=>identity.assertJobStillAuthorized(tx,jobBefore,'task.read'));
 await rejects(run(partnerInA,tx=>firm.revokeMandate(tx,partnerInA,A.entityId,mandateA.id,{reason:'x'})),'FORBIDDEN','a delegate revokes no mandate');
 const revoked=await run(A.ctrl,tx=>firm.revokeMandate(tx,A.ctrl,A.entityId,mandateA.id,{reason:'Engagement ended'}));
 assert.equal(revoked.state,'revoked');assert.equal(revoked.delegates,3);assert.ok(revoked.snapshots>=1);
 const after=await run(partner,tx=>firm.listSnapshots(tx,partner));
 assert.ok(!after.items.some(s=>s.mandateId===mandateA.id),'Alpha\'s cached counts are gone');
 assert.ok(after.items.some(s=>s.mandateId===mandateB.id),'Beta\'s remain');
 assert.equal((await run(partner,tx=>firm.clientScopes(tx,partner))).items.length,1);
 assert.equal((await run(staff,tx=>firm.clientScopes(tx,staff))).items.length,0);
 await rejects(run(partnerInA,tx=>identity.assertJobStillAuthorized(tx,jobBefore,'task.read')),'FORBIDDEN','queued work of the delegate fails its recheck');
 const gone=await ctxFor(T.a,scopes.items[0].principalId);
 assert.equal(gone.permissions.size,0);assert.ok(!gone.firm);
 await rejects(run(gone,tx=>sales.listDocuments(tx,gone,A.entityId,{},{kinds:['invoice']})),'NOT_FOUND','the delegate reads nothing after revocation');
 await rejects(run(A.ctrl,tx=>firm.createMandate(tx,A.ctrl,A.entityId,{firmId:theFirm.id,permissions:perms,entityIds:[A.entityId],validUntil:soon,evidenceIds:[A.engagement]})).then(m=>run(A.ctrl,tx=>tx.query("update lara.client_mandates set state='approved' where tenant_id=$1 and id=$2",[T.a,m.id]))),'VALIDATION_FAILED','approval straight at the database needs an approver');
 pass('P14-T01: revoking Alpha\'s mandate ends three delegates, deletes the firm\'s Alpha snapshots across tenants while Beta\'s stay, drops Alpha from every scope list, fails the delegate\'s queued work on its recheck and leaves the delegated identity with no permission');
 console.log('P14-02 domain acceptance passed ('+step+' groups)');
}finally{
 try{await removeTenants(owner,[T.a,T.b,T.firm]);}catch(e){console.error('teardown failed',e.message);}
 await Promise.all([api.end(),owner.end()]);
}
