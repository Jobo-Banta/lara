// P02-04 workspace journeys on the production composition (LARA_MODE=local
// servers on 3016/4015): setup checklist with independent activation, parties
// and missing-evidence tasks, evidence upload through scan, obligations,
// stale-version recovery, forbidden and roadmap states, keyboard/mobile and
// WCAG checks. Identities are the provisioned ci-workspace-<role>-<suffix>.
import {test,expect} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import {spawn} from 'node:child_process';
import {seal} from '../../packages/config/src/session-cookie.mjs';
import {createRequire} from 'node:module';
import {connectionOptions} from '../../packages/database/src/connection.mjs';

const suffix=process.env.LARA_E2E_WORKSPACE_SUFFIX;
const BASE='http://127.0.0.1:3016';
const cookie=sub=>({name:'lara_session',value:seal({sub,expiresAt:Date.now()+3600000},'browser-fixture-session-key-32-characters'),url:BASE,httpOnly:true,sameSite:'Lax'});
const who=role=>'ci-workspace-'+role+'-'+suffix;
test.use({baseURL:BASE});
test.describe.configure({mode:'serial'});
test.beforeEach(()=>{test.skip(!process.env.LARA_E2E_DATABASE_URL||!suffix,'Requires the provisioned workspace tenant');});

let worker;
test.beforeAll(()=>{
 if(!process.env.LARA_E2E_DATABASE_URL||!suffix)return;
 worker=spawn(process.execPath,['apps/worker/src/main.mjs'],{stdio:['ignore','pipe','pipe'],env:{...process.env,LARA_MODE:'local',WORKER_DATABASE_URL:process.env.WORKER_DATABASE_URL||process.env.SUPABASE_LARA_WORKER_DATABASE_URL,OBJECT_ADAPTER:'filesystem',OBJECT_BUCKET:'.local/e2e-workspace',WORKER_POLL_MS:'250'}});
 worker.stdout.on('data',()=>{});worker.stderr.on('data',()=>{});
});
test.afterAll(async()=>{if(worker&&worker.exitCode===null&&!worker.signalCode){const exited=new Promise(r=>worker.once('exit',r));worker.kill();await Promise.race([exited,new Promise(r=>setTimeout(r,5000))]);}});

async function as(browser,role){const context=await browser.newContext({baseURL:BASE});await context.addCookies([cookie(who(role))]);const page=await context.newPage();return {context,page};}
const settled=async page=>{await expect(page.getByRole('status').filter({hasText:/Loading/})).toHaveCount(0);};
async function noSeriousViolations(page,label){const results=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa']).analyze();const serious=results.violations.filter(v=>['serious','critical'].includes(v.impact));expect(serious,label+' '+JSON.stringify(serious.map(v=>({id:v.id,nodes:v.nodes.map(n=>n.target)})))).toEqual([]);}
const pdf=Buffer.from('%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\n%%EOF\n');

test('setup checklist: organization, branch, independent activation and blockers',async({browser})=>{
 test.setTimeout(240000);
 const controller=await as(browser,'controller');const {page}=controller;
 await page.goto('/work');await expect(page.locator('h1')).toHaveText('Set up your organization');
 await page.getByRole('link',{name:'Open setup checklist'}).click();
 await expect(page.locator('h1')).toHaveText('Setup checklist');
 await page.getByLabel('Legal name').fill('CI Workspace Entity');
 await page.getByRole('combobox',{name:'Fiscal year starts in'}).selectOption('1');
 await page.getByRole('button',{name:'Create organization'}).click();
 await expect(page.getByText('CI Workspace Entity · draft',{exact:false})).toBeVisible();
 await expect(page.getByRole('listitem').filter({hasText:'2. Branches'})).toHaveAttribute('aria-current','step');
 await page.getByLabel('Code',{exact:true}).fill('hq');await page.getByLabel('Name',{exact:true}).fill('Head office');await page.getByLabel('Address',{exact:true}).fill('Makati');
 await page.getByRole('button',{name:'Add branch'}).click();
 await expect(page.getByRole('cell',{name:'HQ',exact:true})).toBeVisible();
 // Blocked: the requester is the only person with entity.activate.
 await page.getByRole('button',{name:'Request activation'}).click();
 await expect(page.locator('section[role="alert"]')).toContainText('independent_controller');
 // Security admin grants the controller role to the preparer.
 const preparer=await as(browser,'preparer');
 const me=await (await preparer.page.request.get('/api/v1/me')).json();
 const security=await as(browser,'security');
 await security.page.goto('/settings/setup');await settled(security.page);
 await security.page.getByLabel('Principal id').fill(me.principalId);
 await security.page.getByRole('combobox',{name:'Role',exact:true}).selectOption({label:'Controller'});
 await security.page.getByRole('button',{name:'Add membership'}).click();
 await expect(security.page.getByRole('cell',{name:'Controller'}).first()).toBeVisible();
 await expect(security.page.getByRole('button',{name:'Request activation'})).toHaveCount(0,'security admin cannot request activation');
 // Request as controller, approve as the (now independent) preparer.
 await page.reload();await settled(page);
 await page.getByRole('button',{name:'Request activation'}).click();
 await expect(page.getByText('Requested. A controller other than the requester approves',{exact:false})).toBeVisible();
 // The requester holds entity.activate but the API refuses self-approval and the page says so.
 await page.getByRole('button',{name:'Approve activation'}).click();
 await expect(page.locator('section[role="alert"]')).toContainText('cannot approve');
 await preparer.page.goto('/settings/setup');await settled(preparer.page);
 await preparer.page.getByRole('button',{name:'Approve activation'}).click();
 await expect(preparer.page.getByText('Approved and active.')).toBeVisible();
 await expect(preparer.page.getByRole('link',{name:'Go to my work'})).toBeVisible();
 await page.goto('/overview');await settled(page);
 await expect(page.getByText('workspace · enabled')).toBeVisible();
 await expect(page.getByText('general ledger · not enabled in this release')).toBeVisible();
 for(const c of [controller,preparer,security])await c.context.close();
});

test('parties raise identity tasks; evidence upload is scanned before it resolves the task; known identity is masked',async({browser})=>{
 test.setTimeout(240000);
 const {context,page}=await as(browser,'clerk');
 await page.goto('/parties');await settled(page);
 await expect(page.getByText('No parties yet.')).toBeVisible();
 const form=page.locator('form').filter({has:page.getByRole('button',{name:'Create party'})});
 await form.getByLabel('Legal name').fill('Northwind Services');
 await form.getByRole('combobox',{name:'Role',exact:true}).selectOption('customer');
 await form.getByRole('combobox',{name:'Identity',exact:true}).selectOption('unknown');
 await form.getByLabel('Address',{exact:true}).fill('Cebu City');
 await form.getByRole('button',{name:'Create party'}).click();
 await expect(page).toHaveURL(/\/parties\/[0-9a-f-]{36}$/);
 await expect(page.getByRole('link',{name:'Party identity is unknown; obtain the registration document.'})).toBeVisible();
 // The clerk cannot assign; the controller assigns the task to the clerk from the shared inbox.
 await page.goto('/work?owner=all');await settled(page);
 const row=page.getByRole('row').filter({hasText:'Party identity is unknown'});
 await expect(row).toBeVisible();await expect(row.getByRole('combobox')).toHaveCount(0);
 const clerkMe=await (await page.request.get('/api/v1/me')).json();
 const controller=await as(browser,'controller');
 await controller.page.goto('/work?owner=all');await settled(controller.page);
 await controller.page.getByRole('row').filter({hasText:'Party identity is unknown'}).getByRole('combobox').selectOption(clerkMe.principalId);
 await expect(controller.page.getByRole('row').filter({hasText:'Party identity is unknown'}).locator('td').nth(2)).toHaveText(clerkMe.principalId.slice(0,8));
 await controller.context.close();
 await page.goto('/work');await settled(page);
 await page.getByRole('link',{name:'Party identity is unknown; obtain the registration document.'}).click();
 await expect(page.locator('h1')).toHaveText('Task');
 await expect(page.getByText('No available evidence yet.')).toBeVisible();
 // Upload evidence and wait for the scan.
 await page.goto('/evidence');await settled(page);
 await page.locator('input[type="file"]').setInputFiles({name:'registration.pdf',mimeType:'application/pdf',buffer:pdf});
 await page.getByRole('button',{name:'Upload evidence'}).click();
 await expect(page.getByRole('status').filter({hasText:'Queued for scanning'})).toBeVisible({timeout:30000});
 await page.getByRole('link',{name:'registration.pdf'}).click();
 await expect(page.getByRole('status')).toContainText('Available',{timeout:60000});
 // Resolve the task with the evidence; the party shows it resolved.
 await page.goto('/work');await settled(page);
 await page.getByRole('link',{name:'Party identity is unknown; obtain the registration document.'}).click();
 await page.getByLabel('Resolution').fill('Registration document attached');
 await page.getByRole('combobox',{name:'Evidence (required)'}).selectOption({label:'registration.pdf'});
 await page.getByRole('button',{name:'Resolve task'}).click();
 await expect(page.getByText('Status: resolved',{exact:false})).toBeVisible();
 await page.goto('/work');await settled(page);
 await expect(page.getByText('Your inbox is empty.')).toBeVisible();
 // Known identity requires a tax id and shows masked.
 await page.goto('/parties');await settled(page);
 await page.getByRole('link',{name:'Northwind Services'}).click();
 await page.getByRole('combobox',{name:'Identity',exact:true}).selectOption('known');
 await page.getByRole('button',{name:'Save changes'}).click();
 await expect(page.locator('section[role="alert"]')).toContainText('tax identifier');
 await page.getByRole('textbox',{name:'Tax identifier'}).fill('123-456-789-000');
 await page.getByRole('button',{name:'Save changes'}).click();
 await expect(page.getByText('Tax id •••••••••000',{exact:false})).toBeVisible();
 await context.close();
});

test('stale version is reported with a reload path and the draft is kept',async({browser})=>{
 test.setTimeout(120000);
 const a=await as(browser,'clerk'),b=await as(browser,'billing');
 await a.page.goto('/parties');await settled(a.page);await a.page.getByRole('link',{name:'Northwind Services'}).click();
 await b.page.goto(a.page.url());await settled(b.page);
 await b.page.getByLabel('Address',{exact:true}).fill('Cebu City, Lapu-Lapu');await b.page.getByRole('button',{name:'Save changes'}).click();
 await expect(b.page.getByLabel('Address',{exact:true})).toHaveValue('Cebu City, Lapu-Lapu');await expect(b.page.locator('section[role="alert"]')).toHaveCount(0);
 await a.page.getByLabel('Legal name').fill('Northwind Services Inc');await a.page.getByRole('button',{name:'Save changes'}).click();
 await expect(a.page.locator('section[role="alert"]')).toContainText('Someone else changed this record');
 await expect(a.page.getByLabel('Legal name')).toHaveValue('Northwind Services Inc','draft retained');
 await a.page.getByRole('button',{name:'Reload latest'}).click();
 await expect(a.page.locator('section[role="alert"]')).toHaveCount(0);
 await a.page.getByLabel('Legal name').fill('Northwind Services Inc');await a.page.getByRole('button',{name:'Save changes'}).click();
 await expect(a.page.locator('h1')).toHaveText('Party');
 await expect(a.page.getByLabel('Legal name')).toHaveValue('Northwind Services Inc');
 await a.context.close();await b.context.close();
});

test('obligations calendar completes with evidence and refuses without it',async({browser})=>{
 test.setTimeout(120000);
 const {context,page}=await as(browser,'controller');
 await page.goto('/obligations');await settled(page);
 await page.getByLabel('Kind (e.g. vat_return)').fill('vat_return');await page.getByLabel('Period (YYYY-MM)').fill('2026-09');await page.getByLabel('Due date').fill('2026-10-20');
 await page.getByRole('button',{name:'Create obligation'}).click();
 const row=page.getByRole('row').filter({hasText:'vat_return'});await expect(row).toBeVisible();
 await row.getByRole('button',{name:'Complete'}).click();
 await expect(row.getByRole('combobox',{name:'Evidence'})).toHaveJSProperty('validity.valueMissing',true);
 await row.getByRole('combobox',{name:'Evidence'}).selectOption({label:'registration.pdf'});
 await row.getByRole('button',{name:'Complete'}).click();
 await expect(page.getByRole('row').filter({hasText:'vat_return'}).getByRole('cell',{name:'Done'})).toBeVisible();
 await context.close();
});

test('ledger: two-principal capability activation, chart, period, journal review and posting, close checklist and a trial balance report',async({browser})=>{
 test.setTimeout(300000);
 const controller=await as(browser,'controller'),preparer=await as(browser,'preparer');
 // Capability: the controller requests, the preparer (holding the controller role since setup) approves.
 for(const who of [controller,preparer]){
  await who.page.goto('/settings/capabilities');await settled(who.page);
  const card=who.page.locator('section.demo-card').filter({hasText:'General ledger and close'});
  await card.getByRole('combobox',{name:'Activation evidence'}).selectOption({label:'registration.pdf'});
  await card.getByLabel('Reason').fill(who===controller?'Ledger go-live requested':'Reviewed activation evidence');
  await card.getByRole('button',{name:'Request or approve activation'}).click();
  await expect(who.page.locator('section[role="alert"]')).toHaveCount(0);
 }
 await preparer.page.goto('/settings/capabilities');await settled(preparer.page);
 await expect(preparer.page.locator('section.demo-card').filter({hasText:'General ledger and close'})).toContainText('Active on this entity.');
 // Period by the controller (book resolved through GET /books).
 await controller.page.goto('/ledger/periods');await settled(controller.page);
 await controller.page.getByLabel('Starts on').fill('2026-09-01');await controller.page.getByLabel('Ends on').fill('2026-09-30');
 await controller.page.getByRole('button',{name:'Create period'}).click();
 await expect(controller.page.getByRole('cell',{name:'2026-09-01 → 2026-09-30'})).toBeVisible();
 // Chart by the preparer.
 await preparer.page.goto('/ledger/accounts');await settled(preparer.page);
 const acct=async(code,name,category,parent)=>{const form=preparer.page.locator('form').filter({has:preparer.page.getByRole('button',{name:'Create account'})});await form.getByLabel('Code',{exact:true}).fill(code);await form.getByLabel('Name',{exact:true}).fill(name);await form.getByRole('combobox',{name:'Category'}).selectOption(category);await form.getByRole('combobox',{name:'Parent'}).selectOption(parent?{label:parent}:{label:'None (top level)'});await form.getByRole('button',{name:'Create account'}).click();await expect(preparer.page.getByRole('cell',{name:code,exact:true})).toBeVisible();};
 await acct('1000','Assets','asset');await acct('1010','Cash','asset','1000 Assets');await acct('4000','Service revenue','income');
 await expect(preparer.page.getByRole('cell',{name:'1010',exact:true}).locator('span')).toHaveAttribute('style',/padding-left: 16px/);
 // Journal: running difference, save, submit; controller approves; preparer posts.
 await preparer.page.goto('/ledger/journals');await settled(preparer.page);
 await preparer.page.getByRole('textbox',{name:'Description'}).fill('Cash service revenue');
 await preparer.page.getByRole('combobox',{name:'Line 1 account'}).selectOption({label:'1010 Cash'});
 await preparer.page.getByRole('textbox',{name:'Line 1 debit'}).fill('1000.00');
 await expect(preparer.page.getByRole('status').filter({hasText:'Difference'})).toContainText('Balance the entry before saving');
 await preparer.page.getByRole('combobox',{name:'Line 2 account'}).selectOption({label:'4000 Service revenue'});
 await preparer.page.getByRole('textbox',{name:'Line 2 credit'}).fill('1000.00');
 await expect(preparer.page.getByRole('status').filter({hasText:'Difference'})).toContainText('Balanced');
 await preparer.page.getByRole('button',{name:'Save draft'}).click();
 await expect(preparer.page).toHaveURL(/\/ledger\/journals\/[0-9a-f-]{36}$/);
 const journalUrl=preparer.page.url();
 await expect(preparer.page.getByText('State: draft',{exact:false})).toBeVisible();
 await preparer.page.getByRole('button',{name:'Submit for approval'}).click();
 await expect(preparer.page.getByText('State: submitted',{exact:false})).toBeVisible();
 // The preparer holds journal.approve but the API refuses self-approval explicitly.
 await preparer.page.getByRole('button',{name:'Approve',exact:true}).click();
 await expect(preparer.page.locator('section[role="alert"]')).toContainText('cannot approve');
 await controller.page.goto(new URL(journalUrl).pathname);await settled(controller.page);
 await controller.page.getByRole('button',{name:'Approve',exact:true}).click();
 await expect(controller.page.getByText('State: approved',{exact:false})).toBeVisible();
 await preparer.page.reload();await settled(preparer.page);
 await preparer.page.getByRole('button',{name:'Post to ledger'}).click();
 await expect(preparer.page.getByText('State: posted',{exact:false})).toBeVisible();
 await expect(preparer.page.getByText('Posted journals are immutable.')).toBeVisible();
 // Close checklist: a required task blocks the lock until completed with evidence.
 await controller.page.goto('/ledger/periods');await settled(controller.page);
 await controller.page.getByRole('button',{name:'Open checklist'}).first().click();
 await controller.page.getByLabel('Requirement code').fill('bank_reconciliation');
 await controller.page.getByRole('button',{name:'Add requirement'}).click();
 await expect(controller.page.getByRole('cell',{name:'bank reconciliation'})).toBeVisible();
 controller.page.once('dialog',d=>d.accept('Month end'));
 await controller.page.getByRole('button',{name:'Soft close'}).click();
 await expect(controller.page.getByRole('cell',{name:'soft closed'})).toBeVisible();
 controller.page.once('dialog',d=>d.accept('Lock attempt'));
 await controller.page.getByRole('button',{name:'Lock',exact:true}).click();
 await expect(controller.page.locator('section[role="alert"]')).toContainText('bank_reconciliation');
 const row=controller.page.getByRole('row').filter({hasText:'bank reconciliation'});
 await row.getByLabel('Note or waiver reason').fill('Reconciled to statement');
 await row.getByRole('combobox',{name:'Evidence (required)'}).selectOption({label:'registration.pdf'});
 await row.getByRole('button',{name:'Complete'}).click();
 await expect(controller.page.getByRole('row').filter({hasText:'bank reconciliation'}).getByRole('cell',{name:'complete'})).toBeVisible();
 controller.page.once('dialog',d=>d.accept('Locked after reconciliation'));
 await controller.page.getByRole('button',{name:'Lock',exact:true}).click();
 await expect(controller.page.getByRole('cell',{name:'locked',exact:true})).toBeVisible();
 // Trial balance report as a job rendered from the snapshot.
 await controller.page.goto('/reports');await settled(controller.page);
 await controller.page.getByRole('button',{name:'Generate report'}).click();
 await expect(controller.page.getByRole('status').filter({hasText:'Report job'})).toContainText('succeeded',{timeout:60000});
 await expect(controller.page.getByRole('row').filter({hasText:'1010'})).toContainText('1,000.00');
 for(const route of ['/ledger/journals','/ledger/accounts','/ledger/periods','/reports']){await controller.page.goto(route);await settled(controller.page);await noSeriousViolations(controller.page,'ledger '+route);}
 await controller.context.close();await preparer.context.close();
});

// The sales profile (control accounts, rounding) and numbering series have no
// reviewed operations yet, so the journey seeds them through the runtime role
// exactly as an operator would today; everything else goes through the screens.
async function seedSales(){
 const pg=createRequire(new URL('../../packages/database/package.json',import.meta.url))('pg');
 const db=new pg.Client(connectionOptions(process.env.LARA_E2E_DATABASE_URL));await db.connect();
 try{
  const tenantId=(await db.query('select tenant_id from lara.principal_directory where oidc_subject=$1',[who('controller')])).rows[0].tenant_id;
  await db.query("select set_config('lara.tenant_id',$1,false)",[tenantId]);
  const entity=(await db.query('select id from lara.entities where tenant_id=$1 order by created_at limit 1',[tenantId])).rows[0].id;
  const branch=(await db.query("select id from lara.branches where tenant_id=$1 and entity_id=$2 and code='HQ'",[tenantId,entity])).rows[0].id;
  const acct=async code=>(await db.query('select id from lara.accounts where tenant_id=$1 and entity_id=$2 and code=$3',[tenantId,entity,code])).rows[0].id;
  const principal=async role=>(await db.query('select principal_id from lara.principal_directory where oidc_subject=$1 and tenant_id=$2',[who(role),tenantId])).rows[0].principal_id;
  const payload={arAccountId:await acct('1200'),outputTaxAccountId:await acct('2200'),cashAccountId:await acct('1010'),scale:2,dueDays:30};
  const hash=(await db.query("select encode(sha256(convert_to($1,'utf8')),'hex') as h",[JSON.stringify(payload)])).rows[0].h;
  await db.query("insert into lara.settings_versions(tenant_id,entity_id,kind,version_number,payload,payload_hash,status,approved_by,effective_at,created_by) values($1,$2,'sales_profile',1,$3,$4,'approved',$5,now(),$6)",[tenantId,entity,JSON.stringify(payload),hash,await principal('preparer'),await principal('controller')]);
  for(const [kind,prefix] of [['invoice','INV'],['credit_note','CN']])await db.query("insert into lara.document_series(tenant_id,entity_id,branch_id,kind,prefix,profile_version,created_by) values($1,$2,$3,$4,$5,'numbering-2026',$6)",[tenantId,entity,branch,kind,prefix,await principal('controller')]);
  // A draft VAT rule authored by billing; the controller approves and activates it on screen.
  const evidence=(await db.query("select id from lara.evidence where tenant_id=$1 and entity_id=$2 and status='available' order by created_at limit 1",[tenantId,entity])).rows[0].id;
  await db.query("insert into lara.tax_rule_versions(tenant_id,entity_id,code,version_number,tax_type,valid_from,rate,basis,recognition,rounding,applicability_profile_id,source_evidence_ids,golden_case_ids,content_hash,created_by) values($1,$2,'VAT12',1,'vat','2026-01-01',0.12,'net','issue','line_half_up',gen_random_uuid(),$3,'[\"AC-01\"]',$4,$5)",[tenantId,entity,JSON.stringify([evidence]),hash,await principal('billing')]);
 }finally{await db.end();}
}
// The customer may have been renamed by the stale-version journey; pick it by prefix.
const pickCustomer=async page=>{const box=page.getByRole('combobox',{name:'Customer'});await expect(box.locator('option',{hasText:'Northwind Services'})).toHaveCount(1);await box.selectOption(await box.locator('option',{hasText:'Northwind Services'}).getAttribute('value'));};
test('sales: capability activation, control accounts, tax rule approval, invoice with server totals through review and issuance, delivery job, receipt with allocation, customer statement and aging',async({browser})=>{
 test.setTimeout(360000);
 const controller=await as(browser,'controller'),preparer=await as(browser,'preparer'),billing=await as(browser,'billing');
 for(const who of [controller,preparer]){
  await who.page.goto('/settings/capabilities');await settled(who.page);
  const card=who.page.locator('section.demo-card').filter({hasText:'Sales invoicing and receivables'});
  await card.getByRole('combobox',{name:'Activation evidence'}).selectOption({label:'registration.pdf'});
  await card.getByLabel('Reason').fill(who===controller?'Sales go-live requested':'Reviewed sales activation evidence');
  await card.getByRole('button',{name:'Request or approve activation'}).click();
  await expect(who.page.locator('section[role="alert"]')).toHaveCount(0);
 }
 // Control accounts by the preparer and an October period by the controller (September was locked by the close journey).
 await preparer.page.goto('/ledger/accounts');await settled(preparer.page);
 const acct=async(code,name,category,control)=>{const form=preparer.page.locator('form').filter({has:preparer.page.getByRole('button',{name:'Create account'})});await form.getByLabel('Code',{exact:true}).fill(code);await form.getByLabel('Name',{exact:true}).fill(name);await form.getByRole('combobox',{name:'Category'}).selectOption(category);await form.getByRole('combobox',{name:'Control type'}).selectOption(control);await form.getByRole('button',{name:'Create account'}).click();await expect(preparer.page.getByRole('cell',{name:code,exact:true})).toBeVisible();};
 await acct('1200','Receivables','asset','ar');await acct('2200','Output tax payable','liability','output_tax');
 await controller.page.goto('/ledger/periods');await settled(controller.page);
 await controller.page.getByLabel('Starts on').fill('2026-10-01');await controller.page.getByLabel('Ends on').fill('2026-10-31');
 await controller.page.getByRole('button',{name:'Create period'}).click();
 await expect(controller.page.getByRole('cell',{name:'2026-10-01 → 2026-10-31'})).toBeVisible();
 await seedSales();
 // Tax rule: controller approves and activates the drafted VAT rule.
 await controller.page.goto('/settings/tax-rules');await settled(controller.page);
 const ruleRow=()=>controller.page.getByRole('row').filter({hasText:'VAT12'});
 await ruleRow().getByRole('button',{name:'Approve'}).click();
 await expect(ruleRow().getByRole('cell',{name:'approved',exact:true})).toBeVisible();
 await ruleRow().getByLabel('Reason').fill('Effective 2026');
 await ruleRow().getByRole('button',{name:'Activate'}).click();
 await expect(ruleRow().getByRole('cell',{name:'active',exact:true})).toBeVisible();
 // Invoice by billing: server totals, submit; preparer approves and issues.
 await billing.page.goto('/sales/invoices');await settled(billing.page);
 await expect(billing.page.getByText('No invoices yet.')).toBeVisible();
 await pickCustomer(billing.page);
 await billing.page.getByLabel('Document date').fill('2026-10-05');await billing.page.getByLabel('Accounting date').fill('2026-10-05');
 await billing.page.getByRole('textbox',{name:'Line 1 description'}).fill('Consulting retainer');
 await billing.page.getByRole('textbox',{name:'Line 1 unit price'}).fill('10000');
 await billing.page.getByRole('combobox',{name:'Line 1 revenue account'}).selectOption({label:'4000 Service revenue'});
 await billing.page.getByRole('combobox',{name:'Line 1 tax rule'}).selectOption({label:'VAT12 12%'});
 await expect(billing.page.getByRole('status').filter({hasText:'Preview'})).toContainText('gross ₱11,200.00');
 await billing.page.getByRole('button',{name:'Save draft'}).click();
 await expect(billing.page).toHaveURL(/\/sales\/invoices\/[0-9a-f-]{36}$/);
 const invoiceUrl=new URL(billing.page.url()).pathname;
 await expect(billing.page.getByText('Gross ₱11,200.00',{exact:true})).toBeVisible();
 await expect(billing.page.getByRole('button',{name:'Approve',exact:true})).toHaveCount(0);
 await billing.page.getByRole('button',{name:'Submit for approval'}).click();
 await expect(billing.page.locator('.status-grid dd').first()).toHaveText('submitted');
 await preparer.page.goto(invoiceUrl);await settled(preparer.page);
 await preparer.page.getByRole('button',{name:'Approve',exact:true}).click();
 await expect(preparer.page.locator('.status-grid dd').first()).toHaveText('approved');
 await preparer.page.getByRole('button',{name:'Issue invoice'}).click();
 await expect(preparer.page.locator('h2').filter({hasText:'Invoice INV-000001'})).toBeVisible();
 await expect(preparer.page.locator('.status-grid dd')).toHaveText(['posted','not requested','not applicable','unpaid']);
 await expect(preparer.page.getByText('Issued documents are immutable; corrections are new linked documents.')).toBeVisible();
 // Delivery through the worker.
 await billing.page.goto(invoiceUrl);await settled(billing.page);
 await billing.page.getByRole('button',{name:'Deliver to customer'}).click();
 await expect(billing.page.locator('.status-grid dd').nth(1)).toHaveText('queued');
 await expect.poll(async()=>{await billing.page.reload();await settled(billing.page);return billing.page.locator('.status-grid dd').nth(1).textContent();},{timeout:60000}).toBe('sent');
 // Receipt with the allocation workbench; preparer approves and posts; the invoice is paid.
 await billing.page.goto('/sales/collections');await settled(billing.page);
 await pickCustomer(billing.page);
 await billing.page.getByLabel('Value date',{exact:true}).fill('2026-10-06');
 await billing.page.getByLabel('Gross received').fill('11200');await billing.page.getByLabel('Cash amount').fill('11200');
 await billing.page.getByRole('button',{name:'Full'}).click();
 await expect(billing.page.getByRole('status').filter({hasText:'Allocated'})).toContainText('fully applied');
 await billing.page.getByRole('button',{name:'Save receipt'}).click();
 await expect(billing.page).toHaveURL(/\/sales\/collections\/[0-9a-f-]{36}$/);
 const receiptUrl=new URL(billing.page.url()).pathname;
 await billing.page.getByRole('button',{name:'Submit for approval'}).click();
 await expect(billing.page.getByText('State submitted',{exact:false})).toBeVisible();
 await preparer.page.goto(receiptUrl);await settled(preparer.page);
 await preparer.page.getByRole('button',{name:'Approve',exact:true}).click();
 await expect(preparer.page.getByText('State approved',{exact:false})).toBeVisible();
 await preparer.page.getByRole('button',{name:'Post receipt'}).click();
 await expect(preparer.page.getByText('State posted',{exact:false})).toBeVisible();
 await expect(preparer.page.getByRole('cell',{name:'₱11,200.00'}).first()).toBeVisible();
 await preparer.page.goto(invoiceUrl);await settled(preparer.page);
 await expect(preparer.page.locator('.status-grid dd').nth(3)).toHaveText('paid');
 // Customer statement: nothing outstanding; aging job renders from its snapshot.
 await controller.page.goto('/sales/customers');await settled(controller.page);
 await expect(controller.page.getByText('No receivables.')).toBeVisible();
 await controller.page.getByRole('button',{name:'Generate aging report'}).click();
 await expect(controller.page.getByRole('status').filter({hasText:'Aging job'})).toContainText('succeeded',{timeout:60000});
 await expect(controller.page.getByText(/Nothing outstanding as of/)).toBeVisible();
 for(const route of ['/sales/invoices','/sales/orders','/sales/collections','/sales/customers','/settings/tax-rules',invoiceUrl,receiptUrl]){await controller.page.goto(route);await settled(controller.page);await noSeriousViolations(controller.page,'sales '+route);}
 await controller.context.close();await preparer.context.close();await billing.context.close();
});

// The purchasing profile, bill numbering series, the purchaser role and the
// reviewed beneficiary have no reviewed operations yet, so the journey seeds
// them through the runtime role as an operator would; everything else goes
// through the screens.
async function seedPurchasing(){
 const pg=createRequire(new URL('../../packages/database/package.json',import.meta.url))('pg');
 const db=new pg.Client(connectionOptions(process.env.LARA_E2E_DATABASE_URL));await db.connect();
 try{
  const tenantId=(await db.query('select tenant_id from lara.principal_directory where oidc_subject=$1',[who('controller')])).rows[0].tenant_id;
  await db.query("select set_config('lara.tenant_id',$1,false)",[tenantId]);
  const entity=(await db.query('select id from lara.entities where tenant_id=$1 order by created_at limit 1',[tenantId])).rows[0].id;
  const branch=(await db.query("select id from lara.branches where tenant_id=$1 and entity_id=$2 and code='HQ'",[tenantId,entity])).rows[0].id;
  const acct=async code=>(await db.query('select id from lara.accounts where tenant_id=$1 and entity_id=$2 and code=$3',[tenantId,entity,code])).rows[0].id;
  const principal=async role=>(await db.query('select principal_id from lara.principal_directory where oidc_subject=$1 and tenant_id=$2',[who(role),tenantId])).rows[0].principal_id;
  const payload={apAccountId:await acct('2100'),inputTaxAccountId:await acct('1300'),cashAccountId:await acct('1010'),advanceAccountId:await acct('1400'),withholdingRecognition:'accrual',scale:2,dueDays:30};
  const hash=(await db.query("select encode(sha256(convert_to($1,'utf8')),'hex') as h",[JSON.stringify(payload)])).rows[0].h;
  await db.query("insert into lara.settings_versions(tenant_id,entity_id,kind,version_number,payload,payload_hash,status,approved_by,effective_at,created_by) values($1,$2,'purchasing_profile',1,$3,$4,'approved',$5,now(),$6)",[tenantId,entity,JSON.stringify(payload),hash,await principal('preparer'),await principal('controller')]);
  await db.query("insert into lara.document_series(tenant_id,entity_id,branch_id,kind,prefix,profile_version,created_by) values($1,$2,$3,'bill','BILL','numbering-2026',$4)",[tenantId,entity,branch,await principal('controller')]);
  // No seeded template holds purchase_order.create; the clerk gets a tenant role for orders.
  const role=(await db.query("insert into lara.roles(tenant_id,code,name,permissions,status,content_hash,created_by) values($1,'purchaser','Purchaser','[\"purchase_order.create\",\"purchase_order.edit\",\"purchase_order.read\",\"purchase_order.submit\",\"purchase_order.cancel\"]','approved',$2,$3) returning id",[tenantId,hash,await principal('security')])).rows[0].id;
  await db.query('insert into lara.memberships(tenant_id,principal_id,role_id,created_by) values($1,$2,$3,$4)',[tenantId,await principal('clerk'),role,await principal('security')]);
  const supplier=(await db.query("select id from lara.party where tenant_id=$1 and entity_id=$2 and legal_name='Supplies Inc'",[tenantId,entity])).rows[0].id;
  const ben=(await db.query("insert into lara.beneficiary_versions(tenant_id,entity_id,party_id,version_number,bank_name,account_name,account_number_encrypted,account_number_last4,content_hash,created_by,status,reviewed_by) values($1,$2,$3,1,'BDO','Supplies Inc','v1:seeded','7890',$4,$5,'approved',$6) returning id",[tenantId,entity,supplier,hash,await principal('preparer'),await principal('controller')])).rows[0].id;
  return {beneficiaryId:ben};
 }finally{await db.end();}
}
test('purchasing: capability activation, supplier and control accounts, purchase order approval, bill with server totals through review and posting, payment proposal through authority, manual release and settlement, supplier aging',async({browser})=>{
 test.setTimeout(420000);
 const controller=await as(browser,'controller'),preparer=await as(browser,'preparer'),clerk=await as(browser,'clerk'),treasury=await as(browser,'treasury');
 for(const who of [controller,preparer]){
  await who.page.goto('/settings/capabilities');await settled(who.page);
  const card=who.page.locator('section.demo-card').filter({hasText:'Purchasing payables and expenses'});
  await card.getByRole('combobox',{name:'Activation evidence'}).selectOption({label:'registration.pdf'});
  await card.getByLabel('Reason').fill(who===controller?'Purchasing go-live requested':'Reviewed purchasing activation evidence');
  await card.getByRole('button',{name:'Request or approve activation'}).click();
  await expect(who.page.locator('section[role="alert"]')).toHaveCount(0);
 }
 // Supplier by the clerk; payables, input tax, advances and an expense account by the preparer.
 await clerk.page.goto('/parties');await settled(clerk.page);
 const form=clerk.page.locator('form').filter({has:clerk.page.getByRole('button',{name:'Create party'})});
 await form.getByLabel('Legal name').fill('Supplies Inc');
 await form.getByRole('combobox',{name:'Role',exact:true}).selectOption('supplier');
 await form.getByRole('combobox',{name:'Identity',exact:true}).selectOption('unknown');
 await form.getByLabel('Address',{exact:true}).fill('Mandaue City');
 await form.getByRole('button',{name:'Create party'}).click();
 await expect(clerk.page).toHaveURL(/\/parties\/[0-9a-f-]{36}$/);
 await preparer.page.goto('/ledger/accounts');await settled(preparer.page);
 const acct=async(code,name,category,control)=>{const f=preparer.page.locator('form').filter({has:preparer.page.getByRole('button',{name:'Create account'})});await f.getByLabel('Code',{exact:true}).fill(code);await f.getByLabel('Name',{exact:true}).fill(name);await f.getByRole('combobox',{name:'Category'}).selectOption(category);await f.getByRole('combobox',{name:'Control type'}).selectOption(control);await f.getByRole('button',{name:'Create account'}).click();await expect(preparer.page.getByRole('cell',{name:code,exact:true})).toBeVisible();};
 await acct('2100','Payables','liability','ap');await acct('1300','Input tax','asset','input_tax');await acct('1400','Employee advances','asset','none');await acct('5000','Professional fees','expense','none');
 const {beneficiaryId}=await seedPurchasing();
 // Purchase order by the clerk (purchaser role), approved by the controller.
 await clerk.page.goto('/purchases/orders');await settled(clerk.page);
 await expect(clerk.page.getByText('No purchase orders yet.')).toBeVisible();
 await clerk.page.getByRole('combobox',{name:'Supplier'}).selectOption({label:'Supplies Inc'});
 await clerk.page.getByLabel('Document date').fill('2026-10-07');await clerk.page.getByLabel('Accounting date').fill('2026-10-07');
 await clerk.page.getByRole('textbox',{name:'Line 1 description'}).fill('Cleaning services Q4');
 await clerk.page.getByRole('textbox',{name:'Line 1 unit price'}).fill('20000');
 await clerk.page.getByRole('combobox',{name:'Line 1 expense account'}).selectOption({label:'5000 Professional fees'});
 await clerk.page.getByRole('button',{name:'Save draft'}).click();
 const orderRow=page=>page.getByRole('row').filter({hasText:'Supplies Inc'}).filter({hasText:'₱20,000.00'});
 await expect(orderRow(clerk.page)).toBeVisible();
 await orderRow(clerk.page).getByRole('button',{name:'Submit'}).click();
 await expect(orderRow(clerk.page).getByRole('cell',{name:'submitted',exact:true})).toBeVisible();
 await controller.page.goto('/purchases/orders');await settled(controller.page);
 await orderRow(controller.page).getByRole('button',{name:'Approve',exact:true}).click();
 await expect(orderRow(controller.page).getByRole('cell',{name:'approved',exact:true})).toBeVisible();
 // Bill against the order with the scanned invoice as evidence; server totals; preparer approves and posts.
 await clerk.page.goto('/purchases/bills');await settled(clerk.page);
 await expect(clerk.page.getByText('No bills yet.')).toBeVisible();
 await clerk.page.getByRole('combobox',{name:'Supplier'}).selectOption({label:'Supplies Inc'});
 await clerk.page.getByLabel('Document date').fill('2026-10-08');await clerk.page.getByLabel('Accounting date').fill('2026-10-08');
 await clerk.page.getByLabel('Supplier invoice reference').fill('SI-2026-001');
 const poBox=clerk.page.getByRole('combobox',{name:'Purchase order (optional)'});
 await poBox.selectOption(await poBox.locator('option',{hasText:'Supplies Inc'}).getAttribute('value'));
 await clerk.page.getByRole('combobox',{name:'Source evidence'}).selectOption({label:'registration.pdf'});
 await clerk.page.getByRole('textbox',{name:'Line 1 description'}).fill('Cleaning services October');
 await clerk.page.getByRole('textbox',{name:'Line 1 unit price'}).fill('10000');
 await clerk.page.getByRole('combobox',{name:'Line 1 expense account'}).selectOption({label:'5000 Professional fees'});
 await clerk.page.getByRole('combobox',{name:'Line 1 tax rule'}).selectOption({label:'VAT12 12%'});
 await expect(clerk.page.getByRole('status').filter({hasText:'Preview'})).toContainText('gross ₱11,200.00');
 await clerk.page.getByRole('button',{name:'Save draft'}).click();
 await expect(clerk.page).toHaveURL(/\/purchases\/bills\/[0-9a-f-]{36}$/);
 const billUrl=new URL(clerk.page.url()).pathname;
 await expect(clerk.page.getByText('Gross ₱11,200.00',{exact:true})).toBeVisible();
 await expect(clerk.page.getByRole('button',{name:'Approve',exact:true})).toHaveCount(0);
 await clerk.page.getByRole('button',{name:'Submit for approval'}).click();
 await expect(clerk.page.locator('.status-grid dd').first()).toHaveText('submitted');
 await preparer.page.goto(billUrl);await settled(preparer.page);
 await preparer.page.getByRole('button',{name:'Approve',exact:true}).click();
 await expect(preparer.page.locator('.status-grid dd').first()).toHaveText('approved');
 await preparer.page.getByRole('button',{name:'Post bill'}).click();
 await expect(preparer.page.locator('.status-grid dd')).toHaveText(['posted','not requested','not applicable','unpaid']);
 await expect(preparer.page.getByText('BILL-000001',{exact:false}).first()).toBeVisible();
 await expect(preparer.page.getByText('Posted documents are immutable; corrections are new linked documents.')).toBeVisible();
 await clerk.page.goto('/purchases/orders');await settled(clerk.page);
 await expect(orderRow(clerk.page)).toContainText('₱10,000.00');
 // Payment: treasury proposes and submits, creates the order against the reviewed beneficiary, the controller authorizes, treasury records the manual release and the bank settlement.
 await treasury.page.goto('/payments');await settled(treasury.page);
 await treasury.page.getByRole('combobox',{name:'Payee'}).selectOption({label:'Supplies Inc'});
 await treasury.page.getByLabel('Value date',{exact:true}).fill('2026-10-09');
 await treasury.page.getByLabel('Gross payment').fill('11200');await treasury.page.getByLabel('Cash amount').fill('11200');
 await treasury.page.getByRole('button',{name:'Full'}).click();
 await expect(treasury.page.getByRole('status').filter({hasText:'Allocated'})).toContainText('ready');
 await treasury.page.getByRole('button',{name:'Save proposal'}).click();
 await expect(treasury.page).toHaveURL(/\/payments\/[0-9a-f-]{36}$/);
 const paymentUrl=new URL(treasury.page.url()).pathname;
 await treasury.page.getByRole('button',{name:'Submit proposal'}).click();
 await expect(treasury.page.getByText('State submitted',{exact:false})).toBeVisible();
 await treasury.page.getByLabel('Approved beneficiary version id').fill(beneficiaryId);
 await treasury.page.getByRole('button',{name:'Create payment order'}).click();
 await expect(treasury.page.getByText('Payment draft',{exact:false})).toBeVisible();
 await treasury.page.getByRole('button',{name:'Submit for authority'}).click();
 await expect(treasury.page.getByText('Payment submitted',{exact:false})).toBeVisible();
 await expect(treasury.page.getByRole('button',{name:'Authorize payment'})).toHaveCount(0);
 await controller.page.goto(paymentUrl);await settled(controller.page);
 await controller.page.getByRole('button',{name:'Authorize payment'}).click();
 await expect(controller.page.getByText('Payment authorized',{exact:false})).toBeVisible();
 await treasury.page.goto(paymentUrl);await settled(treasury.page);
 await treasury.page.getByLabel('Bank transaction reference').fill('TXN-2026-77');
 await treasury.page.getByRole('combobox',{name:'Evidence'}).selectOption({label:'registration.pdf'});
 await treasury.page.getByRole('button',{name:'Record manual release'}).click();
 await expect(treasury.page.getByText('Payment released',{exact:false})).toBeVisible();
 await treasury.page.getByLabel('Bank settlement reference').fill('BANK-2026-77');
 await treasury.page.getByLabel('Value date',{exact:true}).fill('2026-10-09');
 await treasury.page.getByRole('combobox',{name:'Evidence'}).selectOption({label:'registration.pdf'});
 await treasury.page.getByRole('button',{name:'Record settlement'}).click();
 await expect(treasury.page.getByText('Payment settled',{exact:false})).toBeVisible();
 await expect(treasury.page.getByText('State posted',{exact:false})).toBeVisible();
 await preparer.page.goto(billUrl);await settled(preparer.page);
 await expect(preparer.page.locator('.status-grid dd').nth(3)).toHaveText('paid');
 // Supplier statement: nothing outstanding; the aging job renders from its snapshot.
 await controller.page.goto('/purchases/suppliers');await settled(controller.page);
 await expect(controller.page.getByText('No payables.')).toBeVisible();
 await controller.page.getByRole('button',{name:'Generate supplier aging'}).click();
 await expect(controller.page.getByRole('status').filter({hasText:'Supplier aging job'})).toContainText('succeeded',{timeout:60000});
 await expect(controller.page.getByText(/Nothing payable as of/)).toBeVisible();
 for(const route of ['/purchases/bills','/purchases/orders','/purchases/claims','/payments','/purchases/suppliers',billUrl,paymentUrl]){await controller.page.goto(route);await settled(controller.page);await noSeriousViolations(controller.page,'purchasing '+route);}
 await controller.context.close();await preparer.context.close();await clerk.context.close();await treasury.context.close();
});

test('forbidden, roadmap and unknown-account states are explicit; keyboard and mobile flows pass WCAG checks',async({browser})=>{
 test.setTimeout(240000);
 const clerk=await as(browser,'clerk');
 await clerk.page.goto('/settings/setup');await settled(clerk.page);
 await expect(clerk.page.getByRole('button',{name:'Create organization'})).toHaveCount(0);
 await expect(clerk.page.getByRole('button',{name:'Request activation'})).toHaveCount(0);
 await clerk.page.goto('/compliance');await expect(clerk.page.locator('h1')).toHaveText('Coming in a later release');
 await expect(clerk.page.getByText('with P07',{exact:false})).toBeVisible();
 const stranger=await browser.newContext({baseURL:BASE});await stranger.addCookies([cookie('nobody-'+suffix)]);const sp=await stranger.newPage();
 await sp.goto('/work');await expect(sp.locator('section[role="alert"]')).toContainText('no workspace membership');
 await stranger.close();
 const {context,page}=await as(browser,'clerk');
 for(const size of [{width:1440,height:900},{width:390,height:844}]){
  await page.setViewportSize(size);
  for(const route of ['/work','/overview','/parties','/evidence','/obligations','/settings/setup']){
   await page.goto(route);await settled(page);
   expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),route+' '+size.width).toBe(true);
   await noSeriousViolations(page,route+' '+size.width);
  }
 }
 await page.goto('/parties');await settled(page);
 await page.keyboard.press('Tab');await expect(page.getByRole('link',{name:'Skip to content'})).toBeFocused();
 await page.keyboard.press('Enter');
 for(let i=0;i<30;i++){await page.keyboard.press('Tab');if(await page.getByLabel('Legal name').evaluate(e=>e===document.activeElement))break;}
 await expect(page.getByLabel('Legal name')).toBeFocused();
 await clerk.context.close();await context.close();
});
