// P13-02 portals and messaging domain against real PostgreSQL through the
// runtime role with the local mail and fixture payment adapters: P13-T01 a
// portal member enumerating another party's records gets nothing; P13-T02
// forged, replayed and out-of-order payment webhooks never settle twice;
// P13-T03 an expired invite or share token exposes nothing; P13-T04 a
// supplier upload missing legal fields routes to review, never to a bill;
// P13-T05 a provider failure retries without a duplicate authorized send.
// Test tenants are removed at the end.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createHash,randomUUID,randomBytes} from 'node:crypto';
import {loadLocalEnv} from './local-env.mjs';
import {connectionOptions} from '../packages/database/src/connection.mjs';
import {DomainError,inTransaction,identity,organization,ledger,evidence,parties,sales,purchasing,treasury,portals,localMessagingProvider,fixturePaymentProvider} from '../packages/domain/src/index.mjs';
const {MemoryEvidenceStore,FixtureScanner}=evidence;
import {removeTenants} from './tenant-teardown.mjs';
loadLocalEnv();
process.env.FIELD_ENCRYPTION_KEY??=randomBytes(32).toString('hex');
const pg=createRequire(new URL('../packages/database/package.json',import.meta.url))('pg');
const client=url=>new pg.Client({...connectionOptions(url),connectionTimeoutMillis:15000,query_timeout:60000});
const api=client(process.env.DATABASE_URL),owner=client(process.env.LARA_MIGRATOR_DATABASE_URL||process.env.SUPABASE_LARA_MIGRATOR_DATABASE_URL||process.env.MIGRATION_DATABASE_URL||process.env.SUPABASE_OWNER_DATABASE_URL);
await Promise.all([api.connect(),owner.connect()]);
const sha=b=>createHash('sha256').update(b).digest('hex');
const suffix=randomBytes(3).toString('hex'),tenantId=randomUUID();
let step=0;const pass=l=>console.log('PASS '+(++step)+': '+l);
async function rejects(promise,code,label){try{await promise;}catch(e){assert.ok(e instanceof DomainError,label+': not a DomainError: '+e.stack);assert.equal(e.code,code,label+': '+e.message);return e;}assert.fail(label+' should fail with '+code);}
const run=(ctx,fn,db=api)=>inTransaction(db,ctx,fn);
const env={FIELD_ENCRYPTION_KEY:process.env.FIELD_ENCRYPTION_KEY};
const store=new MemoryEvidenceStore(),mail=localMessagingProvider(store),pay=fixturePaymentProvider(store,'test-secret');
const ISSUER='https://identity.invalid';
try{
 const principals={},roles={};
 await run({tenantId,principalId:null},async tx=>{
  await organization.provisionTenant(tx,{id:tenantId,slug:'dom-portal-'+suffix,name:'Portals domain',mode:'demo'});
  for(const n of ['billing','clerk','accountant','tax','treasury','controller','director','security','relations'])principals[n]=(await identity.resolvePrincipal(tx,tenantId,{issuer:ISSUER,subject:n+'-'+suffix,displayName:n})).id;
  for(const code of ['billing','clerk','accountant','tax','treasury','controller','security_admin'])roles[code]=(await tx.query("insert into lara.roles(tenant_id,code,name,permissions,status,content_hash,created_by,protected) select $1,code,name,permissions,'approved',$2,$3,true from lara.role_templates where code=$4 returning id",[tenantId,sha(code),principals.security,code])).rows[0].id;
  // No seeded template holds the portal, messaging or payment-link authorities; tenant roles cover the relations officer (invites, drafts, links) and the authorizer (noted for owner review).
  const role=async(code,perms)=>(await tx.query("insert into lara.roles(tenant_id,code,name,permissions,status,content_hash,created_by) values($1,$2,$2,$3,'approved',$4,$5) returning id",[tenantId,code,JSON.stringify(perms),sha(code),principals.security])).rows[0].id;
  roles.relations=await role('relations',['portal_invite.create','portal_invite.edit','portal_invite.read','message_request.create','message_request.edit','message_request.read','payment_link.create','payment_link.edit','payment_link.read','payment_link.cancel','party.read','invoice.read','open_item.read','collection.create','collection.read','evidence.read']);
  roles.authorizer=await role('message_authorizer',['message_request.send','message_request.read','portal_invite.revoke','portal_invite.read','payment_link.read']);
  for(const [p,r] of [['billing','billing'],['clerk','clerk'],['accountant','accountant'],['tax','tax'],['treasury','treasury'],['controller','controller'],['controller','authorizer'],['director','controller'],['director','authorizer'],['relations','relations'],['security','security_admin']])await tx.query('insert into lara.memberships(tenant_id,principal_id,role_id,created_by) values($1,$2,$3,$4)',[tenantId,principals[p],roles[r],principals.security]);
 });
 const ctxFor=n=>run({tenantId,principalId:principals[n]},tx=>identity.actorContext(tx,tenantId,principals[n],{traceId:'portal-'+n}));
 let ctrl=await ctxFor('controller');
 const entityId=(await run(ctrl,tx=>organization.createEntity(tx,ctrl,{legalName:'Portal Co',baseCurrency:'PHP',timezone:'Asia/Manila',fiscalYearStartMonth:1}))).id;
 ctrl=await ctxFor('controller');
 const bill=await ctxFor('billing'),clerk=await ctxFor('clerk'),acc=await ctxFor('accountant'),tax=await ctxFor('tax'),tre=await ctxFor('treasury'),dir=await ctxFor('director'),rel=await ctxFor('relations');
 const branch=await run(ctrl,tx=>organization.createBranch(tx,ctrl,entityId,{code:'HQ',name:'Head office',address:'Makati'}));
 for(const cap of ['workspace','general_ledger','sales','purchasing','treasury','compliance'])await run(ctrl,tx=>tx.query("insert into lara.capability_activations(tenant_id,entity_id,capability,status,profile_version,approved_by,activated_at,created_by) values($1,$2,$3,'active','p.1',$4,now(),$5)",[tenantId,entityId,cap,principals.director,principals.controller]));
 const book=await run(ctrl,tx=>ledger.createBook(tx,ctrl,entityId,{code:'php-main',kind:'primary',functionalCurrency:'PHP',sourceOwner:'lara'}));
 const mk=(code,name,category,extra={})=>run(acc,tx=>ledger.createAccount(tx,acc,entityId,{bookId:book.id,code,name,category,controlType:'none',requiredDimensions:[],...extra}));
 const cash=await mk('1010','Cash','asset'),clearing=await mk('1020','Payment provider clearing','asset'),ar=await mk('1200','Receivables','asset',{controlType:'ar'}),inTax=await mk('1300','Input tax','asset',{controlType:'input_tax'}),adv=await mk('1400','Advances','asset'),ap=await mk('2100','Payables','liability',{controlType:'ap'}),outTax=await mk('2200','Output tax','liability',{controlType:'output_tax'}),whtPay=await mk('2300','Withholding payable','liability'),revenue=await mk('4000','Service revenue','income'),fees=await mk('5000','Professional fees','expense');
 await run(ctrl,tx=>ledger.createPeriod(tx,ctrl,entityId,{bookId:book.id,startsOn:'2026-10-01',endsOn:'2026-10-31'}));
 const approve=async(kind,payload)=>{const s=await run(ctrl,tx=>organization.saveSettings(tx,ctrl,entityId,kind,payload));await run(dir,tx=>organization.approveSettings(tx,dir,entityId,s.id,{payloadHash:s.payloadHash}));};
 await approve('sales_profile',{arAccountId:ar.id,outputTaxAccountId:outTax.id,cashAccountId:cash.id,scale:2,dueDays:30});
 await approve('purchasing_profile',{apAccountId:ap.id,inputTaxAccountId:inTax.id,cashAccountId:cash.id,withholdingPayableAccountId:whtPay.id,advanceAccountId:adv.id,withholdingRecognition:'accrual',scale:2,dueDays:30,requirePurchaseOrder:false,requireReceiptOfService:false,nonPoAccountIds:[],duplicateWindowDays:7,expensePolicyVersion:'expense-2026',supplierWithholding:{}});
 for(const [kind,prefix] of [['invoice','INV'],['bill','BILL']])await run(ctrl,tx=>tx.query("insert into lara.document_series(tenant_id,entity_id,branch_id,kind,prefix,profile_version,created_by) values($1,$2,$3,$4,$5,'numbering-2026',$6)",[tenantId,entityId,branch.id,kind,prefix,principals.controller]));
 const customerA=await run(clerk,tx=>parties.createParty(tx,clerk,entityId,{legalName:'Alpha Retail',roles:['customer'],identityStatus:'unknown',address:'Makati'},env));
 const customerB=await run(clerk,tx=>parties.createParty(tx,clerk,entityId,{legalName:'Beta Stores',roles:['customer'],identityStatus:'unknown',address:'Cebu'},env));
 const supplier=await run(clerk,tx=>parties.createParty(tx,clerk,entityId,{legalName:'Gamma Supplies',roles:['supplier'],identityStatus:'unknown',address:'Pasig'},env));
 const invoiceFor=async(party,price)=>{const d=await run(bill,tx=>sales.createDocument(tx,bill,entityId,{kind:'invoice',branchId:branch.id,bookId:book.id,partyId:party.id,documentDate:'2026-10-05',accountingDate:'2026-10-05',currency:'PHP',ruleProfileVersion:'ph-2026',lines:[{description:'Retainer',quantity:'1',unitPrice:price,discount:'0',priceBasis:'exclusive',accountId:revenue.id,dimensions:{}}],evidenceIds:[]}));await run(bill,tx=>sales.submitDocument(tx,bill,entityId,d.id,{}));await run(acc,tx=>sales.approveDocument(tx,acc,entityId,d.id,{decision:'approve',contentVersion:1}));await run(acc,tx=>sales.postDocument(tx,acc,entityId,d.id,{}));return d;};
 const invA=await invoiceFor(customerA,'5000'),invB=await invoiceFor(customerB,'7000');
 await rejects(run(rel,tx=>portals.createInvite(tx,rel,entityId,{partyId:customerA.id,email:'owner@alpha.invalid',role:'customer',expiresAt:new Date(Date.now()+86400000).toISOString()})),'FEATURE_NOT_ENABLED','portals before the capability');
 await run(ctrl,tx=>tx.query("insert into lara.capability_activations(tenant_id,entity_id,capability,status,profile_version,approved_by,activated_at,created_by) values($1,$2,'portals','active','p13.1',$3,now(),$4)",[tenantId,entityId,principals.director,principals.controller]));
 await rejects(run(rel,tx=>portals.createInvite(tx,rel,entityId,{partyId:customerA.id,email:'owner@alpha.invalid',role:'customer',expiresAt:new Date(Date.now()+86400000).toISOString()})),'RULE_PROFILE_NOT_APPROVED','portals before a profile');
 // Provider receipts settle on a reviewed treasury bank account (P06).
 const bankDoc=await (async()=>{const bytes=Buffer.from('%PDF-1.4 bank letter'+String.fromCharCode(10));const reg=await run(tre,tx=>evidence.registerUpload(tx,tre,entityId,{filename:'bank-letter.pdf',mime:'application/pdf',byteCount:bytes.length,sha256:sha(bytes),classification:'internal'}));await run(tre,tx=>evidence.completeUpload(tx,tre,entityId,reg.evidenceId,bytes,store));await run({tenantId,principalId:null},tx=>evidence.recordScan(tx,{tenantId,principalId:null},entityId,reg.evidenceId,new FixtureScanner(),store));return reg.evidenceId;})();
 const bank=await run(tre,tx=>treasury.createBankAccount(tx,tre,entityId,{bookId:book.id,ledgerAccountId:clearing.id,bankCode:'GCASH',accountNumber:'0917 000 1234',currency:'PHP',evidenceIds:[bankDoc]},env));
 await run(ctrl,tx=>treasury.approveBankAccount(tx,ctrl,entityId,bank.id,{decision:'approve',contentVersion:1}));
 await approve('portal_profile',{messagingProvider:'local-mail',paymentProvider:'fixture-pay',paymentBankAccountId:bank.id,shareDays:14,termsVersion:'portal-2026',supportEmail:'support@portal.invalid',baseUrl:'https://portal.test.invalid'});
 pass('fixture: entity with the compliance chain and portals active, two customers with posted invoices (5,000 and 7,000), a supplier, a relations officer drafting invites, messages and links, and an authorizer who sends and revokes');

 // Invites, delivery through the qualified channel, acceptance, and the party fence (P13-T01, T05).
 const soon=new Date(Date.now()+3*86400000).toISOString();
 await rejects(run(rel,tx=>portals.createInvite(tx,rel,entityId,{partyId:supplier.id,email:'x@alpha.invalid',role:'customer',expiresAt:soon})),'NOT_FOUND','a supplier is not invited as a customer');
 await rejects(run(rel,tx=>portals.createInvite(tx,rel,entityId,{partyId:customerA.id,email:'x@alpha.invalid',role:'customer',expiresAt:new Date(Date.now()+40*86400000).toISOString()})),'VALIDATION_FAILED','invites expire within 30 days');
 const inviteA=await run(rel,tx=>portals.createInvite(tx,rel,entityId,{partyId:customerA.id,email:'Owner@Alpha.invalid',role:'customer',expiresAt:soon}));
 assert.equal(inviteA.email,'o***@alpha.invalid','the address is stored masked');
 const msgA=await run(rel,tx=>portals.createMessage(tx,rel,entityId,{sourceType:'portal_invite',sourceId:inviteA.id,recipientPartyId:customerA.id,channel:'email',templateVersion:'invite-2026'}));
 await rejects(run(rel,tx=>portals.sendMessage(tx,rel,entityId,msgA.id,{reason:'send'})),'FORBIDDEN','the drafter role does not send');
 await rejects(run({...ctrl,principalId:rel.principalId,permissions:new Set([...ctrl.permissions])},tx=>portals.sendMessage(tx,{...ctrl,principalId:rel.principalId},entityId,msgA.id,{reason:'send'})),'SELF_APPROVAL','the drafter cannot authorize');
 const sentA=await run(ctrl,tx=>portals.sendMessage(tx,ctrl,entityId,msgA.id,{reason:'Onboarding Alpha'}));
 assert.equal(sentA.state,'authorized');
 const worker=n=>({tenantId,principalId:principals[n],traceId:'worker'});
 const deliver=async(id,who='controller')=>{try{return await run(worker(who),tx=>portals.deliverMessage(tx,worker(who),entityId,id,{provider:mail,store}));}catch(e){if(e.deliveryFailure)await run(worker(who),tx=>portals.recordDeliveryFailure(tx,worker(who),entityId,id,e.deliveryFailure));throw e;}};
 const deliveredA=await deliver(msgA.id);
 assert.equal(deliveredA.state,'sent');
 const key=(await run(acc,tx=>tx.query('select send_key from lara.message_requests where tenant_id=$1 and id=$2',[tenantId,msgA.id]))).rows[0].send_key;
 const mailA=JSON.parse((await store.get('messages/'+key+'.json')).toString('utf8'));
 assert.ok(!/5000|Alpha Retail|TIN/.test(mailA.body+mailA.subject),'the message carries no amounts, names or identifiers beyond the link');
 const tokenA=new URL(mailA.link).searchParams.get('token');assert.match(tokenA,/^[a-f0-9]{48}$/);
 // Another address than the invited one, then the invited one.
 await rejects(run({tenantId,principalId:null},tx=>portals.acceptInvite(tx,{tenantId,inviteId:inviteA.id,token:tokenA,issuer:ISSUER,subject:'someone@else.invalid',email:'someone@else.invalid'})),'FORBIDDEN','another address');
 await rejects(run({tenantId,principalId:null},tx=>portals.acceptInvite(tx,{tenantId,inviteId:inviteA.id,token:'0'.repeat(48),issuer:ISSUER,subject:'owner@alpha.invalid',email:'owner@alpha.invalid'})),'NOT_FOUND','wrong token');
 const accepted=await run({tenantId,principalId:null},tx=>portals.acceptInvite(tx,{tenantId,inviteId:inviteA.id,token:tokenA,issuer:ISSUER,subject:'owner@alpha.invalid',email:'owner@alpha.invalid'}));
 assert.equal(accepted.partyId,customerA.id);
 await rejects(run({tenantId,principalId:null},tx=>portals.acceptInvite(tx,{tenantId,inviteId:inviteA.id,token:tokenA,issuer:ISSUER,subject:'owner@alpha.invalid',email:'owner@alpha.invalid'})),'STATE_CONFLICT','accepted once');
 const alpha=await run({tenantId,principalId:accepted.principalId},tx=>identity.actorContext(tx,tenantId,accepted.principalId,{traceId:'alpha'}));
 assert.equal(alpha.portal.partyId,customerA.id);assert.ok(alpha.permissions.has('invoice.read')&&!alpha.permissions.has('invoice.prepare')&&!alpha.permissions.has('bill.read'));assert.deepEqual([...alpha.entityIds],[entityId]);
 // P13-T01: the member sees their invoices only; Beta's invoice is not found; open items and payment links follow the fence.
 const mine=await run(alpha,tx=>sales.listDocuments(tx,alpha,entityId,{},{kinds:['invoice']}));
 assert.deepEqual(mine.items.map(d=>d.id),[invA.id]);
 await rejects(run(alpha,tx=>sales.getDocument(tx,alpha,entityId,invB.id,{kinds:['invoice']})),'NOT_FOUND','another party\'s invoice by id');
 const theirs=await run(alpha,tx=>sales.listDocuments(tx,alpha,entityId,{partyId:customerB.id},{kinds:['invoice']}));
 assert.equal(theirs.items.length,0,'a party filter cannot widen the fence');
 assert.ok((await run(alpha,tx=>sales.listOpenItems(tx,alpha,entityId,{}))).items.every(i=>i.partyId===customerA.id));
 await rejects(run(alpha,tx=>portals.createInvite(tx,alpha,entityId,{partyId:customerB.id,email:'b@b.invalid',role:'customer',expiresAt:soon})),'FORBIDDEN','a member invites nobody');
 // T05: a transient provider failure records a failed receipt; the retry sends once under the same key.
 const inviteB=await run(rel,tx=>portals.createInvite(tx,rel,entityId,{partyId:customerB.id,email:'fail-once@beta.invalid',role:'customer',expiresAt:soon}));
 const msgB=await run(rel,tx=>portals.createMessage(tx,rel,entityId,{sourceType:'portal_invite',sourceId:inviteB.id,recipientPartyId:customerB.id,channel:'email',templateVersion:'invite-2026'}));
 await run(ctrl,tx=>portals.sendMessage(tx,ctrl,entityId,msgB.id,{reason:'Onboarding Beta'}));
 await rejects(deliver(msgB.id),'DEPENDENCY_UNAVAILABLE','first attempt fails at the relay');
 let receipts=await run(ctrl,tx=>portals.listReceipts(tx,ctrl,entityId,msgB.id));
 assert.equal(receipts.receipts[0].outcome,'failed');assert.equal((await run(ctrl,tx=>portals.getMessage(tx,ctrl,entityId,msgB.id))).state,'failed');
 const second=await deliver(msgB.id);assert.equal(second.state,'sent');
 const third=await deliver(msgB.id);assert.equal(third.state,'sent','a third pass sends nothing');
 receipts=await run(ctrl,tx=>portals.listReceipts(tx,ctrl,entityId,msgB.id));
 assert.deepEqual(receipts.receipts.map(r=>r.outcome),['failed','sent']);
 const keyB=(await run(acc,tx=>tx.query('select send_key from lara.message_requests where tenant_id=$1 and id=$2',[tenantId,msgB.id]))).rows[0].send_key;
 assert.equal([...store.objects.keys()].filter(k=>k.startsWith('messages/'+keyB+'.json')).length,1,'one delivered message for the key');
 await rejects(run(rel,tx=>portals.updateMessage(tx,rel,entityId,msgB.id,3,{sourceType:'portal_invite',sourceId:inviteB.id,recipientPartyId:customerB.id,channel:'email',templateVersion:'invite-2027'})),'VERSION_CONFLICT','If-Match');
 pass('P13-T01/T05: the invite is delivered through the local channel with only a link, accepted only by the invited address with the right token and once; the member sees their own invoices and open items, cannot reach the other party by id or filter and holds no internal authority; a relay failure records a failed receipt and the retry sends exactly once under the same key');

 // P13-T03: expired invites and shares expose nothing; revocation ends access.
 const inviteC=await run(rel,tx=>portals.createInvite(tx,rel,entityId,{partyId:customerB.id,email:'late@beta.invalid',role:'customer',expiresAt:new Date(Date.now()+60000).toISOString()}));
 const tokenC=(await run(rel,tx=>portals.rotateInviteToken(tx,rel,entityId,inviteC.id))).token;
 await run(ctrl,tx=>tx.query("update lara.portal_invites set expires_at=now()-interval '1 minute' where tenant_id=$1 and id=$2",[tenantId,inviteC.id]));
 await rejects(run({tenantId,principalId:null},tx=>portals.acceptInvite(tx,{tenantId,inviteId:inviteC.id,token:tokenC,issuer:ISSUER,subject:'late@beta.invalid',email:'late@beta.invalid'})),'STATE_CONFLICT','expired invite');
 assert.equal((await run(rel,tx=>portals.getInvite(tx,rel,entityId,inviteC.id))).state,'expired');
 const share=await run(rel,tx=>portals.createShare(tx,rel,entityId,{resourceType:'document',resourceId:invA.id}));
 const view=await run({tenantId,principalId:null},tx=>portals.verifyShare(tx,portals.tenantOfToken(share.token),share.token));
 assert.equal(view.gross,'5000.00');assert.equal(view.partyDisplay,'A***');assert.ok(!('tin' in view)&&!('address' in view));
 await rejects(run({tenantId,principalId:null},tx=>portals.verifyShare(tx,tenantId,tenantId+'.'+'f'.repeat(48))),'NOT_FOUND','unknown token');
 await run(ctrl,tx=>tx.query("update lara.share_grants set expires_at=now()-interval '1 minute' where tenant_id=$1 and id=$2",[tenantId,share.id]));
 await rejects(run({tenantId,principalId:null},tx=>portals.verifyShare(tx,tenantId,share.token)),'NOT_FOUND','expired share');
 const revoked=await run(ctrl,tx=>portals.revokeInvite(tx,ctrl,entityId,inviteA.id,{reason:'Contact left Alpha'}));
 assert.equal(revoked.state,'revoked');
 await rejects(run({tenantId,principalId:accepted.principalId},tx=>identity.actorContext(tx,tenantId,accepted.principalId,{traceId:'alpha'})).then(c=>run(c,tx=>sales.listDocuments(tx,c,entityId,{},{kinds:['invoice']}))),'NOT_FOUND','revoked member reads nothing: the entity itself is gone from its scope');
 pass('P13-T03: an expired invite cannot be accepted and flips to expired, a share link shows minimal fields (gross, masked party, no TIN or address) and nothing once expired or unknown, and revocation ends the member\'s hosted access');

 // P13-T04: a supplier upload routes to review, never to a bill.
 const inviteS=await run(rel,tx=>portals.createInvite(tx,rel,entityId,{partyId:supplier.id,email:'ap@gamma.invalid',role:'supplier',expiresAt:soon}));
 const tokenS=(await run(rel,tx=>portals.rotateInviteToken(tx,rel,entityId,inviteS.id))).token;
 const acceptedS=await run({tenantId,principalId:null},tx=>portals.acceptInvite(tx,{tenantId,inviteId:inviteS.id,token:tokenS,issuer:ISSUER,subject:'ap@gamma.invalid',email:'ap@gamma.invalid'}));
 const gamma=await run({tenantId,principalId:acceptedS.principalId},tx=>identity.actorContext(tx,tenantId,acceptedS.principalId,{traceId:'gamma'}));
 assert.equal(gamma.portal.role,'supplier');assert.ok(!gamma.permissions.has('bill.prepare')&&!gamma.permissions.has('invoice.read'));
 const upload=async(who,name,content)=>{const bytes=Buffer.from('field,value\n'+content);const reg=await run(who,tx=>evidence.registerUpload(tx,who,entityId,{filename:name,mime:'text/csv',byteCount:bytes.length,sha256:sha(bytes),classification:'internal'}));await run(who,tx=>evidence.completeUpload(tx,who,entityId,reg.evidenceId,bytes,store));return {id:reg.evidenceId,bytes};};
 const incomplete=await upload(gamma,'gamma-invoice.csv','Supplier: Gamma Supplies\nTotal: 1200.00\n');
 const sub=await run(gamma,tx=>portals.recordSubmission(tx,gamma,entityId,incomplete.id,incomplete.bytes));
 assert.deepEqual(sub.missing,['supplier TIN','invoice number','invoice date']);
 const task=(await run(acc,tx=>tx.query('select * from lara.tasks where tenant_id=$1 and id=$2',[tenantId,sub.taskId]))).rows[0];
 assert.equal(task.kind,'supplier_submission');assert.equal(task.severity,'high');assert.ok(task.reason.includes('missing supplier TIN'));
 assert.equal((await run(acc,tx=>tx.query("select count(*)::int as n from lara.documents where tenant_id=$1 and kind='bill'",[tenantId]))).rows[0].n,0,'no bill from an upload');
 assert.equal((await run(gamma,tx=>evidence.getEvidence(tx,gamma,entityId,incomplete.id))).state,'scanning','quarantine then scan, never posted');
 const complete=await upload(gamma,'gamma-invoice-2.csv','Supplier: Gamma Supplies\nTIN: 111-222-333-000\nNumber: GS-9\nDate: 2026-10-10\nTotal: 1200.00\n');
 const sub2=await run(gamma,tx=>portals.recordSubmission(tx,gamma,entityId,complete.id,complete.bytes));
 assert.deepEqual(sub2.missing,[]);
 await rejects(run(gamma,tx=>purchasing.createDocument(tx,gamma,entityId,{kind:'bill',branchId:branch.id,bookId:book.id,partyId:supplier.id,documentDate:'2026-10-10',accountingDate:'2026-10-10',currency:'PHP',ruleProfileVersion:'ph-2026',lines:[{description:'x',quantity:'1',unitPrice:'1',discount:'0',priceBasis:'exclusive',accountId:fees.id,dimensions:{}}],evidenceIds:[complete.id]})),'FORBIDDEN','a supplier drafts no bill');
 // Own uploads only: the supplier cannot read the internal evidence list beyond its own.
 assert.ok((await run(gamma,tx=>evidence.listEvidence(tx,gamma,entityId,{}))).items.every(e=>[incomplete.id,complete.id].includes(e.id)));
 pass('P13-T04: a supplier upload missing the TIN, number and date opens a high-severity supplier_submission task naming the gaps, a complete one a normal review task, no bill exists, the evidence stays quarantined until scanned, the supplier cannot draft a bill and sees only its own uploads');

 // P13-T02: payment links and webhooks — forged, replayed, out-of-order, wrong amount: settled once.
 await rejects(run(rel,tx=>portals.createPaymentLink(tx,rel,entityId,{invoiceId:invA.id,amount:'5001.00',currency:'PHP',expiresAt:soon},{provider:pay})),'VALIDATION_FAILED','beyond the outstanding');
 await rejects(run(rel,tx=>portals.createPaymentLink(tx,rel,entityId,{invoiceId:invA.id,amount:'5000.00',currency:'USD',expiresAt:soon},{provider:pay})),'VALIDATION_FAILED','currency');
 const linkA=await run(rel,tx=>portals.createPaymentLink(tx,rel,entityId,{invoiceId:invA.id,amount:'5000.00',currency:'PHP',expiresAt:soon},{provider:pay}));
 assert.equal(linkA.state,'pending');
 await rejects(run(rel,tx=>portals.createPaymentLink(tx,rel,entityId,{invoiceId:invA.id,amount:'100.00',currency:'PHP',expiresAt:soon},{provider:pay})),'STATE_CONFLICT','one live intent per invoice');
 const providerKey=(await run(acc,tx=>tx.query('select provider_key from lara.provider_payment_intents where tenant_id=$1 and id=$2',[tenantId,linkA.id]))).rows[0].provider_key;
 const hook=async(event,{timestamp=Math.floor(Date.now()/1000),signature}={})=>{const body=JSON.stringify(event);const sig=signature??pay.sign(String(timestamp),body);return run({tenantId,principalId:null},tx=>portals.receiveWebhook(tx,{tenantId,providerName:'fixture-pay',headers:{'x-webhook-timestamp':String(timestamp),'x-webhook-signature':sig},rawBody:body,provider:pay}));};
 // A browser return is only a claim.
 const claim=await run(rel,tx=>portals.claimPayment(tx,rel,entityId,linkA.id,{reason:'Customer says paid'}));
 assert.equal(claim.state,'pending');assert.equal(claim.claimed,true);
 // Forged signature, stale timestamp, paid event before the provider knows: all rejected.
 assert.equal((await hook({id:'evt-1',type:'payment.paid',providerKey},{signature:'deadbeef'})).outcome,'rejected');
 assert.equal((await hook({id:'evt-2',type:'payment.paid',providerKey},{timestamp:Math.floor(Date.now()/1000)-900})).outcome,'rejected');
 const early=await hook({id:'evt-3',type:'payment.paid',providerKey});
 assert.equal(early.outcome,'rejected');assert.match(early.reason,/provider reports pending/);
 // The provider settles for a different amount: rejected; then the right amount: applied once.
 await pay.settleAtProvider(providerKey,{amount:'4000.00',currency:'PHP'});
 assert.match((await hook({id:'evt-4',type:'payment.paid',providerKey})).reason,/amount or currency differs/);
 await pay.settleAtProvider(providerKey,{amount:'5000.00',currency:'PHP'});
 const applied=await hook({id:'evt-5',type:'payment.paid',providerKey});
 assert.equal(applied.outcome,'applied');assert.ok(applied.settlementId,'a collection draft exists');
 const settlement=(await run(acc,tx=>tx.query('select * from lara.settlements where tenant_id=$1 and id=$2',[tenantId,applied.settlementId]))).rows[0];
 assert.equal(settlement.state,'draft','the normal command, drafted for review, not posted');
 assert.equal((await run(rel,tx=>portals.getPaymentLink(tx,rel,entityId,linkA.id))).state,'settled');
 // Replay, a second paid event, an out-of-order pending event: nothing settles twice.
 assert.equal((await hook({id:'evt-5',type:'payment.paid',providerKey})).outcome,'ignored');
 assert.equal((await hook({id:'evt-6',type:'payment.paid',providerKey})).outcome,'ignored');
 assert.equal((await hook({id:'evt-7',type:'payment.pending',providerKey})).outcome,'ignored');
 assert.equal((await run(acc,tx=>tx.query('select count(*)::int as n from lara.settlements where tenant_id=$1 and party_id=$2',[tenantId,customerA.id]))).rows[0].n,1,'one settlement draft');
 const receiptsW=await run(rel,tx=>portals.listWebhookReceipts(tx,rel,entityId,{}));
 assert.deepEqual(receiptsW.map(r=>r.eventId).sort(),['evt-1','evt-2','evt-3','evt-4','evt-5','evt-6','evt-7'].sort());
 assert.equal(receiptsW.find(r=>r.eventId==='evt-1').signatureState,'invalid');assert.equal(receiptsW.find(r=>r.eventId==='evt-2').signatureState,'stale');
 await rejects(run(rel,tx=>portals.cancelPaymentLink(tx,rel,entityId,linkA.id,{reason:'x'})),'STATE_CONFLICT','a settled intent is not cancelled');
 await rejects(run(acc,tx=>tx.query("update lara.webhook_receipts set outcome='applied' where tenant_id=$1",[tenantId])),'FORBIDDEN','receipts are append-only');
 pass('P13-T02: the browser return is a claim; forged, stale and premature events are rejected and recorded; a wrong provider amount is rejected; the verified paid event drafts one collection for review and settles the intent; replays, repeated paid events and out-of-order events settle nothing twice');
 console.log('P13-02 domain acceptance passed ('+step+' groups)');
}finally{
 try{await removeTenants(owner,[tenantId]);}catch(e){console.error('teardown failed',e.message);}
 await Promise.all([api.end(),owner.end()]);
}
