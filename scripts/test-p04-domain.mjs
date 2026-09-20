// P04-02 sales domain against real PostgreSQL through the runtime role:
// P04-T01 AC-01/02/05/06 postings and open balances with server-computed tax,
// P04-T02 concurrent and failed issuance numbering, P04-T03 credit eligibility
// and double allocation, P04-T04 mixed inclusive/exclusive rounding with the
// 0.01 residual, P04-T05 reporting-required profile blocked before P07, plus
// tax rule lifecycle, orders converting to invoices, deliveries, open items
// and aging. Test tenants are removed at the end.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createHash,randomUUID,randomBytes} from 'node:crypto';
import {loadLocalEnv} from './local-env.mjs';
import {connectionOptions} from '../packages/database/src/connection.mjs';
import {DomainError,inTransaction,identity,organization,ledger,evidence,parties,sales} from '../packages/domain/src/index.mjs';
const {MemoryEvidenceStore,FixtureScanner}=evidence;
import {removeTenants} from './tenant-teardown.mjs';
loadLocalEnv();
process.env.FIELD_ENCRYPTION_KEY??=randomBytes(32).toString('hex');
const pg=createRequire(new URL('../packages/database/package.json',import.meta.url))('pg');
const client=url=>new pg.Client({...connectionOptions(url),connectionTimeoutMillis:15000,query_timeout:30000});
const api=client(process.env.DATABASE_URL),api2=client(process.env.DATABASE_URL),owner=client(process.env.LARA_MIGRATOR_DATABASE_URL||process.env.SUPABASE_LARA_MIGRATOR_DATABASE_URL||process.env.MIGRATION_DATABASE_URL||process.env.SUPABASE_OWNER_DATABASE_URL);
await Promise.all([api.connect(),api2.connect(),owner.connect()]);
const sha=b=>createHash('sha256').update(b).digest('hex');
const suffix=randomBytes(3).toString('hex'),tenantId=randomUUID();
let step=0;const pass=l=>console.log('PASS '+(++step)+': '+l);
async function rejects(promise,code,label){try{await promise;}catch(e){assert.ok(e instanceof DomainError,label+': not a DomainError: '+e.stack);assert.equal(e.code,code,label+': '+e.message);return e;}assert.fail(label+' should fail with '+code);}
const run=(ctx,fn,db=api)=>inTransaction(db,ctx,fn);
const env={FIELD_ENCRYPTION_KEY:process.env.FIELD_ENCRYPTION_KEY};
try{
 // Provision: billing (invoices, orders, collections), accountant (approve/post/correct/allocate), tax (rules), controller and director (settings, rule approval and activation, order approval), security.
 const principals={},roles={};
 await run({tenantId,principalId:null},async tx=>{
  await organization.provisionTenant(tx,{id:tenantId,slug:'dom-sales-'+suffix,name:'Sales domain',mode:'demo'});
  for(const n of ['billing','accountant','tax','controller','director','security'])principals[n]=(await identity.resolvePrincipal(tx,tenantId,{issuer:'https://identity.invalid',subject:n+'-'+suffix,displayName:n})).id;
  for(const code of ['billing','accountant','tax','controller','security_admin'])roles[code]=(await tx.query("insert into lara.roles(tenant_id,code,name,permissions,status,content_hash,created_by,protected) select $1,code,name,permissions,'approved',$2,$3,true from lara.role_templates where code=$4 returning id",[tenantId,sha(code),principals.security,code])).rows[0].id;
  // No seeded template holds sales_order.approve/convert; a tenant role covers it (noted for owner review).
  roles.orders=(await tx.query("insert into lara.roles(tenant_id,code,name,permissions,status,content_hash,created_by) values($1,'order_approver','Order approver','[\"sales_order.approve\",\"sales_order.convert\",\"sales_order.read\"]','approved',$2,$3) returning id",[tenantId,sha('orders'),principals.security])).rows[0].id;
  for(const [p,r] of [['billing','billing'],['accountant','accountant'],['tax','tax'],['controller','controller'],['director','controller'],['director','orders'],['security','security_admin']])await tx.query('insert into lara.memberships(tenant_id,principal_id,role_id,created_by) values($1,$2,$3,$4)',[tenantId,principals[p],roles[r],principals.security]);
 });
 const ctxFor=n=>run({tenantId,principalId:principals[n]},tx=>identity.actorContext(tx,tenantId,principals[n],{traceId:'sales-'+n}));
 let ctrl=await ctxFor('controller');
 const entityId=(await run(ctrl,tx=>organization.createEntity(tx,ctrl,{legalName:'Sales Co',baseCurrency:'PHP',timezone:'Asia/Manila',fiscalYearStartMonth:1}))).id;
 ctrl=await ctxFor('controller');
 const bill=await ctxFor('billing'),acc=await ctxFor('accountant'),tax=await ctxFor('tax'),dir=await ctxFor('director');
 const branch=await run(ctrl,tx=>organization.createBranch(tx,ctrl,entityId,{code:'HQ',name:'Head office',address:'Makati'}));
 for(const cap of ['workspace','general_ledger'])await run(ctrl,tx=>tx.query("insert into lara.capability_activations(tenant_id,entity_id,capability,status,profile_version,approved_by,activated_at,created_by) values($1,$2,$3,'active','p.1',$4,now(),$5)",[tenantId,entityId,cap,principals.director,principals.controller]));
 const book=await run(ctrl,tx=>ledger.createBook(tx,ctrl,entityId,{code:'php-main',kind:'primary',functionalCurrency:'PHP',sourceOwner:'lara'}));
 const mk=(code,name,category,extra={})=>run(acc,tx=>ledger.createAccount(tx,acc,entityId,{bookId:book.id,code,name,category,controlType:'none',requiredDimensions:[],...extra}));
 const cash=await mk('1010','Cash','asset'),ar=await mk('1200','Receivables','asset',{controlType:'ar'}),wht=await mk('1250','Withholding receivable','asset'),outTax=await mk('2200','Output tax','liability',{controlType:'output_tax'}),revenue=await mk('4000','Service revenue','income'),revenue2=await mk('4100','Training revenue','income');
 for(const [s,e] of [['2026-09-01','2026-09-30'],['2026-10-01','2026-10-31']])await run(ctrl,tx=>ledger.createPeriod(tx,ctrl,entityId,{bookId:book.id,startsOn:s,endsOn:e}));
 const customer=await run(bill,tx=>parties.createParty(tx,bill,entityId,{legalName:'Acme Trading',roles:['customer'],identityStatus:'unknown',address:'Cebu City'},env));
 const supplier=await run(bill,tx=>parties.createParty(tx,bill,entityId,{legalName:'Supplies Inc',roles:['supplier'],identityStatus:'unknown',address:'Cebu'},env));
 const line=(accountId,unitPrice,extra={})=>({description:'Consulting',quantity:'1',unitPrice,discount:'0',priceBasis:'exclusive',accountId,dimensions:{},...extra});
 const invoiceBody=(lines,extra={})=>({kind:'invoice',branchId:branch.id,bookId:book.id,partyId:customer.id,documentDate:'2026-09-18',accountingDate:'2026-09-18',currency:'PHP',ruleProfileVersion:'ph-vat-2026',lines,evidenceIds:[],...extra});
 await rejects(run(bill,tx=>sales.createDocument(tx,bill,entityId,invoiceBody([line(revenue.id,'100')]))),'FEATURE_NOT_ENABLED','sales before the capability');
 await run(ctrl,tx=>tx.query("insert into lara.capability_activations(tenant_id,entity_id,capability,status,profile_version,approved_by,activated_at,created_by) values($1,$2,'sales','active','p04.1',$3,now(),$4)",[tenantId,entityId,principals.director,principals.controller]));
 await rejects(run(bill,tx=>sales.createDocument(tx,bill,entityId,invoiceBody([line(revenue.id,'100')]))),'RULE_PROFILE_NOT_APPROVED','sales before an approved profile');
 const profileBody={arAccountId:ar.id,outputTaxAccountId:outTax.id,cashAccountId:cash.id,withholdingReceivableAccountId:wht.id,scale:2,dueDays:30,enforceCreditLimits:true};
 const approveProfile=async payload=>{const s=await run(ctrl,tx=>organization.saveSettings(tx,ctrl,entityId,'sales_profile',payload));await run(dir,tx=>organization.approveSettings(tx,dir,entityId,s.id,{payloadHash:s.payloadHash}));};
 await approveProfile(profileBody);
 for(const [kind,prefix] of [['invoice','INV'],['credit_note','CN']])await run(ctrl,tx=>tx.query("insert into lara.document_series(tenant_id,entity_id,branch_id,kind,prefix,profile_version,created_by) values($1,$2,$3,$4,$5,'numbering-2026',$6)",[tenantId,entityId,branch.id,kind,prefix,principals.controller]));
 pass('sales work requires the sales capability, an approved sales profile (control accounts, rounding, due days) and numbering series');

 // Tax rules: evidence-backed versions, independent approval and activation, one active per code.
 const store=new MemoryEvidenceStore();
 const pdf=Buffer.from('%PDF-1.4 tax circular\n');
 const reg=await run(tax,tx=>evidence.registerUpload(tx,tax,entityId,{filename:'rr-16-2005.pdf',mime:'application/pdf',byteCount:pdf.length,sha256:sha(pdf),classification:'internal'}));
 await run(tax,tx=>evidence.completeUpload(tx,tax,entityId,reg.evidenceId,pdf,store));
 await run({tenantId,principalId:null},tx=>evidence.recordScan(tx,{tenantId,principalId:null},entityId,reg.evidenceId,new FixtureScanner(),store));
 const ruleBody=(code,rate,extra={})=>({code,taxType:'vat',validFrom:'2026-01-01',rate,basis:'net',recognition:'issue',rounding:'line_half_up',applicabilityProfileId:randomUUID(),sourceEvidenceIds:[reg.evidenceId],goldenCaseIds:['AC-01'],...extra});
 await rejects(run(tax,tx=>sales.createTaxRule(tx,tax,entityId,ruleBody('VAT12','0.12',{sourceEvidenceIds:[randomUUID()]}))),'EVIDENCE_NOT_READY','rule without available evidence');
 await rejects(run(tax,tx=>sales.createTaxRule(tx,tax,entityId,ruleBody('VAT12','0.12',{goldenCaseIds:['AC-99']}),{goldenCases:new Set(['AC-01'])})),'VALIDATION_FAILED','unknown golden case');
 const vat=await run(tax,tx=>sales.createTaxRule(tx,tax,entityId,ruleBody('VAT12','0.12'),{goldenCases:new Set(['AC-01'])}));
 assert.equal(vat.state,'draft');assert.equal(vat.rate,'0.12');
 await rejects(run(tax,tx=>sales.approveTaxRule(tx,tax,entityId,vat.id,{decision:'approve',contentVersion:1})),'FORBIDDEN','tax officer cannot approve');
 await rejects(run(ctrl,tx=>sales.approveTaxRule(tx,ctrl,entityId,vat.id,{decision:'approve',contentVersion:2})),'VERSION_CONFLICT','approval binds content version');
 await run(ctrl,tx=>sales.approveTaxRule(tx,ctrl,entityId,vat.id,{decision:'approve',contentVersion:1}));
 const vatApproved=await run(tax,tx=>sales.getTaxRule(tx,tax,entityId,vat.id));assert.equal(vatApproved.state,'approved');
 await rejects(run(tax,tx=>sales.updateTaxRule(tx,tax,entityId,vat.id,vatApproved.version,ruleBody('VAT12','0.10'))),'STATE_CONFLICT','approved rule edited');
 await rejects(run(bill,tx=>sales.createDocument(tx,bill,entityId,invoiceBody([line(revenue.id,'100',{taxCodeId:vat.id})]))),'RULE_PROFILE_NOT_APPROVED','approved but inactive rule on a line');
 await run(ctrl,tx=>sales.activateTaxRule(tx,ctrl,entityId,vat.id,{reason:'Effective 2026'}));
 const vatDoc=await run(tax,tx=>sales.createTaxRule(tx,tax,entityId,ruleBody('VAT12D','0.12',{rounding:'document_half_up'})));
 await run(ctrl,tx=>sales.approveTaxRule(tx,ctrl,entityId,vatDoc.id,{decision:'approve',contentVersion:1}));
 await run(ctrl,tx=>sales.activateTaxRule(tx,ctrl,entityId,vatDoc.id,{reason:'Document rounding profile'}));
 const vat2=await run(tax,tx=>sales.createTaxRule(tx,tax,entityId,ruleBody('VAT12','0.12',{validFrom:'2026-06-01'})));
 await run(ctrl,tx=>sales.approveTaxRule(tx,ctrl,entityId,vat2.id,{decision:'approve',contentVersion:1}));
 await run(ctrl,tx=>sales.activateTaxRule(tx,ctrl,entityId,vat2.id,{reason:'Replaces v1'}));
 const rulesNow=await run(ctrl,tx=>sales.listTaxRules(tx,ctrl,entityId,{}));
 assert.deepEqual(rulesNow.items.filter(r=>r.code==='VAT12').map(r=>r.state).sort(),['active','superseded']);
 assert.equal((await run(ctrl,tx=>tx.query("select count(*)::int n from lara.outbox_events where tenant_id=$1 and event_type='rule.activated.v1'",[tenantId]))).rows[0].n,3);
 pass('tax rules need available evidence and known golden cases, approve and activate under separate principals, are immutable once approved, supersede the prior active version and publish rule.activated.v1');

 // P04-T04: rounding kernel (pure) — exclusive, inclusive, line and document rounding with the 0.01 residual.
 const rules=new Map([['L',{id:'L',rate:'0.12',rounding:'line_half_up'}],['D',{id:'D',rate:'0.12',rounding:'document_half_up'}]]);
 const amounts=c=>c.map(x=>[ledger.decimal(x.net),ledger.decimal(x.tax),ledger.decimal(x.gross)]);
 assert.deepEqual(amounts(sales.computeLines([{quantity:'3',unitPrice:'1000',discount:'0',priceBasis:'exclusive',taxCodeId:'L'}],rules)),[['3000.00','360.00','3360.00']]);
 assert.deepEqual(amounts(sales.computeLines([{quantity:'1',unitPrice:'112',discount:'0',priceBasis:'inclusive',taxCodeId:'L'}],rules)),[['100.00','12.00','112.00']]);
 assert.deepEqual(amounts(sales.computeLines([{quantity:'1',unitPrice:'100',discount:'0',priceBasis:'inclusive',taxCodeId:'L'}],rules)),[['89.29','10.71','100.00']]);
 assert.deepEqual(amounts(sales.computeLines([{quantity:'2',unitPrice:'0.525',discount:'0',priceBasis:'exclusive',taxCodeId:'L'}],rules)),[['1.05','0.13','1.18']]);
 // Three lines of 1.05 at 12%: exact 0.126 each. Line rounding gives 0.13 ×3 = 0.39; document rounding gives round(0.378)=0.38 split 0.13, 0.13, 0.12 (equal remainders, line order).
 const three=basis=>[1,2,3].map(()=>({quantity:'1',unitPrice:'1.05',discount:'0',priceBasis:'exclusive',taxCodeId:basis}));
 assert.deepEqual(amounts(sales.computeLines(three('L'),rules)).map(a=>a[1]),['0.13','0.13','0.13']);
 assert.deepEqual(amounts(sales.computeLines(three('D'),rules)).map(a=>a[1]),['0.13','0.13','0.12']);
 // Mixed inclusive and exclusive under document rounding: 100 inclusive (10.714285…) + 50 exclusive (6.00) = 16.714… → 16.71: floors 10.71 + 6.00 = 16.71, no residual.
 const mixed=sales.computeLines([{quantity:'1',unitPrice:'100',discount:'0',priceBasis:'inclusive',taxCodeId:'D'},{quantity:'1',unitPrice:'50',discount:'0',priceBasis:'exclusive',taxCodeId:'D'}],rules);
 assert.deepEqual(amounts(mixed),[['89.29','10.71','100.00'],['50.00','6.00','56.00']]);
 assert.deepEqual(amounts(sales.computeLines([{quantity:'1',unitPrice:'100',discount:'0',priceBasis:'exclusive'}],rules)),[['100.00','0.00','100.00']]);
 assert.throws(()=>sales.computeLines([{quantity:'1',unitPrice:'10',discount:'11',priceBasis:'exclusive'}],rules),e=>e.code==='VALIDATION_FAILED');
 assert.throws(()=>sales.computeLines([{quantity:'1',unitPrice:'10',discount:'0',priceBasis:'exclusive',taxCodeId:'X'}],rules),e=>e.code==='RULE_PROFILE_NOT_APPROVED');
 pass('P04-T04 rounding: exclusive and inclusive lines, half-up at currency scale, document rounding allocates the residual cent by remainder then line order, mixed bases never classified by header');

 // P04-T01 AC-01: invoice lifecycle with server-computed tax; approvals bind content.
 const inv=await run(bill,tx=>sales.createDocument(tx,bill,entityId,invoiceBody([line(revenue.id,'6000',{taxCodeId:vat.id}),line(revenue2.id,'4000',{taxCodeId:vat2.id,description:'Training'})])));
 assert.deepEqual([inv.net,inv.tax,inv.gross,inv.state,inv.officialNumber,inv.settlementState],['10000.00','1200.00','11200.00','draft',null,'unpaid']);
 await rejects(run(bill,tx=>sales.createDocument(tx,bill,entityId,invoiceBody([line(ar.id,'100')]))),'VALIDATION_FAILED','revenue line on a control account');
 await rejects(run(bill,tx=>sales.createDocument(tx,bill,entityId,invoiceBody([line(revenue.id,'100')],{partyId:supplier.id}))),'VALIDATION_FAILED','supplier as customer');
 await rejects(run(bill,tx=>sales.createDocument(tx,bill,entityId,invoiceBody([line(revenue.id,'100')],{kind:'bill'}))),'FEATURE_NOT_ENABLED','bills before P05');
 await rejects(run(bill,tx=>sales.approveDocument(tx,bill,entityId,inv.id,{decision:'approve',contentVersion:1})),'FORBIDDEN','billing cannot approve');
 await run(bill,tx=>sales.submitDocument(tx,bill,entityId,inv.id,{},1));
 await rejects(run(acc,tx=>sales.approveDocument(tx,acc,entityId,inv.id,{decision:'approve',contentVersion:2})),'VERSION_CONFLICT','approval binds content version');
 await run(acc,tx=>sales.approveDocument(tx,acc,entityId,inv.id,{decision:'approve',contentVersion:1}));
 // A material edit after approval returns the invoice to draft and bumps the content version.
 const edited=await run(bill,tx=>sales.updateDocument(tx,bill,entityId,inv.id,3,invoiceBody([line(revenue.id,'6000',{taxCodeId:vat.id}),line(revenue2.id,'4000',{taxCodeId:vat2.id,description:'Training day'})])));
 assert.deepEqual([edited.state,edited.contentVersion],['draft',2]);
 await rejects(run(acc,tx=>sales.postDocument(tx,acc,entityId,inv.id,{})),'STATE_CONFLICT','issue without approval');
 await run(bill,tx=>sales.submitDocument(tx,bill,entityId,inv.id,{}));
 await run(acc,tx=>sales.approveDocument(tx,acc,entityId,inv.id,{decision:'approve',contentVersion:2}));
 const posted=await run(acc,tx=>sales.postDocument(tx,acc,entityId,inv.id,{}));
 assert.equal(posted.state,'posted');assert.equal(posted.journalEntryIds.length,1);
 const entryLines=async id=>(await run(acc,tx=>tx.query('select a.code,l.txn_debit::text as debit,l.txn_credit::text as credit from lara.journal_lines l join lara.accounts a on a.tenant_id=l.tenant_id and a.id=l.account_id where l.tenant_id=$1 and l.entry_id=$2 order by l.line_no',[tenantId,id]))).rows.map(r=>[r.code,ledger.decimal(ledger.micros(r.debit)),ledger.decimal(ledger.micros(r.credit))]);
 assert.deepEqual(await entryLines(posted.journalEntryIds[0]),[['1200','11200.00','0.00'],['4000','0.00','6000.00'],['4100','0.00','4000.00'],['2200','0.00','1200.00']]);
 const issued=await run(bill,tx=>sales.getDocument(tx,bill,entityId,inv.id,{kinds:['invoice','credit_note']}));
 assert.equal(issued.officialNumber,'INV-000001');
 const again=await run(acc,tx=>sales.postDocument(tx,acc,entityId,inv.id,{}));
 assert.deepEqual(again.journalEntryIds,posted.journalEntryIds,'re-issuing returns the same entry');
 await rejects(run(bill,tx=>sales.updateDocument(tx,bill,entityId,inv.id,issued.version,invoiceBody([line(revenue.id,'1')]))),'STATE_CONFLICT','posted invoice edited');
 const items=await run(bill,tx=>sales.listOpenItems(tx,bill,entityId,{partyId:customer.id}));
 assert.deepEqual(items.items.map(i=>[i.originalAmount,i.allocatedAmount,i.outstandingAmount,i.dueDate]),[['11200.00','0.00','11200.00','2026-10-18']]);
 assert.equal((await run(acc,tx=>tx.query('select count(*)::int n from lara.tax_events where tenant_id=$1 and document_id=$2',[tenantId,inv.id]))).rows[0].n,2);
 assert.equal((await run(acc,tx=>tx.query('select immutable_json->>\'legalName\' as n from lara.party_snapshots where tenant_id=$1 and document_id=$2',[tenantId,inv.id]))).rows[0].n,'Acme Trading');
 assert.equal((await run(acc,tx=>tx.query("select count(*)::int n from lara.outbox_events where tenant_id=$1 and event_type='document.posted.v1'",[tenantId]))).rows[0].n,1);
 pass('P04-T01 AC-01: server-computed 10,000 / 1,200 / 11,200, independent approval bound to content, material edit returns to draft, single issuance posts Dr AR 11,200 / Cr revenue / Cr output tax, numbers INV-000001, opens the receivable, records tax events, snapshot and event');

 // P04-T02 numbering: a failed issuance leaves no gap; concurrent issuance yields distinct sequential numbers.
 const approvedInvoice=async(price,date='2026-09-19')=>{const d=await run(bill,tx=>sales.createDocument(tx,bill,entityId,invoiceBody([line(revenue.id,price,{taxCodeId:vat.id})],{documentDate:date,accountingDate:date})));await run(bill,tx=>sales.submitDocument(tx,bill,entityId,d.id,{}));await run(acc,tx=>sales.approveDocument(tx,acc,entityId,d.id,{decision:'approve',contentVersion:1}));return d;};
 const a=await approvedInvoice('100'),b=await approvedInvoice('200'),c=await approvedInvoice('300');
 const sep=(await run(ctrl,tx=>ledger.listPeriods(tx,ctrl,entityId,{bookId:book.id}))).items.find(p=>p.startsOn==='2026-09-01');
 await run(ctrl,tx=>ledger.softClosePeriod(tx,ctrl,entityId,sep.id,{reason:'Month end'},sep.version));
 await rejects(run(acc,tx=>sales.postDocument(tx,acc,entityId,a.id,{})),'PERIOD_LOCKED','issuance into a soft-closed period fails after the number was drawn');
 assert.equal((await run(acc,tx=>tx.query("select next_number::int n from lara.document_series where tenant_id=$1 and kind='invoice'",[tenantId]))).rows[0].n,2,'the rolled-back issuance did not consume a number');
 const sep2=(await run(ctrl,tx=>ledger.listPeriods(tx,ctrl,entityId,{bookId:book.id}))).items.find(p=>p.id===sep.id);
 await run(ctrl,tx=>ledger.reopenPeriod(tx,ctrl,entityId,sep.id,{reason:'Late invoices'},sep2.version));
 const [pa,pb]=await Promise.all([run(acc,tx=>sales.postDocument(tx,acc,entityId,a.id,{}),api),run(acc,tx=>sales.postDocument(tx,acc,entityId,b.id,{}),api2)]);
 assert.ok(pa.state==='posted'&&pb.state==='posted');
 const numbers=(await run(acc,tx=>tx.query('select official_number from lara.documents where tenant_id=$1 and id=any($2::uuid[]) order by official_number',[tenantId,[a.id,b.id]]))).rows.map(r=>r.official_number);
 assert.deepEqual(numbers,['INV-000002','INV-000003']);
 const events=(await run(acc,tx=>tx.query("select number::int as n,event from lara.number_events where tenant_id=$1 order by number",[tenantId]))).rows;
 assert.deepEqual(events,[{n:1,event:'issued'},{n:2,event:'issued'},{n:3,event:'issued'}]);
 pass('P04-T02: a failed issuance rolls its number back, concurrent issuances serialize on the series and take distinct consecutive numbers, every number is explained by an event');

 // P04-T05: a reporting-required profile blocks issuance until the compliance capability (P07) while drafting still works.
 await approveProfile({...profileBody,reportingRequired:true});
 await rejects(run(acc,tx=>sales.postDocument(tx,acc,entityId,c.id,{})),'FEATURE_NOT_ENABLED','reporting-required profile before P07');
 const draftUnderReporting=await run(bill,tx=>sales.createDocument(tx,bill,entityId,invoiceBody([line(revenue.id,'10',{taxCodeId:vat.id})])));
 assert.equal(draftUnderReporting.state,'draft');
 await approveProfile(profileBody);
 await run(acc,tx=>sales.postDocument(tx,acc,entityId,c.id,{}));
 pass('P04-T05: the reporting-required profile blocks issuance with FEATURE_NOT_ENABLED while invoice drafting keeps working');

 // P04-T03 / AC-06: partial credit within eligibility; excess and duplicate credits refused.
 await rejects(run(acc,tx=>sales.correctDocument(tx,acc,entityId,inv.id,{kind:'credit_note',accountingDate:'2026-09-20',reason:'Too much',lines:[line(revenue.id,'6001',{taxCodeId:vat.id})]})),'STATE_CONFLICT','credit beyond the original line account');
 const cn=await run(acc,tx=>sales.correctDocument(tx,acc,entityId,inv.id,{kind:'credit_note',accountingDate:'2026-09-20',reason:'Scope reduced',lines:[line(revenue.id,'5000',{taxCodeId:vat.id})]}));
 assert.equal(cn.state,'draft');
 const cnDoc=await run(bill,tx=>sales.getDocument(tx,bill,entityId,cn.resourceId,{kinds:['invoice','credit_note']}));
 assert.deepEqual([cnDoc.kind,cnDoc.net,cnDoc.tax,cnDoc.gross,cnDoc.sourceDocumentId],['credit_note','5000.00','600.00','5600.00',inv.id]);
 await rejects(run(acc,tx=>sales.correctDocument(tx,acc,entityId,inv.id,{kind:'reversal',accountingDate:'2026-09-20',reason:'Cancel all',lines:[line(revenue.id,'1')]})),'STATE_CONFLICT','full reversal after a pending partial credit');
 await run(bill,tx=>sales.submitDocument(tx,bill,entityId,cn.resourceId,{}));
 await rejects(run(acc,tx=>sales.approveDocument(tx,acc,entityId,cn.resourceId,{decision:'approve',contentVersion:1})),'SELF_APPROVAL','the accountant who raised the credit cannot approve it');
 await run(ctrl,tx=>sales.approveDocument(tx,ctrl,entityId,cn.resourceId,{decision:'approve',contentVersion:1}));
 const cnPosted=await run(acc,tx=>sales.postDocument(tx,acc,entityId,cn.resourceId,{}));
 assert.deepEqual(await entryLines(cnPosted.journalEntryIds[0]),[['1200','0.00','5600.00'],['4000','5000.00','0.00'],['2200','600.00','0.00']]);
 const afterCredit=await run(bill,tx=>sales.listOpenItems(tx,bill,entityId,{partyId:customer.id,open:'true'}));
 const item=afterCredit.items.find(i=>i.documentId===inv.id);
 assert.deepEqual([item.allocatedAmount,item.outstandingAmount],['5600.00','5600.00']);
 assert.equal((await run(bill,tx=>sales.getDocument(tx,bill,entityId,inv.id,{kinds:['invoice']}))).settlementState,'partial');
 assert.equal((await run(bill,tx=>sales.getDocument(tx,bill,entityId,cn.resourceId,{kinds:['credit_note']}))).officialNumber,'CN-000001');
 pass('P04-T03 / AC-06: a partial credit posts Dr revenue 5,000 / Dr output tax 600 / Cr AR 5,600 and applies to the invoice; credits beyond the remaining eligible amount are refused');

 // AC-02 / AC-05: receipt with customer withholding, allocation, double allocation refused, reversal of one allocation and of the receipt.
 const receiptBody=(over={})=>({direction:'receipt',partyId:customer.id,currency:'PHP',valueDate:'2026-09-25',grossAmount:'5600.00',cashAmount:'5500.00',withholdingAmount:'100.00',method:'transfer',allocations:[{openItemId:item.id,amount:'5600.00'}],evidenceIds:[],...over});
 await rejects(run(bill,tx=>sales.createCollection(tx,bill,entityId,receiptBody({cashAmount:'5000.00'}))),'VALIDATION_FAILED','gross not equal to cash plus withholding');
 await rejects(run(bill,tx=>sales.createCollection(tx,bill,entityId,receiptBody({direction:'payment'}))),'VALIDATION_FAILED','supplier payments are proposed through settlements');
 await rejects(run(bill,tx=>sales.createCollection(tx,bill,entityId,receiptBody({allocations:[{openItemId:item.id,amount:'5600.01'}]}))),'ALLOCATION_EXCEEDS_BALANCE','allocations beyond the receipt');
 const rc=await run(bill,tx=>sales.createCollection(tx,bill,entityId,receiptBody()));
 assert.deepEqual([rc.state,rc.grossAmount,rc.allocations.length],['draft','5600.00',1]);
 await run(bill,tx=>sales.submitCollection(tx,bill,entityId,rc.id,{}));
 await rejects(run(bill,tx=>sales.approveCollection(tx,bill,entityId,rc.id,{decision:'approve',contentVersion:1})),'FORBIDDEN','billing cannot approve receipts');
 await run(acc,tx=>sales.approveCollection(tx,acc,entityId,rc.id,{decision:'approve',contentVersion:1}));
 const rcPosted=await run(acc,tx=>sales.postCollection(tx,acc,entityId,rc.id,{}));
 assert.deepEqual(await entryLines(rcPosted.journalEntryIds[0]),[['1010','5500.00','0.00'],['1250','100.00','0.00'],['1200','0.00','5600.00']]);
 assert.equal((await run(bill,tx=>sales.getDocument(tx,bill,entityId,inv.id,{kinds:['invoice']}))).settlementState,'paid');
 await rejects(run(acc,tx=>sales.allocateCollection(tx,acc,entityId,rc.id,{allocations:[{openItemId:item.id,amount:'0.01'}]})),'ALLOCATION_EXCEEDS_BALANCE','allocating the same receipt twice');
 const applied=(await run(acc,tx=>tx.query("select id from lara.allocation_events where tenant_id=$1 and settlement_id=$2 and action='apply'",[tenantId,rc.id]))).rows[0].id;
 await run(acc,tx=>sales.reverseAllocation(tx,acc,entityId,applied,{reason:'Applied to the wrong invoice'}));
 await rejects(run(acc,tx=>sales.reverseAllocation(tx,acc,entityId,applied,{reason:'again'})),'STATE_CONFLICT','one allocation reversed twice');
 assert.equal((await run(bill,tx=>sales.getDocument(tx,bill,entityId,inv.id,{kinds:['invoice']}))).settlementState,'partial');
 await run(acc,tx=>sales.allocateCollection(tx,acc,entityId,rc.id,{allocations:[{openItemId:item.id,amount:'5600.00'}],reason:'Re-applied'}));
 const rcView=await run(acc,tx=>sales.getCollection(tx,acc,entityId,rc.id));
 assert.deepEqual(rcView.allocations,[{openItemId:item.id,amount:'5600.00'}]);
 const reversed=await run(acc,tx=>sales.reverseCollection(tx,acc,entityId,rc.id,{accountingDate:'2026-09-26',reason:'Bounced transfer'}));
 assert.equal(reversed.state,'reversed');
 assert.deepEqual(await entryLines(reversed.journalEntryIds[0]),[['1010','0.00','5500.00'],['1250','0.00','100.00'],['1200','5600.00','0.00']]);
 const afterReversal=(await run(bill,tx=>sales.listOpenItems(tx,bill,entityId,{partyId:customer.id}))).items.find(i=>i.id===item.id);
 assert.deepEqual([afterReversal.allocatedAmount,afterReversal.outstandingAmount],['5600.00','5600.00']);
 await rejects(run(acc,tx=>sales.allocateCollection(tx,acc,entityId,rc.id,{allocations:[{openItemId:item.id,amount:'1.00'}]})),'STATE_CONFLICT','allocating from a reversed receipt');
 const tb=await run(ctrl,tx=>ledger.trialBalance(tx,ctrl,entityId,{bookId:book.id,periodStart:'2026-09-01',periodEnd:'2026-09-30',asOf:new Date().toISOString()}));
 assert.equal(tb.totals.balanced,true);
 pass('AC-02 / AC-05: a receipt with customer withholding posts Dr cash 5,500 / Dr withholding receivable 100 / Cr AR 5,600 and settles the item; the same receipt cannot allocate twice; allocation and receipt reversals are mirrored, append-only and leave the ledger balanced');

 // Credit limit, orders converting to invoices, delivery job, aging.
 const limitBody={arAccountId:ar.id,outputTaxAccountId:outTax.id,cashAccountId:cash.id,withholdingReceivableAccountId:wht.id,scale:2,dueDays:30,enforceCreditLimits:true};
 await run(ctrl,tx=>tx.query("insert into lara.credit_limits(tenant_id,entity_id,party_id,currency,limit_amount,policy_version,created_by,status,approved_by) values($1,$2,$3,'PHP',6000,'credit-2026',$4,'approved',$5)",[tenantId,entityId,customer.id,principals.controller,principals.director]));
 const over=await run(bill,tx=>sales.createDocument(tx,bill,entityId,invoiceBody([line(revenue.id,'1000',{taxCodeId:vat.id})])));
 await rejects(run(bill,tx=>sales.submitDocument(tx,bill,entityId,over.id,{})),'STATE_CONFLICT','submission beyond the approved credit limit (outstanding 5,600 + 1,120 > 6,000)');
 await run(ctrl,tx=>tx.query("update lara.credit_limits set status='superseded' where tenant_id=$1 and party_id=$2",[tenantId,customer.id]));
 assert.equal(limitBody.scale,2);
 const order=await run(bill,tx=>sales.createDocument(tx,bill,entityId,invoiceBody([line(revenue.id,'2500',{taxCodeId:vat.id,quantity:'4'})],{kind:'sales_order'})));
 await run(bill,tx=>sales.submitDocument(tx,bill,entityId,order.id,{}));
 await rejects(run(acc,tx=>sales.approveDocument(tx,acc,entityId,order.id,{decision:'approve',contentVersion:1})),'FORBIDDEN','accountant holds no order approval');
 await rejects(run(dir,tx=>sales.convertDocument(tx,dir,entityId,order.id,{})),'STATE_CONFLICT','conversion before approval');
 await run(dir,tx=>sales.approveDocument(tx,dir,entityId,order.id,{decision:'approve',contentVersion:1}));
 const conv=await run(dir,tx=>sales.convertDocument(tx,dir,entityId,order.id,{}));
 const convInv=await run(bill,tx=>sales.getDocument(tx,bill,entityId,conv.resourceId,{kinds:['invoice']}));
 assert.deepEqual([convInv.kind,convInv.sourceDocumentId,convInv.lines[0].quantity,convInv.gross],['invoice',order.id,'4','11200.00']);
 await rejects(run(dir,tx=>sales.convertDocument(tx,dir,entityId,order.id,{})),'STATE_CONFLICT','order already fully billed');
 const delivered=await run(bill,tx=>sales.deliverDocument(tx,bill,entityId,inv.id,{}));
 assert.equal(delivered.state,'posted');
 assert.equal((await run(bill,tx=>tx.query("select count(*)::int n from lara.jobs where tenant_id=$1 and kind='document.deliver'",[tenantId]))).rows[0].n,1);
 assert.equal((await run(bill,tx=>sales.getDocument(tx,bill,entityId,inv.id,{kinds:['invoice']}))).deliveryState,'queued');
 await rejects(run(bill,tx=>sales.deliverDocument(tx,bill,entityId,over.id,{})),'STATE_CONFLICT','delivering a draft');
 const aging=await run(acc,tx=>sales.agingReport(tx,acc,entityId,{asOf:'2026-11-30'}));
 assert.equal(aging.parties.length,1);
 // INV-000001 (5,600 outstanding, due 2026-10-18) and the three September 19 invoices (112 + 224 + 336, due 2026-10-19) are 42–43 days past due on 2026-11-30.
 assert.deepEqual([aging.parties[0].buckets['31_60'],aging.parties[0].buckets['current'],aging.totals.total],['6272.00','0.00','6272.00']);
 assert.deepEqual((await run(acc,tx=>sales.agingReport(tx,acc,entityId,{asOf:'2026-10-01'}))).totals,{current:'6272.00','1_30':'0.00','31_60':'0.00','61_90':'0.00',over_90:'0.00',total:'6272.00'});
 pass('credit limits gate submission, approved orders convert once into a linked invoice for the remaining quantity, delivery queues a worker job, and aging buckets the outstanding receivables');
 console.log('P04-02 domain acceptance passed ('+step+' groups)');
}finally{
 await removeTenants(owner,[tenantId]);
 await Promise.all([api.end(),api2.end(),owner.end()]);
}
