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
import {createHash} from 'node:crypto';
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
 worker=spawn(process.execPath,['apps/worker/src/main.mjs'],{stdio:['ignore','pipe','pipe'],env:{...process.env,LARA_MODE:'local',WORKER_DATABASE_URL:process.env.WORKER_DATABASE_URL||process.env.SUPABASE_LARA_WORKER_DATABASE_URL,OBJECT_ADAPTER:'filesystem',OBJECT_BUCKET:'.local/e2e-workspace',WORKER_POLL_MS:'250',EINVOICE_ADAPTER:'fixture',E2E_EINVOICE_KEY:'browser-signing-key',E2E_EINVOICE_CREDENTIALS:'000-111-222-333:secret'}});
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

// The treasury profile and the transfer/handover approver permissions have no
// reviewed operations or seeded template yet; the journey seeds them through
// the runtime role as an operator would. Everything else goes through the screens.
async function seedTreasury(){
 const pg=createRequire(new URL('../../packages/database/package.json',import.meta.url))('pg');
 const db=new pg.Client(connectionOptions(process.env.LARA_E2E_DATABASE_URL));await db.connect();
 try{
  const tenantId=(await db.query('select tenant_id from lara.principal_directory where oidc_subject=$1',[who('controller')])).rows[0].tenant_id;
  await db.query("select set_config('lara.tenant_id',$1,false)",[tenantId]);
  const entity=(await db.query('select id from lara.entities where tenant_id=$1 order by created_at limit 1',[tenantId])).rows[0].id;
  const acct=async code=>(await db.query('select id from lara.accounts where tenant_id=$1 and entity_id=$2 and code=$3',[tenantId,entity,code])).rows[0].id;
  const principal=async role=>(await db.query('select principal_id from lara.principal_directory where oidc_subject=$1 and tenant_id=$2',[who(role),tenantId])).rows[0].principal_id;
  const payload={cashAccountId:await acct('1010'),cashVarianceAccountId:await acct('5950'),fileFormatVersion:'lara-csv-1',matchWindowDays:3};
  const hash=(await db.query("select encode(sha256(convert_to($1,'utf8')),'hex') as h",[JSON.stringify(payload)])).rows[0].h;
  await db.query("insert into lara.settings_versions(tenant_id,entity_id,kind,version_number,payload,payload_hash,status,approved_by,effective_at,created_by) values($1,$2,'treasury_profile',1,$3,$4,'approved',$5,now(),$6)",[tenantId,entity,JSON.stringify(payload),hash,await principal('preparer'),await principal('controller')]);
  const role=(await db.query("insert into lara.roles(tenant_id,code,name,permissions,status,content_hash,created_by) values($1,'treasury_approver','Treasury approver','[\"transfer.approve\",\"transfer.post\",\"transfer.read\",\"cash_session.handover\",\"cash_session.read\"]','approved',$2,$3) returning id",[tenantId,hash,await principal('security')])).rows[0].id;
  await db.query('insert into lara.memberships(tenant_id,principal_id,role_id,created_by) values($1,$2,$3,$4)',[tenantId,await principal('controller'),role,await principal('security')]);
 }finally{await db.end();}
}
test('treasury: capability activation, reviewed bank accounts, statement import through the import pipeline, proposed matches confirmed on the reconciliation workbench, transfer, check custody to clearing, cash session with variance and independent handover',async({browser})=>{
 test.setTimeout(480000);
 const controller=await as(browser,'controller'),preparer=await as(browser,'preparer'),treasury=await as(browser,'treasury');
 for(const who of [controller,preparer]){
  await who.page.goto('/settings/capabilities');await settled(who.page);
  const card=who.page.locator('section.demo-card').filter({hasText:'Treasury cash and bank reconciliation'});
  await card.getByRole('combobox',{name:'Activation evidence'}).selectOption({label:'registration.pdf'});
  await card.getByLabel('Reason').fill(who===controller?'Treasury go-live requested':'Reviewed treasury activation evidence');
  await card.getByRole('button',{name:'Request or approve activation'}).click();
  await expect(who.page.locator('section[role="alert"]')).toHaveCount(0);
 }
 await preparer.page.goto('/ledger/accounts');await settled(preparer.page);
 const acct=async(code,name,category,control)=>{const f=preparer.page.locator('form').filter({has:preparer.page.getByRole('button',{name:'Create account'})});await f.getByLabel('Code',{exact:true}).fill(code);await f.getByLabel('Name',{exact:true}).fill(name);await f.getByRole('combobox',{name:'Category'}).selectOption(category);await f.getByRole('combobox',{name:'Control type'}).selectOption(control);await f.getByRole('button',{name:'Create account'}).click();await expect(preparer.page.getByRole('cell',{name:code,exact:true})).toBeVisible();};
 await acct('1020','Bank BDO','asset','none');await acct('1030','Bank BPI','asset','none');await acct('5950','Cash over and short','expense','none');
 await seedTreasury();
 // Bank accounts entered by treasury, approved by the controller.
 await treasury.page.goto('/bank/accounts');await settled(treasury.page);
 await expect(treasury.page.getByText('No bank accounts yet.')).toBeVisible();
 const bank=async(code,number,ledger)=>{await treasury.page.getByLabel('Bank code').fill(code);await treasury.page.getByLabel('Account number').fill(number);await treasury.page.getByRole('combobox',{name:'Ledger account'}).selectOption({label:ledger});await treasury.page.getByRole('combobox',{name:'Bank confirmation'}).selectOption({label:'registration.pdf'});await treasury.page.getByRole('button',{name:'Save draft'}).click();await expect(treasury.page.getByRole('row').filter({hasText:code}).getByRole('cell',{name:'draft',exact:true})).toBeVisible();};
 await bank('BDO','001234567890','1020 Bank BDO');await bank('BPI','9988776655','1030 Bank BPI');
 await expect(treasury.page.getByRole('button',{name:'Approve'})).toHaveCount(0);
 await controller.page.goto('/bank/accounts');await settled(controller.page);
 for(const code of ['BDO','BPI']){await controller.page.getByRole('row').filter({hasText:code}).getByRole('button',{name:'Approve'}).click();await expect(controller.page.getByRole('row').filter({hasText:code}).getByRole('cell',{name:'approved',exact:true})).toBeVisible();}
 const bankAccounts=(await (await treasury.page.request.get('/api/v1/bank-accounts',{headers:{'x-entity-id':(await (await treasury.page.request.get('/api/v1/me')).json()).entityIds[0]}})).json()).items;
 const bdoId=bankAccounts.find(b=>b.bankCode==='BDO').id;
 // Statement upload as CSV evidence, then the import pipeline with the bank account as the source.
 const statement=Buffer.from(['source_line_key,booked_date,value_date,signed_amount,currency,reference,description','opening_balance,2026-10-01,,0.00,PHP,,','closing_balance,2026-10-10,,0.00,PHP,,','L1,2026-10-06,2026-10-06,11200.00,PHP,,Northwind transfer','L2,2026-10-09,2026-10-09,-11200.00,PHP,,Supplies Inc payment'].join('\n')+'\n');
 await treasury.page.goto('/evidence');await settled(treasury.page);
 await treasury.page.locator('input[type="file"]').setInputFiles({name:'statement-october.csv',mimeType:'text/csv',buffer:statement});
 await treasury.page.getByRole('button',{name:'Upload evidence'}).click();
 await expect(treasury.page.getByRole('status').filter({hasText:'Queued for scanning'})).toBeVisible({timeout:30000});
 await treasury.page.getByRole('link',{name:'statement-october.csv'}).click();
 await expect(treasury.page.getByRole('status')).toContainText('Available',{timeout:60000});
 await preparer.page.goto('/ledger/imports');await settled(preparer.page);
 await preparer.page.getByRole('combobox',{name:'Kind'}).selectOption('bank_statement');
 await preparer.page.getByRole('combobox',{name:'CSV evidence'}).selectOption({label:'statement-october.csv'});
 await preparer.page.getByLabel('Mapping version').fill('lara-csv-1');
 await preparer.page.getByLabel('Source system or bank account id').fill(bdoId);
 await preparer.page.getByLabel('External batch id').fill('STMT-2026-10');
 await preparer.page.getByLabel('Cutoff date').fill('2026-10-10');
 await preparer.page.getByRole('button',{name:'Stage import'}).click();
 const importRow=page=>page.getByRole('row').filter({hasText:'STMT-2026-10'});
 await expect(importRow(preparer.page)).toBeVisible();
 await importRow(preparer.page).getByRole('button',{name:'Validate'}).click();
 await expect(importRow(preparer.page).getByRole('cell',{name:'validated',exact:true})).toBeVisible();
 await controller.page.goto('/ledger/imports');await settled(controller.page);
 await importRow(controller.page).getByRole('button',{name:'Approve'}).click();
 await expect(importRow(controller.page).getByRole('cell',{name:'approved',exact:true})).toBeVisible();
 await importRow(controller.page).getByRole('button',{name:'Commit'}).click();
 await expect(importRow(controller.page).getByRole('cell',{name:'committed',exact:true})).toBeVisible();
 // Reconciliation workbench: the worker proposes both exact-amount matches; the preparer confirms them.
 await preparer.page.goto('/bank/reconcile');await settled(preparer.page);
 await expect(preparer.page.getByRole('row').filter({hasText:'Northwind transfer'})).toBeVisible();
 // The proposals arrive from the worker; bankId-dependent lists render empty before their fetch completes, so wait for the buttons after each reload.
 await expect.poll(async()=>{await preparer.page.reload();await settled(preparer.page);return preparer.page.getByRole('button',{name:'Confirm',exact:true}).count().then(async n=>n===2?2:expect(preparer.page.getByRole('button',{name:'Confirm',exact:true})).toHaveCount(2,{timeout:5000}).then(()=>2).catch(()=>0));},{timeout:120000}).toBe(2);
 for(let i=0;i<2;i++){await preparer.page.getByRole('button',{name:'Confirm',exact:true}).first().click();await expect(preparer.page.getByRole('button',{name:'Confirm',exact:true})).toHaveCount(1-i);}
 await expect(preparer.page.getByRole('row').filter({hasText:'Northwind transfer'}).getByRole('cell',{name:'matched',exact:true})).toBeVisible();
 await expect(preparer.page.getByText('0 unmatched statement line(s)',{exact:false})).toBeVisible();
 // Transfer between the two accounts.
 await treasury.page.goto('/bank/transfers');await settled(treasury.page);
 await treasury.page.getByRole('combobox',{name:'From'}).selectOption({index:1});await treasury.page.getByRole('combobox',{name:'To'}).selectOption({index:2});
 await treasury.page.getByRole('textbox',{name:'Amount'}).fill('1000');await treasury.page.getByRole('textbox',{name:'Value date'}).fill('2026-10-10');await treasury.page.getByRole('button',{name:'Save draft'}).click();
 await expect(treasury.page.getByRole('cell',{name:'draft',exact:true})).toBeVisible();
 await treasury.page.getByRole('button',{name:'Submit'}).click();
 await expect(treasury.page.getByRole('cell',{name:'submitted',exact:true})).toBeVisible();
 await controller.page.goto('/bank/transfers');await settled(controller.page);
 await controller.page.getByRole('button',{name:'Approve'}).click();
 await expect(controller.page.getByRole('cell',{name:'approved',exact:true})).toBeVisible();
 await controller.page.getByRole('button',{name:'Post transfer'}).click();
 await expect(controller.page.getByRole('cell',{name:'posted',exact:true})).toBeVisible();
 // Check register: custody, deposit, clearing.
 await treasury.page.goto('/bank/checks');await settled(treasury.page);
 await treasury.page.getByRole('combobox',{name:'Bank account'}).selectOption({index:1});
 await treasury.page.getByLabel('Check number').fill('PDC-1001');await treasury.page.getByRole('textbox',{name:'Amount'}).fill('2500');await treasury.page.getByLabel('Due date').fill('2026-10-20');
 await treasury.page.getByRole('combobox',{name:'Party'}).selectOption({index:1});
 await treasury.page.getByRole('button',{name:'Register'}).click();
 const checkRow=()=>treasury.page.getByRole('row').filter({hasText:'PDC-1001'});
 await expect(checkRow().first().getByRole('cell',{name:'custody',exact:true})).toBeVisible();
 await checkRow().last().getByLabel('Reason').fill('Deposited at branch');await checkRow().last().getByRole('button',{name:'Deposit'}).click();
 await expect(checkRow().last().getByRole('cell',{name:'deposited',exact:true})).toBeVisible();
 await checkRow().last().getByLabel('Reason').first().fill('Cleared per bank');await checkRow().last().getByRole('button',{name:'Clear'}).click();
 await expect(checkRow().last().getByRole('cell',{name:'cleared',exact:true})).toBeVisible();
 // Cash session: count with a variance, close, the cashier cannot attest, the controller attests.
 await treasury.page.goto('/bank/cash');await settled(treasury.page);
 await treasury.page.getByLabel('Business date').fill('2026-10-09');await treasury.page.getByLabel('Opening float').fill('5000');await treasury.page.getByRole('button',{name:'Open session'}).click();
 await expect(treasury.page.getByRole('heading',{level:3})).toContainText('open');
 await treasury.page.getByLabel('Quantity of 1000',{exact:true}).fill('4');await treasury.page.getByLabel('Quantity of 500',{exact:true}).fill('1');await treasury.page.getByLabel('Quantity of 100',{exact:true}).fill('3');
 await expect(treasury.page.getByRole('status').filter({hasText:'Counted'})).toContainText('₱4,800.00');
 await treasury.page.getByLabel('Variance reason (required when the count differs from the expected cash)').fill('Short 200: change given twice');
 await treasury.page.getByRole('button',{name:'Record count'}).click();
 await expect(treasury.page.getByRole('heading',{level:3})).toContainText('counted');
 await treasury.page.getByRole('button',{name:'Close session'}).click();
 await expect(treasury.page.getByRole('heading',{level:3})).toContainText('closed');
 await treasury.page.getByRole('button',{name:'Attest handover'}).click();
 await expect(treasury.page.locator('section[role="alert"]')).toContainText('cannot certify');
 await controller.page.goto('/bank/cash');await settled(controller.page);
 await controller.page.getByRole('button',{name:'Attest handover'}).click();
 await expect(controller.page.getByRole('heading',{level:3})).toContainText('handed over');
 for(const route of ['/bank/accounts','/bank/reconcile','/bank/transfers','/bank/checks','/bank/cash']){await controller.page.goto(route);await settled(controller.page);await noSeriousViolations(controller.page,'treasury '+route);}
 await controller.context.close();await preparer.context.close();await treasury.context.close();
});

// The compliance profile, the regulatory profile with its mapping artifact, the
// reporting-required sales profile and the tax officer permissions have no
// reviewed operations or seeded template yet; the journey seeds them through the
// runtime role as an operator would. Everything else goes through the screens.
async function seedCompliance(){
 const pg=createRequire(new URL('../../packages/database/package.json',import.meta.url))('pg');
 const db=new pg.Client(connectionOptions(process.env.LARA_E2E_DATABASE_URL));await db.connect();
 try{
  const tenantId=(await db.query('select tenant_id from lara.principal_directory where oidc_subject=$1',[who('controller')])).rows[0].tenant_id;
  await db.query("select set_config('lara.tenant_id',$1,false)",[tenantId]);
  const entity=(await db.query('select id from lara.entities where tenant_id=$1 order by created_at limit 1',[tenantId])).rows[0].id;
  const principal=async role=>(await db.query('select principal_id from lara.principal_directory where oidc_subject=$1 and tenant_id=$2',[who(role),tenantId])).rows[0].principal_id;
  const acct=async code=>(await db.query('select id from lara.accounts where tenant_id=$1 and entity_id=$2 and code=$3',[tenantId,entity,code])).rows[0].id;
  const settings=async(kind,payload,version)=>{const hash=(await db.query("select encode(sha256(convert_to($1,'utf8')),'hex') as h",[JSON.stringify(payload)])).rows[0].h;await db.query("insert into lara.settings_versions(tenant_id,entity_id,kind,version_number,payload,payload_hash,status,approved_by,effective_at,created_by) values($1,$2,$3,$4,$5,$6,'approved',$7,now(),$8)",[tenantId,entity,kind,version,JSON.stringify(payload),hash,await principal('preparer'),await principal('controller')]);return hash;};
  const hash=await settings('compliance_profile',{jurisdiction:'PH',taxpayerId:'000-111-222-333',transport:'fixture',destination:'fixture-authority',deadlineHours:72,signingKeyRef:'E2E_EINVOICE_KEY',credentialsRef:'E2E_EINVOICE_CREDENTIALS',profileVersion:'compliance-2026'},1);
  await settings('sales_profile',{arAccountId:await acct('1200'),outputTaxAccountId:await acct('2200'),cashAccountId:await acct('1010'),scale:2,dueDays:30,reportingRequired:true},2);
  const evidence=(await db.query("select id from lara.evidence where tenant_id=$1 and entity_id=$2 and filename='2550q-mapping.csv'",[tenantId,entity])).rows[0].id;
  const registration=(await db.query("select id from lara.evidence where tenant_id=$1 and entity_id=$2 and filename='registration.pdf'",[tenantId,entity])).rows[0].id;
  const profile=(await db.query("insert into lara.regulatory_profiles(tenant_id,entity_id,jurisdiction,version_number,coverage,valid_from,source_hash,evidence_ids,status,approved_by,activated_by,activated_at,created_by) values($1,$2,'PH',1,'[\"2550Q\"]','2026-01-01',$3,$4,'active',$5,$5,now(),$6) returning id",[tenantId,entity,hash,JSON.stringify([registration]),await principal('controller'),await principal('preparer')])).rows[0].id;
  const sha=(await db.query('select sha256 from lara.evidence where tenant_id=$1 and id=$2',[tenantId,evidence])).rows[0].sha256;
  await db.query("insert into lara.schema_artifacts(tenant_id,entity_id,profile_id,artifact_type,code,version_label,hash,evidence_id,status,approved_by,created_by) values($1,$2,$3,'form_mapping','2550Q','2026-v1',$4,$5,'approved',$6,$7)",[tenantId,entity,profile,sha,evidence,await principal('controller'),await principal('preparer')]);
  // No seeded template gives the preparer return preparation; a tenant role covers the tax officer duties.
  const role=(await db.query("insert into lara.roles(tenant_id,code,name,permissions,status,content_hash,created_by) values($1,'tax_officer','Tax officer','[\"return.create\",\"return.edit\",\"return.read\",\"return.prepare\",\"return.filed\",\"transmission.read\",\"transmission.reconcile\",\"transmission.retry\",\"registration.prepare\"]','approved',$2,$3) returning id",[tenantId,hash,await principal('security')])).rows[0].id;
  await db.query('insert into lara.memberships(tenant_id,principal_id,role_id,created_by) values($1,$2,$3,$4)',[tenantId,await principal('preparer'),role,await principal('security')]);
 }finally{await db.end();}
}
test('compliance: capability activation, readiness gates, a return run prepared from the reviewed mapping with the ledger tie-out, approved and filed with evidence, a reporting-required invoice transmitted by the worker and shown accepted in the queue, and the registration pack',async({browser})=>{
 test.setTimeout(480000);
 const controller=await as(browser,'controller'),preparer=await as(browser,'preparer'),billing=await as(browser,'billing');
 for(const who of [controller,preparer]){
  await who.page.goto('/settings/capabilities');await settled(who.page);
  const card=who.page.locator('section.demo-card').filter({hasText:'Tax compliance and e-invoicing'});
  await card.getByRole('combobox',{name:'Activation evidence'}).selectOption({label:'registration.pdf'});
  await card.getByLabel('Reason').fill(who===controller?'Compliance go-live requested':'Reviewed compliance activation evidence');
  await card.getByRole('button',{name:'Request or approve activation'}).click();
  await expect(who.page.locator('section[role="alert"]')).toHaveCount(0);
 }
 // The mapping artifact enters as CSV evidence, then the profiles are seeded.
 const mapping=Buffer.from(['line_code,description,family,tax_type,recognition,kinds,measure,sign','12A,Vatable sales,sales,vat,any,invoice,basis,1','12B,Output tax due,sales,vat,any,invoice,amount,1','20A,Vatable purchases,purchases,vat,any,any,basis,1','20B,Input tax,purchases,vat,any,any,amount,1'].join('\n')+'\n');
 await preparer.page.goto('/evidence');await settled(preparer.page);
 await preparer.page.locator('input[type="file"]').setInputFiles({name:'2550q-mapping.csv',mimeType:'text/csv',buffer:mapping});
 await preparer.page.getByRole('button',{name:'Upload evidence'}).click();
 await expect(preparer.page.getByRole('status').filter({hasText:'Queued for scanning'})).toBeVisible({timeout:30000});
 await preparer.page.getByRole('link',{name:'2550q-mapping.csv'}).click();
 await expect(preparer.page.getByRole('status')).toContainText('Available',{timeout:60000});
 await seedCompliance();
 // Readiness and a return run for October (INV-000001 of 5 October, 10,000 + 1,200).
 await preparer.page.goto('/compliance');await settled(preparer.page);
 await expect(preparer.page.getByRole('listitem').filter({hasText:'Regulatory profile'})).toContainText('ready');
 await expect(preparer.page.getByRole('listitem').filter({hasText:'Signing key'})).toContainText('ready');
 await expect(preparer.page.getByRole('row').filter({hasText:'2550Q'}).first()).toContainText('ready');
 await preparer.page.getByLabel('Form code').fill('2550Q');
 await preparer.page.getByLabel('Period start').fill('2026-10-01');await preparer.page.getByLabel('Period end').fill('2026-10-31');
 await preparer.page.getByRole('button',{name:'Create run'}).click();
 const runRow=page=>page.getByRole('row').filter({hasText:'2026-10-01 → 2026-10-31'});
 await expect(runRow(preparer.page).getByRole('cell',{name:'draft',exact:true})).toBeVisible();
 await runRow(preparer.page).getByRole('button',{name:'Prepare'}).click();
 await expect(runRow(preparer.page).getByRole('cell',{name:'prepared',exact:true})).toBeVisible();
 await runRow(preparer.page).getByRole('button',{name:'Lines'}).click();
 await expect(preparer.page.getByRole('row').filter({hasText:'12B'})).toContainText('₱1,200.00');
 await expect(preparer.page.getByRole('status').filter({hasText:'Tie-out'})).toContainText('ties');
 // The preparer holds the controller role since setup; the server still refuses the self-approval.
 await runRow(preparer.page).getByRole('button',{name:'Approve',exact:true}).click();
 await expect(preparer.page.locator('section[role="alert"]')).toContainText('cannot approve');
 await controller.page.goto('/compliance');await settled(controller.page);
 await runRow(controller.page).getByRole('button',{name:'Approve',exact:true}).click();
 await expect(runRow(controller.page).getByRole('cell',{name:'approved',exact:true})).toBeVisible();
 await preparer.page.reload();await settled(preparer.page);
 await runRow(preparer.page).getByLabel('Filing reference').fill('EFPS-2026-10-001');
 await runRow(preparer.page).getByRole('combobox',{name:'Acknowledgement evidence'}).selectOption({label:'registration.pdf'});
 await runRow(preparer.page).getByRole('button',{name:'Record filing'}).click();
 await expect(runRow(preparer.page).getByRole('cell',{name:'filed',exact:true})).toBeVisible();
 // A reporting-required issuance: the worker sends it with the fixture transport; the queue shows it accepted.
 await billing.page.goto('/sales/invoices');await settled(billing.page);
 await pickCustomer(billing.page);
 await billing.page.getByLabel('Document date').fill('2026-10-12');await billing.page.getByLabel('Accounting date').fill('2026-10-12');
 await billing.page.getByRole('textbox',{name:'Line 1 description'}).fill('Reported services');
 await billing.page.getByRole('textbox',{name:'Line 1 unit price'}).fill('2000');
 await billing.page.getByRole('combobox',{name:'Line 1 revenue account'}).selectOption({label:'4000 Service revenue'});
 await billing.page.getByRole('combobox',{name:'Line 1 tax rule'}).selectOption({label:'VAT12 12%'});
 await billing.page.getByRole('button',{name:'Save draft'}).click();
 await expect(billing.page).toHaveURL(/\/sales\/invoices\/[0-9a-f-]{36}$/);
 const reportedUrl=new URL(billing.page.url()).pathname;
 await billing.page.getByRole('button',{name:'Submit for approval'}).click();
 await expect(billing.page.locator('.status-grid dd').first()).toHaveText('submitted');
 await preparer.page.goto(reportedUrl);await settled(preparer.page);
 await preparer.page.getByRole('button',{name:'Approve',exact:true}).click();
 await expect(preparer.page.locator('.status-grid dd').first()).toHaveText('approved');
 await preparer.page.getByRole('button',{name:'Issue invoice'}).click();
 await expect(preparer.page.locator('.status-grid dd').nth(2)).toHaveText('queued',{timeout:30000});
 await expect.poll(async()=>{await preparer.page.reload();await settled(preparer.page);return preparer.page.locator('.status-grid dd').nth(2).textContent();},{timeout:90000}).toBe('accepted');
 await preparer.page.goto('/compliance');await settled(preparer.page);
 await expect(preparer.page.getByRole('row').filter({hasText:'INV-000002'})).toContainText('accepted');
 // Registration pack job.
 await preparer.page.getByRole('button',{name:'Generate pack'}).click();
 await expect(preparer.page.getByRole('status').filter({hasText:'Pack job'})).toContainText('succeeded',{timeout:60000});
 await noSeriousViolations(preparer.page,'compliance /compliance');
 await controller.context.close();await preparer.context.close();await billing.context.close();
});

// The institution profile, the source system, the reviewed mapping version,
// the feed calendar and the GRT rule have no reviewed operations or seeded
// template yet; the journey seeds them through the runtime role as an
// operator would. Ownership, staging, validation, approval, posting and every
// read go through the screens.
async function seedInstitution(){
 const pg=createRequire(new URL('../../packages/database/package.json',import.meta.url))('pg');
 const db=new pg.Client(connectionOptions(process.env.LARA_E2E_DATABASE_URL));await db.connect();
 try{
  const tenantId=(await db.query('select tenant_id from lara.principal_directory where oidc_subject=$1',[who('controller')])).rows[0].tenant_id;
  await db.query("select set_config('lara.tenant_id',$1,false)",[tenantId]);
  const entity=(await db.query('select id from lara.entities where tenant_id=$1 order by created_at limit 1',[tenantId])).rows[0].id;
  const principal=async role=>(await db.query('select principal_id from lara.principal_directory where oidc_subject=$1 and tenant_id=$2',[who(role),tenantId])).rows[0].principal_id;
  const acct=async code=>(await db.query('select id from lara.accounts where tenant_id=$1 and entity_id=$2 and code=$3',[tenantId,entity,code])).rows[0].id;
  const book=(await db.query("select id from lara.books where tenant_id=$1 and entity_id=$2 and kind='primary'",[tenantId,entity])).rows[0].id;
  const hash=(await db.query("select encode(sha256(convert_to($1,'utf8')),'hex') as h",[JSON.stringify({fi:1})])).rows[0].h;
  const payload={instrumentRules:[{incomeCategory:'interest_income',instrumentType:'loan',maxMaturityYears:5,ruleCode:'GRT5'}],profileVersion:'fi-2026'};
  const ph=(await db.query("select encode(sha256(convert_to($1,'utf8')),'hex') as h",[JSON.stringify(payload)])).rows[0].h;
  await db.query("insert into lara.settings_versions(tenant_id,entity_id,kind,version_number,payload,payload_hash,status,approved_by,effective_at,created_by) values($1,$2,'fi_profile',1,$3,$4,'approved',$5,now(),$6)",[tenantId,entity,JSON.stringify(payload),ph,await principal('preparer'),await principal('controller')]);
  const system=(await db.query("insert into lara.source_systems(tenant_id,entity_id,code,name,owner_name,granularity,created_by) values($1,$2,'CBS','Core banking','IT operations','detail',$3) returning id",[tenantId,entity,await principal('controller')])).rows[0].id;
  const mapping=(await db.query("select id,sha256 from lara.evidence where tenant_id=$1 and entity_id=$2 and filename='cbs-map.csv'",[tenantId,entity])).rows[0];
  const mv=(await db.query("insert into lara.mapping_versions(tenant_id,entity_id,source_system_id,version_label,evidence_id,hash,line_count,created_by) values($1,$2,$3,'cbs-2026-v1',$4,$5,2,$6) returning id",[tenantId,entity,system,mapping.id,mapping.sha256,await principal('preparer')])).rows[0].id;
  // Lines are written while the version is a draft; approval freezes them.
  for(const [src,code] of [['100100','1010'],['410100','4000']])await db.query("insert into lara.mapping_lines(tenant_id,entity_id,mapping_version_id,source_account,target_account_id,dimensions_json) values($1,$2,$3,$4,$5,'{}')",[tenantId,entity,mv,src,await acct(code)]);
  await db.query("update lara.mapping_versions set status='approved',approved_by=$2 where id=$1",[mv,await principal('controller')]);
  await db.query("insert into lara.expected_batches(tenant_id,entity_id,source_system_id,book_id,kind,period_start,period_end,deadline_at,created_by) values($1,$2,$3,$4,'journal','2026-10-01','2026-10-31','2026-09-15T00:00:00Z',$5)",[tenantId,entity,system,book,await principal('controller')]);
  const registration=(await db.query("select id from lara.evidence where tenant_id=$1 and entity_id=$2 and filename='registration.pdf'",[tenantId,entity])).rows[0].id;
  await db.query("insert into lara.tax_rule_versions(tenant_id,entity_id,code,version_number,tax_type,valid_from,rate,basis,recognition,rounding,applicability_profile_id,source_evidence_ids,golden_case_ids,content_hash,created_by,status,approved_by,activated_by,activated_at) values($1,$2,'GRT5',1,'grt','2026-01-01',0.05,'instrument','profile_event','line_half_up',gen_random_uuid(),$3,'[\"GRT-5Y\"]',$4,$5,'active',$6,$6,now())",[tenantId,entity,JSON.stringify([registration]),hash,await principal('preparer'),await principal('controller')]);
  // No seeded template holds source_ownership.create; a tenant role covers the institution officer duties.
  const role=(await db.query("insert into lara.roles(tenant_id,code,name,permissions,status,content_hash,created_by) values($1,'fi_officer','Institution officer','[\"source_ownership.create\",\"source_ownership.edit\",\"source_ownership.read\",\"import.create\",\"import.validate\",\"import.read\"]','approved',$2,$3) returning id",[tenantId,hash,await principal('security')])).rows[0].id;
  await db.query('insert into lara.memberships(tenant_id,principal_id,role_id,created_by) values($1,$2,$3,$4)',[tenantId,await principal('preparer'),role,await principal('security')]);
 }finally{await db.end();}
}
test('institution: capability activation, source ownership recorded from the signed matrix and approved, a canonical feed batch staged from CSV evidence, validated, approved and posted once with the calendar satisfied, the branch roll-up and the institution tax worksheet',async({browser})=>{
 test.setTimeout(480000);
 const controller=await as(browser,'controller'),preparer=await as(browser,'preparer');
 for(const who of [controller,preparer]){
  await who.page.goto('/settings/capabilities');await settled(who.page);
  const card=who.page.locator('section.demo-card').filter({hasText:'Financial institution coexistence'});
  await card.getByRole('combobox',{name:'Activation evidence'}).selectOption({label:'registration.pdf'});
  await card.getByLabel('Reason').fill(who===controller?'Pilot institution go-live requested':'Reviewed the signed feed matrix');
  await card.getByRole('button',{name:'Request or approve activation'}).click();
  await expect(who.page.locator('section[role="alert"]')).toHaveCount(0);
 }
 // The mapping and the feed enter as CSV evidence.
 const dataLines=['CBS-1,2026-10-15,MAIN,HQ,100100,PHP,2000.00,0,INT-9,,,,,,','CBS-2,2026-10-15,MAIN,HQ,410100,PHP,0,2000.00,INT-9,,,LN-9,loan,2029-10-15,interest_income'];
 const manifest=['MANIFEST','','','','count=2;sha256='+createHash('sha256').update(dataLines.join('\n')).digest('hex'),'','2000.00','2000.00','','','','','','',''].join(',');
 const feed=Buffer.from(['external_line_id,accounting_date,book_code,branch_code,account_code,currency,debit,credit,source_document_ref,dimensions,tax_event_ref,instrument_ref,instrument_type,maturity_date,income_category',...dataLines,manifest].join('\n')+'\n');
 const mapping=Buffer.from(['source_account,target_account_code,dimensions,tax_profile','100100,1010,,','410100,4000,,interest_income'].join('\n')+'\n');
 for(const [name,buffer] of [['cbs-map.csv',mapping],['CBS-20261015.csv',feed]]){
  await preparer.page.goto('/evidence');await settled(preparer.page);
  await preparer.page.locator('input[type="file"]').setInputFiles({name,mimeType:'text/csv',buffer});
  await preparer.page.getByRole('button',{name:'Upload evidence'}).click();
  await expect(preparer.page.getByRole('status').filter({hasText:'Queued for scanning'})).toBeVisible({timeout:30000});
  await preparer.page.getByRole('link',{name}).click();
  await expect(preparer.page.getByRole('status')).toContainText('Available',{timeout:60000});
 }
 await seedInstitution();
 // Ownership from the signed matrix: the preparer records, the controller approves.
 await preparer.page.goto('/institution/ownership');await settled(preparer.page);
 await expect(preparer.page.getByRole('cell',{name:'CBS',exact:true})).toBeVisible();
 await preparer.page.getByRole('combobox',{name:'Source system'}).selectOption({label:'CBS · Core banking'});
 await preparer.page.getByRole('combobox',{name:'Transaction family'}).selectOption('journal');
 await preparer.page.getByLabel('Effective from').fill('2026-01-01');
 await preparer.page.getByRole('combobox',{name:'Evidence (signed matrix)'}).selectOption({label:'registration.pdf'});
 await preparer.page.getByRole('button',{name:'Record ownership'}).click();
 const ownRow=page=>page.getByRole('row').filter({hasText:'journal'}).filter({hasText:'CBS'});
 await expect(ownRow(preparer.page).getByRole('cell',{name:'draft',exact:true})).toBeVisible();
 // The preparer holds the controller role since setup; the server refuses the self-approval.
 await ownRow(preparer.page).getByRole('button',{name:'Approve',exact:true}).click();
 await expect(preparer.page.locator('section[role="alert"]')).toContainText('cannot approve');
 await controller.page.goto('/institution/ownership');await settled(controller.page);
 await ownRow(controller.page).getByRole('button',{name:'Approve',exact:true}).click();
 await expect(ownRow(controller.page).getByRole('cell',{name:'approved',exact:true})).toBeVisible();
 // The feed: calendar shows the overdue expectation; the batch is staged, validated, approved and posted once.
 await preparer.page.goto('/institution/feeds');await settled(preparer.page);
 await expect(preparer.page.getByRole('row').filter({hasText:'2026-10-01 → 2026-10-31'})).toContainText('missing');
 await preparer.page.getByRole('combobox',{name:'Kind'}).selectOption('journal');
 await preparer.page.getByRole('combobox',{name:'Source system'}).selectOption({label:'CBS'});
 await preparer.page.getByRole('combobox',{name:'Feed CSV evidence'}).selectOption({label:'CBS-20261015.csv'});
 await preparer.page.getByRole('combobox',{name:'Mapping version'}).selectOption({label:'cbs-2026-v1'});
 await preparer.page.getByLabel('External batch id').fill('CBS-20261015');
 await preparer.page.getByLabel('Cutoff date').fill('2026-10-31');
 await preparer.page.getByRole('button',{name:'Stage batch'}).click();
 const batchRow=page=>page.getByRole('row').filter({hasText:'CBS-20261015'});
 await expect(batchRow(preparer.page).getByRole('cell',{name:'staged',exact:true})).toBeVisible();
 await batchRow(preparer.page).getByRole('button',{name:'Validate'}).click();
 await expect(batchRow(preparer.page).getByRole('cell',{name:'validated',exact:true})).toBeVisible();
 await batchRow(preparer.page).getByRole('button',{name:'Rows'}).click();
 await preparer.page.getByLabel('Only rows with errors').uncheck();
 await expect(preparer.page.getByRole('row').filter({has:preparer.page.getByRole('cell',{name:'CBS-2',exact:true})})).toContainText('valid',{timeout:20000});
 await controller.page.goto('/institution/feeds');await settled(controller.page);
 await batchRow(controller.page).getByRole('button',{name:'Approve',exact:true}).click();
 await expect(batchRow(controller.page).getByRole('cell',{name:'approved',exact:true})).toBeVisible();
 await batchRow(controller.page).getByRole('button',{name:'Post',exact:true}).click();
 await expect(batchRow(controller.page).getByRole('cell',{name:'posted',exact:true})).toBeVisible();
 await expect(controller.page.getByRole('row').filter({hasText:'2026-10-01 → 2026-10-31'})).toContainText('received');
 // Branch roll-up and the worksheet.
 await controller.page.goto('/institution/branches');await settled(controller.page);
 await controller.page.getByRole('textbox',{name:'From',exact:true}).fill('2026-10-01');await controller.page.getByRole('textbox',{name:'To',exact:true}).fill('2026-10-31');
 await expect(controller.page.getByRole('row').filter({has:controller.page.getByRole('cell',{name:'HQ',exact:true})}).first()).toBeVisible();
 await expect(controller.page.getByRole('status').filter({hasText:'Entity roll-up'})).toContainText('interbranch pairs cancel');
 await expect(controller.page.getByText('Every expected batch up to the cutoff was received.')).toBeVisible();
 await preparer.page.goto('/institution/tax');await settled(preparer.page);
 await preparer.page.getByRole('textbox',{name:'From',exact:true}).fill('2026-10-01');await preparer.page.getByRole('textbox',{name:'To',exact:true}).fill('2026-10-31');
 await expect(preparer.page.getByRole('row').filter({hasText:'GRT5'})).toContainText('₱100.00');
 await expect(preparer.page.getByText('Every fact in the period is classified.')).toBeVisible();
 for(const route of ['/institution/ownership','/institution/feeds','/institution/branches','/institution/tax']){await controller.page.goto(route);await settled(controller.page);await noSeriousViolations(controller.page,'institution '+route);}
 await controller.context.close();await preparer.context.close();
});
// The FX profile, the FX accounts, the zero-rated rule, the FX desk and
// approver roles and the view links have no reviewed operations or seeded
// template yet; the journey seeds them through the runtime role as an
// operator would. Rates, documents, receipts, revaluations, books and the
// combined view go through the screens.
async function seedFx(){
 const pg=createRequire(new URL('../../packages/database/package.json',import.meta.url))('pg');
 const db=new pg.Client(connectionOptions(process.env.LARA_E2E_DATABASE_URL));await db.connect();
 try{
  const tenantId=(await db.query('select tenant_id from lara.principal_directory where oidc_subject=$1',[who('controller')])).rows[0].tenant_id;
  await db.query("select set_config('lara.tenant_id',$1,false)",[tenantId]);
  const entity=(await db.query('select id from lara.entities where tenant_id=$1 order by created_at limit 1',[tenantId])).rows[0].id;
  const principal=async role=>(await db.query('select principal_id from lara.principal_directory where oidc_subject=$1 and tenant_id=$2',[who(role),tenantId])).rows[0].principal_id;
  const book=(await db.query("select id from lara.books where tenant_id=$1 and entity_id=$2 and kind='primary'",[tenantId,entity])).rows[0].id;
  const hash=(await db.query("select encode(sha256(convert_to($1,'utf8')),'hex') as h",[JSON.stringify({fx:1})])).rows[0].h;
  const acct=async(code,name,category,side)=>(await db.query("insert into lara.accounts(tenant_id,entity_id,book_id,code,name,category,normal_side,control_type,allow_manual,content_hash,created_by) values($1,$2,$3,$4,$5,$6,$7,'none',true,$8,$9) on conflict (tenant_id,entity_id,book_id,code) do update set name=excluded.name returning id",[tenantId,entity,book,code,name,category,side,hash,await principal('preparer')])).rows[0].id;
  const ar=(await db.query("select id from lara.accounts where tenant_id=$1 and entity_id=$2 and book_id=$3 and code='1200'",[tenantId,entity,book])).rows[0].id;
  const payload={realizedGainAccountId:await acct('7100','Realized FX gain','income','credit'),realizedLossAccountId:await acct('7200','Realized FX loss','expense','debit'),unrealizedGainAccountId:await acct('7300','Unrealized FX gain','income','credit'),unrealizedLossAccountId:await acct('7400','Unrealized FX loss','expense','debit'),monetaryAccountIds:[ar],profileVersion:'fx-2026'};
  const ph=(await db.query("select encode(sha256(convert_to($1,'utf8')),'hex') as h",[JSON.stringify(payload)])).rows[0].h;
  await db.query("insert into lara.settings_versions(tenant_id,entity_id,kind,version_number,payload,payload_hash,status,approved_by,effective_at,created_by) values($1,$2,'fx_profile',1,$3,$4,'approved',$5,now(),$6)",[tenantId,entity,JSON.stringify(payload),ph,await principal('preparer'),await principal('controller')]);
  const registration=(await db.query("select id from lara.evidence where tenant_id=$1 and entity_id=$2 and filename='registration.pdf'",[tenantId,entity])).rows[0].id;
  await db.query("insert into lara.tax_rule_versions(tenant_id,entity_id,code,version_number,tax_type,valid_from,rate,basis,recognition,rounding,applicability_profile_id,source_evidence_ids,golden_case_ids,content_hash,created_by,status,approved_by,activated_by,activated_at) values($1,$2,'ZERO',1,'vat','2026-01-01',0,'net','issue','line_half_up',gen_random_uuid(),$3,'[\"AC-10\"]',$4,$5,'active',$6,$6,now())",[tenantId,entity,JSON.stringify([registration]),hash,await principal('preparer'),await principal('controller')]);
  // No seeded template holds fx_rate.create/edit or the revaluation permissions; tenant roles cover the FX desk and the approver.
  const role=async(code,perms)=>(await db.query("insert into lara.roles(tenant_id,code,name,permissions,status,content_hash,created_by) values($1,$2,$2,$3,'approved',$4,$5) returning id",[tenantId,code,JSON.stringify(perms),hash,await principal('security')])).rows[0].id;
  const desk=await role('fx_desk',['fx_rate.create','fx_rate.edit','fx_rate.read','revaluation.create','revaluation.edit','revaluation.preview','revaluation.read']);
  const approver=await role('fx_approver',['revaluation.approve','revaluation.post','revaluation.read']);
  await db.query('insert into lara.memberships(tenant_id,principal_id,role_id,created_by) values($1,$2,$3,$4),($1,$5,$6,$4)',[tenantId,await principal('preparer'),desk,await principal('security'),await principal('controller'),approver]);
 }finally{await db.end();}
}
async function seedViewLinks(){
 const pg=createRequire(new URL('../../packages/database/package.json',import.meta.url))('pg');
 const db=new pg.Client(connectionOptions(process.env.LARA_E2E_DATABASE_URL));await db.connect();
 try{
  const tenantId=(await db.query('select tenant_id from lara.principal_directory where oidc_subject=$1',[who('controller')])).rows[0].tenant_id;
  await db.query("select set_config('lara.tenant_id',$1,false)",[tenantId]);
  const entity=(await db.query('select id from lara.entities where tenant_id=$1 order by created_at limit 1',[tenantId])).rows[0].id;
  const controller=(await db.query('select principal_id from lara.principal_directory where oidc_subject=$1 and tenant_id=$2',[who('controller'),tenantId])).rows[0].principal_id;
  const bookOf=async code=>(await db.query('select id from lara.books where tenant_id=$1 and entity_id=$2 and code=$3',[tenantId,entity,code])).rows[0].id;
  await db.query("insert into lara.book_links(tenant_id,entity_id,source_book_id,target_view_id,translation_policy,created_by) values($1,$2,$3,$4,'as_is',$5),($1,$2,$6,$4,'closing_rate',$5)",[tenantId,entity,await bookOf('MAIN'),await bookOf('MGMT'),controller,await bookOf('FCDU')]);
 }finally{await db.end();}
}
test('multi-currency: capability activation, a rate imported and approved independently, a USD invoice posting both amounts, a receipt at another rate realizing FX on screen, a revaluation previewed, approved and posted once, and partitions with the combined view',async({browser})=>{
 test.setTimeout(480000);
 const controller=await as(browser,'controller'),preparer=await as(browser,'preparer'),billing=await as(browser,'billing');
 for(const who of [controller,preparer]){
  await who.page.goto('/settings/capabilities');await settled(who.page);
  const card=who.page.locator('section.demo-card').filter({hasText:'Multiple currencies and separate books'});
  await card.getByRole('combobox',{name:'Activation evidence'}).selectOption({label:'registration.pdf'});
  await card.getByLabel('Reason').fill(who===controller?'Export customers invoice in USD':'Reviewed the monetary classification');
  await card.getByRole('button',{name:'Request or approve activation'}).click();
  await expect(who.page.locator('section[role="alert"]')).toHaveCount(0);
 }
 await seedFx();
 // Rates: the desk drafts, the controller approves; the self-approval is refused.
 const importRate=async(date,value)=>{await preparer.page.goto('/fx/rates');await settled(preparer.page);await preparer.page.getByRole('combobox',{name:'Foreign currency (base)'}).selectOption('USD');await preparer.page.getByRole('combobox',{name:'Functional currency (quote)'}).selectOption('PHP');await preparer.page.getByLabel('Rate date').fill(date);await preparer.page.getByLabel('Rate',{exact:true}).fill(value);await preparer.page.getByRole('combobox',{name:'Source evidence'}).selectOption({label:'registration.pdf'});await preparer.page.getByRole('button',{name:'Save draft rate'}).click();const row=preparer.page.getByRole('row').filter({hasText:date});await expect(row.getByRole('cell',{name:'draft',exact:true})).toBeVisible();};
 await importRate('2026-10-20','56');
 await preparer.page.getByRole('row').filter({hasText:'2026-10-20'}).getByRole('button',{name:'Approve',exact:true}).click();
 await expect(preparer.page.locator('section[role="alert"]')).toContainText('cannot approve');
 await importRate('2026-10-25','57');await importRate('2026-10-31','58');
 await controller.page.goto('/fx/rates');await settled(controller.page);
 for(const date of ['2026-10-20','2026-10-25','2026-10-31']){const row=controller.page.getByRole('row').filter({hasText:date});await row.getByRole('button',{name:'Approve',exact:true}).click();await expect(row.getByRole('cell',{name:'approved',exact:true})).toBeVisible();}
 // A USD invoice of 100 at 56 and a second unpaid one of 50; both amounts post.
 const issueUsd=async(price)=>{await billing.page.goto('/sales/invoices');await settled(billing.page);await pickCustomer(billing.page);await billing.page.getByRole('combobox',{name:'Currency'}).selectOption('USD');await billing.page.getByLabel('Document date').fill('2026-10-20');await billing.page.getByLabel('Accounting date').fill('2026-10-20');await billing.page.getByRole('textbox',{name:'Line 1 description'}).fill('Export services');await billing.page.getByRole('textbox',{name:'Line 1 unit price'}).fill(price);await billing.page.getByRole('combobox',{name:'Line 1 revenue account'}).selectOption({label:'4000 Service revenue'});await billing.page.getByRole('combobox',{name:'Line 1 tax rule'}).selectOption({label:'ZERO 0%'});await billing.page.getByRole('button',{name:'Save draft'}).click();await expect(billing.page).toHaveURL(/\/sales\/invoices\/[0-9a-f-]{36}$/);const url=new URL(billing.page.url()).pathname;await billing.page.getByRole('button',{name:'Submit for approval'}).click();await expect(billing.page.locator('.status-grid dd').first()).toHaveText('submitted');await preparer.page.goto(url);await settled(preparer.page);await preparer.page.getByRole('button',{name:'Approve',exact:true}).click();await expect(preparer.page.locator('.status-grid dd').first()).toHaveText('approved');await preparer.page.getByRole('button',{name:'Issue invoice'}).click();await expect(preparer.page.locator('.status-grid dd').first()).toHaveText('posted',{timeout:30000});return url;};
 const usdInvoice=await issueUsd('100');
 await expect(preparer.page.getByRole('status').filter({hasText:'functional carrying'})).toContainText('₱5,600.00');
 await issueUsd('50');
 // Receipt of USD 100 at 57 allocated to the first invoice: the realized gain shows on the invoice.
 await billing.page.goto('/sales/collections');await settled(billing.page);
 await pickCustomer(billing.page);
 await billing.page.getByRole('combobox',{name:'Currency'}).selectOption('USD');
 await billing.page.getByLabel('Value date',{exact:true}).fill('2026-10-25');
 await billing.page.getByLabel('Gross received').fill('100');await billing.page.getByLabel('Cash amount').fill('100');
 await billing.page.getByLabel('Allocate to item due 2026-11-19').first().fill('100');
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
 await expect(preparer.page.getByText('State posted',{exact:false})).toBeVisible({timeout:30000});
 await preparer.page.goto(usdInvoice);await settled(preparer.page);
 await expect(preparer.page.locator('.status-grid dd').nth(3)).toHaveText('paid');
 await expect(preparer.page.getByRole('row').filter({hasText:'settle'})).toContainText('₱100.00');
 // Revaluation of receivables at the 58 closing rate: preview, independent approval, one posting.
 await preparer.page.goto('/fx/revaluations');await settled(preparer.page);
 const pickOption=async(box,text)=>{await expect(box.locator('option',{hasText:text})).toHaveCount(1);await box.selectOption(await box.locator('option',{hasText:text}).getAttribute('value'));};
 await pickOption(preparer.page.getByRole('combobox',{name:'Period'}),'2026-10-01 → 2026-10-31');
 await pickOption(preparer.page.getByRole('combobox',{name:'Closing rate set'}),'58 on 2026-10-31');
 await preparer.page.getByLabel('1200 Receivables').check();
 await preparer.page.getByRole('button',{name:'Create run'}).click();
 const runRow=page=>page.getByRole('row').filter({hasText:'USD/PHP 58'});
 await expect(runRow(preparer.page).getByRole('cell',{name:'draft',exact:true})).toBeVisible();
 await runRow(preparer.page).getByRole('button',{name:'Compute preview'}).click();
 await expect(runRow(preparer.page).getByRole('cell',{name:'previewed',exact:true})).toBeVisible();
 await runRow(preparer.page).getByRole('button',{name:'Preview',exact:true}).click();
 await expect(preparer.page.getByRole('row').filter({hasText:'1200 Receivables'})).toContainText('₱100.00');
 await controller.page.goto('/fx/revaluations');await settled(controller.page);
 await runRow(controller.page).getByRole('button',{name:'Approve',exact:true}).click();
 await expect(runRow(controller.page).getByRole('cell',{name:'approved',exact:true})).toBeVisible();
 await runRow(controller.page).getByRole('button',{name:'Post',exact:true}).click();
 await expect(runRow(controller.page).getByRole('cell',{name:'posted',exact:true})).toBeVisible({timeout:30000});
 // Partitions: the controller creates an FCDU book and a management view; the preparer activates them; the combined view labels its basis.
 await controller.page.goto('/books');await settled(controller.page);
 const createBook=async(code,kind,currency)=>{await controller.page.getByLabel('Code',{exact:true}).fill(code);await controller.page.getByRole('combobox',{name:'Kind'}).selectOption(kind);await controller.page.getByRole('combobox',{name:'Functional currency'}).selectOption(currency);await controller.page.getByRole('button',{name:'Create book'}).click();await expect(controller.page.getByRole('row').filter({hasText:code}).getByRole('cell',{name:'draft',exact:true})).toBeVisible();};
 await createBook('FCDU','fcdu','USD');await createBook('MGMT','management','PHP');
 await preparer.page.goto('/books');await settled(preparer.page);
 for(const code of ['FCDU','MGMT']){const row=preparer.page.getByRole('row').filter({hasText:code});await row.getByLabel('Reason').fill('Licence on file');await row.getByRole('button',{name:'Activate'}).click();await expect(row.getByRole('cell',{name:'active',exact:true})).toBeVisible();}
 await seedViewLinks();
 await controller.page.goto('/books');await settled(controller.page);
 await controller.page.getByRole('combobox',{name:'View'}).selectOption({label:'MGMT'});
 await controller.page.getByLabel('As of').fill('2026-10-31');
 await expect(controller.page.getByRole('status').filter({hasText:'Basis:'})).toContainText('each source book counted once');
 await expect(controller.page.locator('h3').filter({hasText:'MAIN · primary · PHP'})).toBeVisible();
 await expect(controller.page.locator('h3').filter({hasText:'FCDU · fcdu · USD at 58'})).toBeVisible();
 for(const route of ['/fx/rates','/fx/revaluations','/books']){await controller.page.goto(route);await settled(controller.page);await noSeriousViolations(controller.page,'fx '+route);}
 await controller.context.close();await preparer.context.close();await billing.context.close();
});
// The inventory profile, the stock accounts, the warehouse and the stock
// clerk and approver roles have no reviewed operations or seeded template
// yet; the journey seeds them through the runtime role as an operator would.
// Items, movements, the stock card, the count and the reconciliation go
// through the screens.
async function seedInventory(){
 const pg=createRequire(new URL('../../packages/database/package.json',import.meta.url))('pg');
 const db=new pg.Client(connectionOptions(process.env.LARA_E2E_DATABASE_URL));await db.connect();
 try{
  const tenantId=(await db.query('select tenant_id from lara.principal_directory where oidc_subject=$1',[who('controller')])).rows[0].tenant_id;
  await db.query("select set_config('lara.tenant_id',$1,false)",[tenantId]);
  const entity=(await db.query('select id from lara.entities where tenant_id=$1 order by created_at limit 1',[tenantId])).rows[0].id;
  const principal=async role=>(await db.query('select principal_id from lara.principal_directory where oidc_subject=$1 and tenant_id=$2',[who(role),tenantId])).rows[0].principal_id;
  const book=(await db.query("select id from lara.books where tenant_id=$1 and entity_id=$2 and kind='primary'",[tenantId,entity])).rows[0].id;
  const branch=(await db.query("select id from lara.branches where tenant_id=$1 and entity_id=$2 and code='HQ'",[tenantId,entity])).rows[0].id;
  const hash=(await db.query("select encode(sha256(convert_to($1,'utf8')),'hex') as h",[JSON.stringify({inv:1})])).rows[0].h;
  const acct=async(code,name,category,side)=>(await db.query("insert into lara.accounts(tenant_id,entity_id,book_id,code,name,category,normal_side,control_type,allow_manual,content_hash,created_by) values($1,$2,$3,$4,$5,$6,$7,'none',true,$8,$9) on conflict (tenant_id,entity_id,book_id,code) do update set name=excluded.name returning id",[tenantId,entity,book,code,name,category,side,hash,await principal('preparer')])).rows[0].id;
  await acct('1500','Inventory','asset','debit');await acct('5100','Cost of sales','expense','debit');
  const payload={grniAccountId:await acct('2150','Goods received not invoiced','liability','credit'),stockGainAccountId:await acct('4200','Stock gain','income','credit'),stockLossAccountId:await acct('5200','Stock loss','expense','debit'),landedCostClearingAccountId:await acct('5300','Freight in','expense','debit'),threeWayTolerancePercent:'2',profileVersion:'inventory-2026'};
  const ph=(await db.query("select encode(sha256(convert_to($1,'utf8')),'hex') as h",[JSON.stringify(payload)])).rows[0].h;
  await db.query("insert into lara.settings_versions(tenant_id,entity_id,kind,version_number,payload,payload_hash,status,approved_by,effective_at,created_by) values($1,$2,'inventory_profile',1,$3,$4,'approved',$5,now(),$6)",[tenantId,entity,JSON.stringify(payload),ph,await principal('preparer'),await principal('controller')]);
  await db.query("insert into lara.warehouses(tenant_id,entity_id,branch_id,code,name,created_by) values($1,$2,$3,'WH1','Main warehouse',$4)",[tenantId,entity,branch,await principal('controller')]);
  // No seeded template holds the inventory permissions; tenant roles cover the stock clerk and the approver.
  const role=async(code,perms)=>(await db.query("insert into lara.roles(tenant_id,code,name,permissions,status,content_hash,created_by) values($1,$2,$2,$3,'approved',$4,$5) returning id",[tenantId,code,JSON.stringify(perms),hash,await principal('security')])).rows[0].id;
  const clerkRole=await role('stock_clerk',['item.create','item.edit','item.read','stock_movement.create','stock_movement.edit','stock_movement.submit','stock_movement.read','stock_count.create','stock_count.edit','stock_count.read','landed_cost.create','landed_cost.edit','landed_cost.preview','landed_cost.read']);
  const approverRole=await role('inventory_approver',['stock_movement.approve','stock_movement.post','stock_movement.read','stock_count.approve','stock_count.post','stock_count.read','landed_cost.approve','landed_cost.post','landed_cost.read','item.read']);
  await db.query('insert into lara.memberships(tenant_id,principal_id,role_id,created_by) values($1,$2,$3,$4),($1,$5,$6,$4)',[tenantId,await principal('preparer'),clerkRole,await principal('security'),await principal('controller'),approverRole]);
 }finally{await db.end();}
}
test('inventory: capability activation, an item with its cost method, a goods receipt and a FIFO issue through submission, independent approval and posting, the stock card and the stock-to-ledger tie, and a count with its variance posted',async({browser})=>{
 test.setTimeout(480000);
 const controller=await as(browser,'controller'),preparer=await as(browser,'preparer');
 for(const who of [controller,preparer]){
  await who.page.goto('/settings/capabilities');await settled(who.page);
  const card=who.page.locator('section.demo-card').filter({hasText:'Inventory costing and three-way matching'});
  await card.getByRole('combobox',{name:'Activation evidence'}).selectOption({label:'registration.pdf'});
  await card.getByLabel('Reason').fill(who===controller?'Trading goods from October':'Reviewed the costing method and cutoff');
  await card.getByRole('button',{name:'Request or approve activation'}).click();
  await expect(who.page.locator('section[role="alert"]')).toHaveCount(0);
 }
 await seedInventory();
 // The item.
 await preparer.page.goto('/inventory');await settled(preparer.page);
 await preparer.page.getByRole('textbox',{name:'SKU',exact:true}).fill('WIDGET');await preparer.page.getByRole('textbox',{name:'Description',exact:true}).fill('Widget');
 await preparer.page.getByRole('combobox',{name:'Cost method'}).selectOption('fifo');
 await preparer.page.getByRole('combobox',{name:'Stock account'}).selectOption({label:'1500 Inventory'});
 await preparer.page.getByRole('combobox',{name:'Cost of sales account'}).selectOption({label:'5100 Cost of sales'});
 await preparer.page.getByRole('button',{name:'Create item'}).click();
 await expect(preparer.page.getByRole('cell',{name:'WIDGET',exact:true})).toBeVisible();
 // A receipt of 10 at 30 and an issue of 4: the clerk drafts and submits, the controller approves and posts.
 const movement=async(kind,quantity,unitCost)=>{
  await preparer.page.goto('/inventory/movements');await settled(preparer.page);
  await preparer.page.getByRole('combobox',{name:'Kind'}).selectOption(kind);
  await preparer.page.getByRole('combobox',{name:'Warehouse'}).selectOption({label:'WH1 Main warehouse'});
  await preparer.page.getByRole('textbox',{name:'Accounting date',exact:true}).fill('2026-10-20');
  await preparer.page.getByRole('combobox',{name:'Line 1 item'}).selectOption({label:'WIDGET Widget'});
  await preparer.page.getByRole('textbox',{name:'Line 1 quantity'}).fill(quantity);
  if(unitCost)await preparer.page.getByRole('textbox',{name:'Line 1 unit cost'}).fill(unitCost);
  await preparer.page.getByRole('button',{name:'Save draft'}).click();
  const row=page=>page.getByRole('row').filter({has:page.getByRole('cell',{name:kind==='receipt'?'receipt':'issue',exact:true})}).last();
  await expect(row(preparer.page).getByRole('cell',{name:'draft',exact:true})).toBeVisible();
  await row(preparer.page).getByRole('button',{name:'Submit'}).click();
  await expect(row(preparer.page).getByRole('cell',{name:'submitted',exact:true})).toBeVisible();
  await controller.page.goto('/inventory/movements');await settled(controller.page);
  await row(controller.page).getByRole('button',{name:'Approve',exact:true}).click();
  await expect(row(controller.page).getByRole('cell',{name:'approved',exact:true})).toBeVisible();
  await row(controller.page).getByRole('button',{name:'Post',exact:true}).click();
  await expect(row(controller.page).getByRole('cell',{name:'posted',exact:true})).toBeVisible({timeout:30000});
 };
 await movement('receipt','10','30');
 await movement('issue','4',null);
 // The stock card and the tie to the ledger.
 await controller.page.goto('/inventory');await settled(controller.page);
 await controller.page.getByRole('row').filter({hasText:'WIDGET'}).getByRole('button',{name:'Open'}).click();
 await expect(controller.page.getByRole('row').filter({has:controller.page.getByRole('cell',{name:'WH1',exact:true})}).first()).toContainText('₱180.00');
 await controller.page.getByRole('textbox',{name:'As of',exact:true}).fill('2026-10-31');
 await expect(controller.page.getByRole('row').filter({hasText:'1500'}).first()).toContainText('ties');
 // A count observing 5 against the expected 6 posts the loss after approval.
 await preparer.page.goto('/inventory/counts');await settled(preparer.page);
 await preparer.page.getByRole('combobox',{name:'Warehouse'}).selectOption({label:'WH1 Main warehouse'});
 await preparer.page.getByRole('textbox',{name:'Cutoff date',exact:true}).fill('2026-10-25');
 await preparer.page.getByRole('combobox',{name:'Count line 1 item'}).selectOption({label:'WIDGET'});
 await preparer.page.getByRole('textbox',{name:'Count line 1 observed quantity'}).fill('5');
 await preparer.page.getByRole('button',{name:'Save count'}).click();
 const countRow=page=>page.getByRole('row').filter({hasText:'WH1'}).last();
 await expect(countRow(preparer.page).getByRole('cell',{name:'draft',exact:true})).toBeVisible();
 await countRow(preparer.page).getByRole('button',{name:'Lines'}).click();
 await expect(preparer.page.getByRole('row').filter({has:preparer.page.getByRole('cell',{name:'WIDGET',exact:true})})).toContainText('-1');
 await controller.page.goto('/inventory/counts');await settled(controller.page);
 await countRow(controller.page).getByRole('button',{name:'Approve',exact:true}).click();
 await expect(countRow(controller.page).getByRole('cell',{name:'approved',exact:true})).toBeVisible();
 await countRow(controller.page).getByRole('button',{name:'Post variances'}).click();
 await expect(countRow(controller.page).getByRole('cell',{name:'posted',exact:true})).toBeVisible({timeout:30000});
 await controller.page.goto('/inventory');await settled(controller.page);
 await controller.page.getByRole('textbox',{name:'As of',exact:true}).fill('2026-10-31');
 await expect(controller.page.getByRole('row').filter({hasText:'1500'}).first()).toContainText('₱150.00');
 for(const route of ['/inventory','/inventory/movements','/inventory/counts','/inventory/landed-costs']){await controller.page.goto(route);await settled(controller.page);await noSeriousViolations(controller.page,'inventory '+route);}
 await controller.context.close();await preparer.context.close();
});
// The asset profile, the register accounts, the class, the recognition
// policy and the asset clerk and approver roles have no reviewed operations
// or seeded template yet; the journey seeds them through the runtime role as
// an operator would. The bill posted by the purchasing journey (BILL-000001,
// 10,000 on 5000 Professional fees) stands as the capitalization source, so
// that line's account is the asset clearing account of this profile.
async function seedAssets(){
 const pg=createRequire(new URL('../../packages/database/package.json',import.meta.url))('pg');
 const db=new pg.Client(connectionOptions(process.env.LARA_E2E_DATABASE_URL));await db.connect();
 try{
  const tenantId=(await db.query('select tenant_id from lara.principal_directory where oidc_subject=$1',[who('controller')])).rows[0].tenant_id;
  await db.query("select set_config('lara.tenant_id',$1,false)",[tenantId]);
  const entity=(await db.query('select id from lara.entities where tenant_id=$1 order by created_at limit 1',[tenantId])).rows[0].id;
  const principal=async role=>(await db.query('select principal_id from lara.principal_directory where oidc_subject=$1 and tenant_id=$2',[who(role),tenantId])).rows[0].principal_id;
  const book=(await db.query("select id from lara.books where tenant_id=$1 and entity_id=$2 and kind='primary'",[tenantId,entity])).rows[0].id;
  const hash=(await db.query("select encode(sha256(convert_to($1,'utf8')),'hex') as h",[JSON.stringify({ast:1})])).rows[0].h;
  const acct=async(code,name,category,side)=>(await db.query("insert into lara.accounts(tenant_id,entity_id,book_id,code,name,category,normal_side,control_type,allow_manual,content_hash,created_by) values($1,$2,$3,$4,$5,$6,$7,'none',true,$8,$9) on conflict (tenant_id,entity_id,book_id,code) do update set name=excluded.name returning id",[tenantId,entity,book,code,name,category,side,hash,await principal('preparer')])).rows[0].id;
  const existing=async code=>(await db.query('select id from lara.accounts where tenant_id=$1 and entity_id=$2 and code=$3',[tenantId,entity,code])).rows[0].id;
  const equip=await acct('1700','Equipment','asset','debit'),accDep=await acct('1710','Accumulated depreciation','asset','debit'),depExp=await acct('6100','Depreciation expense','expense','debit'),gain=await acct('4300','Gain on disposal','income','credit'),loss=await acct('6300','Loss on disposal','expense','debit');
  const settle=async(kind,payload)=>{const ph=(await db.query("select encode(sha256(convert_to($1,'utf8')),'hex') as h",[JSON.stringify(payload)])).rows[0].h;await db.query("insert into lara.settings_versions(tenant_id,entity_id,kind,version_number,payload,payload_hash,status,approved_by,effective_at,created_by) values($1,$2,$3,1,$4,$5,'approved',$6,now(),$7)",[tenantId,entity,kind,JSON.stringify(payload),ph,await principal('preparer'),await principal('controller')]);};
  await settle('asset_profile',{assetClearingAccountId:await existing('5000'),disposalClearingAccountId:await existing('1010'),profileVersion:'assets-2026'});
  await settle('recognition_policy_dep_monthly',{code:'dep_monthly',kind:'depreciation',proration:'monthly'});
  await db.query("insert into lara.asset_classes(tenant_id,entity_id,book_id,code,name,asset_account_id,accumulated_depreciation_account_id,depreciation_expense_account_id,disposal_gain_account_id,disposal_loss_account_id,default_method,default_useful_life_months,tax_method,tax_useful_life_months,created_by) values($1,$2,$3,'EQUIP','Equipment',$4,$5,$6,$7,$8,'straight_line',60,'declining_balance',36,$9)",[tenantId,entity,book,equip,accDep,depExp,gain,loss,await principal('controller')]);
  // No seeded template holds the asset or schedule authorities; tenant roles cover the clerk and the approver.
  const role=async(code,perms)=>(await db.query("insert into lara.roles(tenant_id,code,name,permissions,status,content_hash,created_by) values($1,$2,$2,$3,'approved',$4,$5) returning id",[tenantId,code,JSON.stringify(perms),hash,await principal('security')])).rows[0].id;
  const clerkRole=await role('asset_clerk',['asset.create','asset.edit','asset.read','schedule.create','schedule.edit','schedule.read']);
  const approverRole=await role('asset_approver',['asset.approve','asset.events','asset.read','schedule.approve','schedule.pause','schedule.execute','schedule.read']);
  await db.query('insert into lara.memberships(tenant_id,principal_id,role_id,created_by) values($1,$2,$3,$4),($1,$5,$6,$4)',[tenantId,await principal('preparer'),clerkRole,await principal('security'),await principal('controller'),approverRole]);
 }finally{await db.end();}
}
test('assets: capability activation, an asset drafted from the posted bill and capitalized by independent approval, the depreciation schedule previewed, approved and run by the worker for the open period, the book/tax comparison and a lifecycle event',async({browser})=>{
 test.setTimeout(480000);
 const controller=await as(browser,'controller'),preparer=await as(browser,'preparer');
 const pickOption=async(box,text)=>{await expect(box.locator('option',{hasText:text})).toHaveCount(1);await box.selectOption(await box.locator('option',{hasText:text}).getAttribute('value'));};
 for(const who of [controller,preparer]){
  await who.page.goto('/settings/capabilities');await settled(who.page);
  const card=who.page.locator('section.demo-card').filter({hasText:'Assets, recurring work and recognition schedules'});
  await card.getByRole('combobox',{name:'Activation evidence'}).selectOption({label:'registration.pdf'});
  await card.getByLabel('Reason').fill(who===controller?'Register goes live in October':'Reviewed the classes and the opening register');
  await card.getByRole('button',{name:'Request or approve activation'}).click();
  await expect(who.page.locator('section[role="alert"]')).toHaveCount(0);
 }
 await seedAssets();
 // The clerk drafts the asset from the posted bill; the controller approves and the capitalization posts.
 await preparer.page.goto('/assets');await settled(preparer.page);
 await preparer.page.getByRole('textbox',{name:'Tag',exact:true}).fill('MACH-1');
 await preparer.page.getByRole('combobox',{name:'Class',exact:true}).selectOption({label:'EQUIP Equipment'});
 await preparer.page.getByRole('textbox',{name:'Cost',exact:true}).fill('10000');
 await preparer.page.getByRole('textbox',{name:'In-service date',exact:true}).fill('2026-10-01');
 await pickOption(preparer.page.getByRole('combobox',{name:'Source bill'}),/BILL-000001/);
 await preparer.page.getByRole('button',{name:'Create asset'}).click();
 const assetRow=page=>page.getByRole('row').filter({has:page.getByRole('cell',{name:'MACH-1',exact:true})});
 await expect(assetRow(preparer.page).getByRole('cell',{name:'draft',exact:true})).toBeVisible();
 await expect(assetRow(preparer.page).getByRole('button',{name:'Approve',exact:true})).toHaveCount(0);
 await controller.page.goto('/assets');await settled(controller.page);
 await assetRow(controller.page).getByRole('button',{name:'Approve',exact:true}).click();
 await expect(assetRow(controller.page).getByRole('cell',{name:'approved',exact:true})).toBeVisible({timeout:30000});
 await assetRow(controller.page).getByRole('button',{name:'Open',exact:true}).click();
 await expect(controller.page.getByText('carrying amount',{exact:false})).toContainText('₱10,000.00');
 await expect(controller.page.getByText('capitalization entry',{exact:false})).toBeVisible();
 // The schedule: previewed by the clerk (60 × 166.67), approved by the controller, run for October by the worker.
 await preparer.page.goto('/assets/schedules');await settled(preparer.page);
 await pickOption(preparer.page.getByRole('combobox',{name:'Asset',exact:true}),/MACH-1/);
 await preparer.page.getByRole('textbox',{name:'Start date',exact:true}).fill('2026-10-01');
 await preparer.page.getByRole('textbox',{name:'End date',exact:true}).fill('2031-09-30');
 await preparer.page.getByRole('textbox',{name:'Basis amount',exact:true}).fill('10000');
 await preparer.page.getByRole('textbox',{name:'Policy code',exact:true}).fill('dep_monthly');
 await preparer.page.getByRole('button',{name:'Create schedule'}).click();
 const schedRow=page=>page.getByRole('row').filter({has:page.getByRole('cell',{name:'depreciation',exact:true})}).last();
 await expect(schedRow(preparer.page).getByRole('cell',{name:'draft',exact:true})).toBeVisible({timeout:30000});
 await schedRow(preparer.page).getByRole('button',{name:'Lines'}).click();
 await expect(preparer.page.getByText('planned ₱10,000.00',{exact:false})).toBeVisible();
 await expect(preparer.page.getByRole('row').filter({has:preparer.page.getByRole('cell',{name:'2026-10',exact:true})}).first()).toContainText('₱166.67');
 await controller.page.goto('/assets/schedules');await settled(controller.page);
 await schedRow(controller.page).getByRole('button',{name:'Approve',exact:true}).click();
 await expect(schedRow(controller.page).getByRole('cell',{name:'approved',exact:true})).toBeVisible({timeout:30000});
 await pickOption(schedRow(controller.page).getByRole('combobox',{name:'Period'}),/2026-10/);
 await schedRow(controller.page).getByRole('button',{name:'Run period'}).click();
 await expect(controller.page.locator('section[role="alert"]')).toHaveCount(0);
 for(let i=0;i<30;i++){await controller.page.goto('/assets/schedules');await settled(controller.page);if(await controller.page.getByText('posted · entry',{exact:false}).count())break;await controller.page.waitForTimeout(2000);}
 await expect(controller.page.getByText('posted · entry',{exact:false}).first()).toBeVisible();
 await schedRow(controller.page).getByRole('button',{name:'Lines'}).click();
 await expect(controller.page.getByText('executed ₱166.67',{exact:false})).toBeVisible();
 // Book/tax comparison and a lifecycle event on the register.
 await controller.page.goto('/assets');await settled(controller.page);
 await assetRow(controller.page).getByRole('button',{name:'Book/tax'}).click();
 await expect(controller.page.getByRole('row').filter({has:controller.page.getByRole('cell',{name:'2026-10',exact:true})}).first()).toContainText('₱166.67');
 await assetRow(controller.page).getByRole('button',{name:'Open',exact:true}).click();
 await controller.page.getByRole('combobox',{name:'Kind',exact:true}).selectOption('transfer');
 await controller.page.getByRole('textbox',{name:'Effective date',exact:true}).fill('2026-11-02');
 await pickOption(controller.page.getByRole('combobox',{name:'Target location'}),/HQ/);
 await controller.page.getByRole('combobox',{name:'Evidence',exact:true}).selectOption({label:'registration.pdf'});
 await controller.page.getByRole('textbox',{name:'Reason',exact:true}).last().fill('Moved to the head office floor');
 await controller.page.getByRole('button',{name:'Record event'}).click();
 await expect(controller.page.locator('section[role="alert"]')).toHaveCount(0);
 await expect(controller.page.getByRole('row').filter({has:controller.page.getByRole('cell',{name:'transfer',exact:true})}).first()).toContainText('Moved to the head office floor');
 for(const route of ['/assets','/assets/schedules']){await controller.page.goto(route);await settled(controller.page);await noSeriousViolations(controller.page,'assets '+route);}
 await controller.context.close();await preparer.context.close();
});
// The feature configurations, the held-out evaluations Finance accepted and
// the requester and reviewer roles have no reviewed operations or seeded
// template yet; the journey seeds them through the runtime role as an
// operator would. Requests, review and the opt-out go through the screen.
async function seedAssistant(){
 const pg=createRequire(new URL('../../packages/database/package.json',import.meta.url))('pg');
 const db=new pg.Client(connectionOptions(process.env.LARA_E2E_DATABASE_URL));await db.connect();
 try{
  const tenantId=(await db.query('select tenant_id from lara.principal_directory where oidc_subject=$1',[who('controller')])).rows[0].tenant_id;
  await db.query("select set_config('lara.tenant_id',$1,false)",[tenantId]);
  const principal=async role=>(await db.query('select principal_id from lara.principal_directory where oidc_subject=$1 and tenant_id=$2',[who(role),tenantId])).rows[0].principal_id;
  const hash=(await db.query("select encode(sha256(convert_to($1,'utf8')),'hex') as h",[JSON.stringify({ai:1})])).rows[0].h;
  for(const feature of ['capture','ask_books']){
   const set=(await db.query("insert into lara.evaluation_sets(tenant_id,feature,version,hash,consent_basis,item_count,created_by) values($1,$2,'heldout-2026-09',$3,'Tenant documents with written consent; no training',220,$4) returning id",[tenantId,feature,hash,await principal('preparer')])).rows[0].id;
   const result=(await db.query("insert into lara.evaluation_results(tenant_id,evaluation_set_id,feature,model_version,prompt_version,metrics,thresholds,item_count,passed,accepted_by,created_by) values($1,$2,$3,'fixture-1','p12.1','{\"materialFieldErrorRate\":0.02,\"unauthorizedActions\":0,\"controlBypasses\":0}','{\"materialFieldErrorRate\":0.05}',220,true,$4,$5) returning id",[tenantId,set,feature,await principal('controller'),await principal('preparer')])).rows[0].id;
   await db.query("insert into lara.model_feature_configs(tenant_id,feature,enabled,budget_minor,provider_policy,model_version,prompt_version,tool_schema_version,evaluation_result_id,approved_by,reason,created_by) values($1,$2,true,1000,'{\"provider\":\"fixture\",\"region\":\"local\",\"retention\":\"none\",\"training\":false}','fixture-1','p12.1','tools-1',$3,$4,'Evaluated on 220 held-out items',$5)",[tenantId,feature,result,await principal('controller'),await principal('preparer')]);
  }
  // No seeded template holds assistant.suggest or assistant.review; tenant roles cover the requester and the reviewer.
  const role=async(code,perms)=>(await db.query("insert into lara.roles(tenant_id,code,name,permissions,status,content_hash,created_by) values($1,$2,$2,$3,'approved',$4,$5) returning id",[tenantId,code,JSON.stringify(perms),hash,await principal('security')])).rows[0].id;
  const userRole=await role('ai_user',['assistant.suggest','assistant.read']);
  const reviewerRole=await role('ai_reviewer',['assistant.review','assistant.read']);
  await db.query('insert into lara.memberships(tenant_id,principal_id,role_id,created_by) values($1,$2,$3,$4),($1,$5,$6,$4)',[tenantId,await principal('preparer'),userRole,await principal('security'),await principal('controller'),reviewerRole]);
 }finally{await db.end();}
}
test('assistant: capability activation, a capture request over a scan that abstains for lack of readable evidence, ask-your-books answering from the trial balance with the scope banner, review by the controller and the feature opt-out',async({browser})=>{
 test.setTimeout(480000);
 const controller=await as(browser,'controller'),preparer=await as(browser,'preparer');
 for(const who of [controller,preparer]){
  await who.page.goto('/settings/capabilities');await settled(who.page);
  const card=who.page.locator('section.demo-card').filter({hasText:'Evidence-backed AI assistance'});
  await card.getByRole('combobox',{name:'Activation evidence'}).selectOption({label:'registration.pdf'});
  await card.getByLabel('Reason').fill(who===controller?'Provider terms reviewed by privacy and security':'Finance accepted the evaluation results');
  await card.getByRole('button',{name:'Request or approve activation'}).click();
  await expect(who.page.locator('section[role="alert"]')).toHaveCount(0);
 }
 await seedAssistant();
 await preparer.page.goto('/assistant');await settled(preparer.page);
 await expect(preparer.page.getByRole('row').filter({has:preparer.page.getByRole('cell',{name:'Bill and receipt capture',exact:true})})).toContainText('on');
 // Capture over the registration scan: no readable field, so the assistant abstains and nothing is drafted.
 await preparer.page.getByRole('checkbox',{name:'registration.pdf'}).check();
 await preparer.page.getByRole('button',{name:'Request suggestion'}).click();
 await expect(preparer.page.locator('section[role="alert"]')).toHaveCount(0);
 const settledRun=async(page,text)=>{for(let i=0;i<30;i++){await page.goto('/assistant');await settled(page);if(await page.getByRole('cell',{name:text,exact:true}).count())return;await page.waitForTimeout(2000);}await expect(page.getByRole('cell',{name:text,exact:true})).toBeVisible();};
 await settledRun(preparer.page,'abstained');
 await preparer.page.getByRole('row').filter({has:preparer.page.getByRole('cell',{name:'abstained',exact:true})}).getByRole('button',{name:'Review'}).click();
 await expect(preparer.page.getByText('Abstained.',{exact:false})).toBeVisible();
 // Ask your books: the number comes from the trial balance of the stated scope.
 await preparer.page.getByRole('combobox',{name:'Feature'}).selectOption('ask_books');
 await preparer.page.getByRole('textbox',{name:'Question',exact:true}).fill('What are the total debits?');
 await preparer.page.getByRole('combobox',{name:'Period',exact:true}).selectOption({index:1});
 await preparer.page.getByRole('button',{name:'Request suggestion'}).click();
 await expect(preparer.page.locator('section[role="alert"]')).toHaveCount(0);
 await settledRun(preparer.page,'succeeded');
 const askRow=page=>page.getByRole('row').filter({has:page.getByRole('cell',{name:'Ask your books',exact:true})}).last();
 await askRow(preparer.page).getByRole('button',{name:'Review'}).click();
 await expect(preparer.page.getByText('Scope:',{exact:false})).toBeVisible();
 await expect(preparer.page.getByText('Total debits',{exact:false}).first()).toBeVisible();
 await expect(preparer.page.getByRole('button',{name:'Accept as proposed'})).toHaveCount(0);
 await controller.page.goto('/assistant');await settled(controller.page);
 await askRow(controller.page).getByRole('button',{name:'Review'}).click();
 await expect(controller.page.getByText('Total debits',{exact:false}).first()).toBeVisible();
 await controller.page.getByRole('button',{name:'Accept as proposed'}).click();
 await expect(controller.page.locator('section[role="alert"]')).toHaveCount(0);
 await expect(controller.page.getByText('reviewed (accept)',{exact:false})).toBeVisible({timeout:15000});
 // The controller switches capture off for the company.
 const captureRow=controller.page.getByRole('row').filter({has:controller.page.getByRole('cell',{name:'Bill and receipt capture',exact:true})});
 await captureRow.getByRole('textbox',{name:'Reason'}).fill('Owner opted out until the next evaluation');
 await captureRow.getByRole('button',{name:'Switch off'}).click();
 await expect(captureRow.getByRole('cell',{name:'off',exact:true})).toBeVisible();
 await controller.page.goto('/assistant');await settled(controller.page);await noSeriousViolations(controller.page,'assistant /assistant');
 await controller.context.close();await preparer.context.close();
});
test('forbidden, roadmap and unknown-account states are explicit; keyboard and mobile flows pass WCAG checks',async({browser})=>{
 test.setTimeout(240000);
 const clerk=await as(browser,'clerk');
 await clerk.page.goto('/settings/setup');await settled(clerk.page);
 await expect(clerk.page.getByRole('button',{name:'Create organization'})).toHaveCount(0);
 await expect(clerk.page.getByRole('button',{name:'Request activation'})).toHaveCount(0);
 await clerk.page.goto('/portal');await expect(clerk.page.locator('h1')).toHaveText('Coming in a later release');
 await expect(clerk.page.getByText('with P13',{exact:false})).toBeVisible();
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
