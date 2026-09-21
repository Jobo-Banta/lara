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
// Lists over the shared database can take longer than the default expectation; settle within 15 s.
const settled=async page=>{await expect(page.getByRole('status').filter({hasText:/Loading/})).toHaveCount(0,{timeout:15000});};
// Selects the first option whose text matches; selectOption takes no regular expression.
const pickOption=async(box,re)=>box.selectOption(await box.locator('option',{hasText:re}).first().getAttribute('value'));
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
 // B's save must have landed before A saves, or A's write wins the race and no conflict exists: the editor reports 'Up to date.' only once its save returned.
 await expect(b.page.getByRole('status').filter({hasText:/Saving|Unsaved|Up to date/})).toHaveText('Up to date.',{timeout:15000});await expect(b.page.locator('section[role="alert"]')).toHaveCount(0);
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
// The portal profile and the relations and authorizer roles have no reviewed
// operations or seeded template yet; the journey seeds them through the
// runtime role as an operator would. The invite, the message, the authorized
// send, the acceptance and the member's fenced portal go through the screens;
// the local mail adapter writes the invite into the object bucket, which the
// journey reads as the invitee's mailbox.
async function seedPortal(){
 const pg=createRequire(new URL('../../packages/database/package.json',import.meta.url))('pg');
 const db=new pg.Client(connectionOptions(process.env.LARA_E2E_DATABASE_URL));await db.connect();
 try{
  const tenantId=(await db.query('select tenant_id from lara.principal_directory where oidc_subject=$1',[who('controller')])).rows[0].tenant_id;
  await db.query("select set_config('lara.tenant_id',$1,false)",[tenantId]);
  const entity=(await db.query('select id from lara.entities where tenant_id=$1 order by created_at limit 1',[tenantId])).rows[0].id;
  const principal=async role=>(await db.query('select principal_id from lara.principal_directory where oidc_subject=$1 and tenant_id=$2',[who(role),tenantId])).rows[0].principal_id;
  const hash=(await db.query("select encode(sha256(convert_to($1,'utf8')),'hex') as h",[JSON.stringify({portal:1})])).rows[0].h;
  const bank=(await db.query("select id from lara.bank_accounts where tenant_id=$1 and entity_id=$2 and status='approved' order by created_at limit 1",[tenantId,entity])).rows[0]?.id||null;
  const payload={messagingProvider:'local-mail',paymentProvider:'fixture-pay',paymentBankAccountId:bank,shareDays:14,termsVersion:'portal-2026',supportEmail:'support@portal.invalid',baseUrl:BASE};
  const ph=(await db.query("select encode(sha256(convert_to($1,'utf8')),'hex') as h",[JSON.stringify(payload)])).rows[0].h;
  await db.query("insert into lara.settings_versions(tenant_id,entity_id,kind,version_number,payload,payload_hash,status,approved_by,effective_at,created_by) values($1,$2,'portal_profile',1,$3,$4,'approved',$5,now(),$6)",[tenantId,entity,JSON.stringify(payload),ph,await principal('preparer'),await principal('controller')]);
  const role=async(code,perms)=>(await db.query("insert into lara.roles(tenant_id,code,name,permissions,status,content_hash,created_by) values($1,$2,$2,$3,'approved',$4,$5) returning id",[tenantId,code,JSON.stringify(perms),hash,await principal('security')])).rows[0].id;
  const relations=await role('relations',['portal_invite.create','portal_invite.edit','portal_invite.read','message_request.create','message_request.edit','message_request.read','payment_link.create','payment_link.edit','payment_link.read','payment_link.cancel']);
  const authorizer=await role('message_authorizer',['message_request.send','message_request.read','portal_invite.revoke','portal_invite.read','payment_link.read']);
  await db.query('insert into lara.memberships(tenant_id,principal_id,role_id,created_by) values($1,$2,$3,$4),($1,$5,$6,$4)',[tenantId,await principal('preparer'),relations,await principal('security'),await principal('controller'),authorizer]);
 }finally{await db.end();}
}
test('portal: capability activation, a customer invite drafted and its message authorized by another principal and delivered by the worker, acceptance of the invite link by the invited identity, the member seeing only its own invoices and statement and no internal screen, and revocation',async({browser})=>{
 test.setTimeout(480000);
 const controller=await as(browser,'controller'),preparer=await as(browser,'preparer');
 for(const who of [controller,preparer]){
  await who.page.goto('/settings/capabilities');await settled(who.page);
  const card=who.page.locator('section.demo-card').filter({hasText:'Customer and supplier portals and messaging'});
  await card.getByRole('combobox',{name:'Activation evidence'}).selectOption({label:'registration.pdf'});
  await card.getByLabel('Reason').fill(who===controller?'Channel and provider qualified':'Consent and terms recorded');
  await card.getByRole('button',{name:'Request or approve activation'}).click();
  await expect(who.page.locator('section[role="alert"]')).toHaveCount(0);
 }
 await seedPortal();
 // The invite and its message by the relations officer.
 await preparer.page.goto('/portal');await settled(preparer.page);
 const partyBox=preparer.page.getByRole('combobox',{name:'Party',exact:true});
 await partyBox.selectOption(await partyBox.locator('option',{hasText:'Northwind'}).first().getAttribute('value'));
 await preparer.page.getByRole('textbox',{name:'Email',exact:true}).fill('owner@northwind.invalid');
 await preparer.page.getByRole('button',{name:'Create invite'}).click();
 const inviteRow=page=>page.getByRole('row').filter({has:page.getByRole('cell',{name:'o***@northwind.invalid',exact:true})});
 await expect(inviteRow(preparer.page).getByRole('cell',{name:'pending',exact:true})).toBeVisible();
 await inviteRow(preparer.page).getByRole('button',{name:'Draft invite message'}).click();
 const msgRow=page=>page.getByRole('row').filter({has:page.getByRole('cell',{name:'invite-2026',exact:true})}).last();
 await expect(msgRow(preparer.page).getByRole('cell',{name:'draft',exact:true})).toBeVisible();
 await expect(msgRow(preparer.page).getByRole('button',{name:'Authorize and send'})).toHaveCount(0);
 // Authorized by the controller; the worker delivers into the local mailbox.
 await controller.page.goto('/portal');await settled(controller.page);
 await msgRow(controller.page).getByRole('textbox',{name:'Reason'}).fill('Onboarding Northwind');
 await msgRow(controller.page).getByRole('button',{name:'Authorize and send'}).click();
 await expect(controller.page.locator('section[role="alert"]')).toHaveCount(0);
 for(let i=0;i<30;i++){await controller.page.goto('/portal');await settled(controller.page);if(await msgRow(controller.page).getByRole('cell',{name:'sent',exact:true}).count())break;await controller.page.waitForTimeout(2000);}
 await expect(msgRow(controller.page).getByRole('cell',{name:'sent',exact:true})).toBeVisible();
 await msgRow(controller.page).getByRole('button',{name:'Receipts'}).click();
 await expect(controller.page.getByRole('row').filter({has:controller.page.getByRole('cell',{name:'local-mail',exact:true})}).first()).toContainText('sent');
 const {readdir,readFile}=await import('node:fs/promises');
 const dir=new URL('../../.local/e2e-workspace/messages/',import.meta.url);
 const files=(await readdir(dir)).filter(f=>f.endsWith('.json'));
 let mail=null;for(const f of files){const m=JSON.parse(await readFile(new URL(f,dir),'utf8'));if(/invite=/.test(m.link)&&(!mail||m.sentAt>mail.sentAt))mail=m;}
 expect(mail,'the invite reached the local mailbox').toBeTruthy();
 expect(mail.body).not.toContain('Northwind');
 const link=new URL(mail.link);
 // The invited identity accepts and sees only its own records.
 const member={context:await browser.newContext({baseURL:BASE})};await member.context.addCookies([cookie('owner@northwind.invalid')]);member.page=await member.context.newPage();
 await member.page.goto('/portal/accept'+link.search);
 await member.page.getByRole('textbox',{name:'Email address on the invite'}).fill('owner@northwind.invalid');
 await member.page.getByRole('button',{name:'Accept invite'}).click();
 await expect(member.page.getByRole('heading',{name:'Welcome'})).toBeVisible({timeout:15000});
 await member.page.goto('/portal');await settled(member.page);
 await expect(member.page.getByRole('heading',{name:'Northwind Services'})).toBeVisible({timeout:15000});
 await expect(member.page.getByText('Customer portal of',{exact:false})).toBeVisible();
 await expect(member.page.getByRole('cell',{name:'INV-000001',exact:false}).first()).toBeVisible();
 await member.page.goto('/parties');await settled(member.page);
 await expect(member.page.getByRole('heading',{name:'Northwind Services'})).toBeVisible({timeout:15000});
 await expect(member.page.getByRole('heading',{name:'Parties'})).toHaveCount(0);
 await expect(member.page.getByRole('link',{name:'Journals'})).toHaveCount(0);
 await member.page.goto('/portal');await settled(member.page);await noSeriousViolations(member.page,'portal member /portal');
 // Revocation by the authorizer ends the member's access.
 await controller.page.goto('/portal');await settled(controller.page);
 await inviteRow(controller.page).getByRole('textbox',{name:'Reason'}).fill('Contact left Northwind');
 await inviteRow(controller.page).getByRole('button',{name:'Revoke'}).click();
 await expect(inviteRow(controller.page).getByRole('cell',{name:'revoked',exact:true})).toBeVisible();
 await member.page.goto('/portal');await settled(member.page);
 await expect(member.page.getByRole('heading',{name:'Set up your organization'})).toBeVisible({timeout:15000});
 await expect(member.page.getByRole('heading',{name:'Northwind Services'})).toHaveCount(0);
 await noSeriousViolations(controller.page,'portal admin /portal');
 await member.context.close();await controller.context.close();await preparer.context.close();
});
// The firm's own organization, its partner and the client-side mandate and
// approver roles have no reviewed operations or seeded template yet; the
// journey seeds them through the runtime role as an operator would. The firm
// record, the mandate, its approval, the client list, the roll-up, the
// client context and the revocation go through the screens.
async function seedFirm(){
 const pg=createRequire(new URL('../../packages/database/package.json',import.meta.url))('pg');
 const {organization,identity,inTransaction}=await import('../../packages/domain/src/index.mjs');
 const db=new pg.Client(connectionOptions(process.env.LARA_E2E_DATABASE_URL));await db.connect();
 try{
  const clientTenant=(await db.query('select tenant_id from lara.principal_directory where oidc_subject=$1',[who('controller')])).rows[0].tenant_id;
  const firmTenant=(await db.query('select gen_random_uuid() as id')).rows[0].id;
  await inTransaction(db,{tenantId:firmTenant,principalId:null},async tx=>{
   await organization.provisionTenant(tx,{id:firmTenant,slug:'api-firm-e2e-'+suffix,name:'Ledger & Co (firm)',mode:'demo'});
   const partner=(await identity.resolvePrincipal(tx,firmTenant,{issuer:'https://identity.invalid',subject:who('partner'),displayName:'Partner'})).id;
   const role=(await tx.query("insert into lara.roles(tenant_id,code,name,permissions,status,content_hash,created_by) values($1,'firm_partner','Firm partner',$2,'approved',$3,$4) returning id",[firmTenant,JSON.stringify(['firm_assignment.create','firm_assignment.read','firm_mandate.read','session.read','entity.create','entity.read','task.read']),'0'.repeat(64),partner])).rows[0].id;
   await tx.query('insert into lara.memberships(tenant_id,principal_id,role_id,created_by) values($1,$2,$3,$2)',[firmTenant,partner,role]);
   // The firm's own legal entity: firm records are audited against it.
   const p={...await identity.actorContext(tx,firmTenant,partner),traceId:'seed-firm'};
   await organization.createEntity(tx,p,{legalName:'Ledger & Co',baseCurrency:'PHP',timezone:'Asia/Manila',fiscalYearStartMonth:1});
  });
  await db.query("select set_config('lara.tenant_id',$1,false)",[clientTenant]);
  const principal=async role=>(await db.query('select principal_id from lara.principal_directory where oidc_subject=$1 and tenant_id=$2',[who(role),clientTenant])).rows[0].principal_id;
  const role=async(code,perms)=>(await db.query("insert into lara.roles(tenant_id,code,name,permissions,status,content_hash,created_by) values($1,$2,$2,$3,'approved',$4,$5) returning id",[clientTenant,code,JSON.stringify(perms),'0'.repeat(64),await principal('security')])).rows[0].id;
  const mandates=await role('mandates',['firm_mandate.create','firm_mandate.edit','firm_mandate.read','firm_mandate.revoke','firm_assignment.read']);
  const approver=await role('mandate_approver',['firm_mandate.approve','firm_mandate.read','firm_mandate.revoke','firm_assignment.read']);
  await db.query('insert into lara.memberships(tenant_id,principal_id,role_id,created_by) values($1,$2,$3,$4),($1,$5,$6,$4)',[clientTenant,await principal('preparer'),mandates,await principal('security'),await principal('controller'),approver]);
 }finally{await db.end();}
}
test('firm: capability activation, a firm registered in its own organization, a mandate drafted by the client on the engagement evidence and approved by a second principal, the client in the partner\'s list and roll-up, the explicit client context, and revocation',async({browser})=>{
 test.setTimeout(480000);
 const controller=await as(browser,'controller'),preparer=await as(browser,'preparer');
 for(const who of [controller,preparer]){
  await who.page.goto('/settings/capabilities');await settled(who.page);
  const card=who.page.locator('section.demo-card').filter({hasText:'Accounting firm multi-client workspace'});
  await card.getByRole('combobox',{name:'Activation evidence'}).selectOption({label:'registration.pdf'});
  await card.getByLabel('Reason').fill(who===controller?'Engagement signed with Ledger & Co':'Permission and expiry boundaries reviewed');
  await card.getByRole('button',{name:'Request or approve activation'}).click();
  await expect(who.page.locator('section[role="alert"]')).toHaveCount(0);
 }
 await seedFirm();
 // The partner registers the firm in its own organization.
 const partner=await as(browser,'partner');
 await partner.page.goto('/firm');await settled(partner.page);
 await partner.page.getByRole('textbox',{name:'Firm name',exact:true}).fill('Ledger & Co');
 await partner.page.getByRole('button',{name:'Register firm'}).click();
 await expect(partner.page.getByText('give this id to a client',{exact:false})).toBeVisible();
 const firmId=(await partner.page.locator('code').first().textContent()).trim();
 expect(firmId).toMatch(/^[0-9a-f-]{36}$/);
 await expect(partner.page.getByText('No client has mandated you yet.')).toBeVisible();
 // The client drafts the mandate on the engagement evidence; a second principal approves.
 await preparer.page.goto('/firm/mandates');await settled(preparer.page);
 await preparer.page.getByRole('textbox',{name:'Firm id',exact:true}).fill(firmId);
 await preparer.page.getByRole('combobox',{name:'Engagement evidence'}).selectOption({label:'registration.pdf'});
 await preparer.page.getByRole('button',{name:'Draft mandate'}).click();
 const mandateRow=page=>page.getByRole('row').filter({has:page.getByRole('cell',{name:firmId.slice(0,8),exact:true})});
 await expect(mandateRow(preparer.page).getByRole('cell',{name:'draft',exact:true})).toBeVisible();
 await expect(mandateRow(preparer.page).getByRole('button',{name:'Approve'})).toHaveCount(0);
 await controller.page.goto('/firm/mandates');await settled(controller.page);
 await mandateRow(controller.page).getByRole('button',{name:'Approve'}).click();
 await expect(mandateRow(controller.page).getByRole('cell',{name:'approved',exact:true})).toBeVisible({timeout:15000});
 // The partner sees the client, its roll-up, and opens it in an explicit context.
 await partner.page.goto('/firm');await settled(partner.page);
 await expect(partner.page.getByRole('cell',{name:'CI Workspace Entity',exact:true})).toBeVisible();
 await partner.page.getByRole('button',{name:'Refresh roll-up'}).click();
 await expect(partner.page.getByText('nothing is summed across them',{exact:false})).toBeVisible({timeout:15000});
 await expect(partner.page.getByRole('row').filter({hasText:'CI Workspace Entity ('}).first()).toBeVisible();
 await partner.page.getByRole('button',{name:'Open client'}).click();
 await expect(partner.page).toHaveURL(/\/work$/);
 await expect(partner.page.getByText('Client context:',{exact:false})).toBeVisible({timeout:15000});
 await expect(partner.page.getByRole('heading',{level:1})).toHaveText('My work');
 await partner.page.goto('/ledger/journals');await settled(partner.page);
 await expect(partner.page.locator('section[role="alert"]')).toContainText('Not permitted');
 await partner.page.getByRole('button',{name:'Leave client'}).click();
 await expect(partner.page).toHaveURL(/\/firm$/);
 await noSeriousViolations(partner.page,'firm /firm');
 // Revocation ends the client at once.
 await controller.page.goto('/firm/mandates');await settled(controller.page);
 await mandateRow(controller.page).getByRole('textbox',{name:'Reason'}).fill('Engagement ended');
 await mandateRow(controller.page).getByRole('button',{name:'Revoke'}).click();
 await expect(mandateRow(controller.page).getByRole('cell',{name:'revoked',exact:true})).toBeVisible();
 await noSeriousViolations(controller.page,'client /firm/mandates');
 await partner.page.goto('/firm');await settled(partner.page);
 await expect(partner.page.getByText('No client has mandated you yet.')).toBeVisible({timeout:15000});
 await partner.context.close();await controller.context.close();await preparer.context.close();
});
// The group accountant and reviewer roles have no reviewed template yet; a
// wholly-owned subsidiary with its own books, an approved invoice from the
// workspace entity to it and the frozen closes are seeded through the domain
// so the journey stays on the group screens.
async function seedGroup(){
 const pg=createRequire(new URL('../../packages/database/package.json',import.meta.url))('pg');
 const {organization,identity,ledger,parties,sales,evidence,inTransaction,FilesystemEvidenceStore}=await import('../../packages/domain/src/index.mjs');
 const db=new pg.Client(connectionOptions(process.env.LARA_E2E_DATABASE_URL));await db.connect();
 try{
  const tenantId=(await db.query('select tenant_id from lara.principal_directory where oidc_subject=$1',[who('controller')])).rows[0].tenant_id;
  await db.query("select set_config('lara.tenant_id',$1,false)",[tenantId]);
  const principal=async role=>(await db.query('select principal_id from lara.principal_directory where oidc_subject=$1 and tenant_id=$2',[who(role),tenantId])).rows[0].principal_id;
  const hash=(await db.query("select encode(sha256(convert_to($1,'utf8')),'hex') as h",['group'])).rows[0].h;
  const role=async(code,perms)=>(await db.query("insert into lara.roles(tenant_id,code,name,permissions,status,content_hash,created_by) values($1,$2,$2,$3,'approved',$4,$5) returning id",[tenantId,code,JSON.stringify(perms),hash,await principal('security')])).rows[0].id;
  const accountant=await role('group_accountant',['group.create','group.edit','group.read','intercompany_pair.create','intercompany_pair.edit','intercompany_pair.read','intercompany_pair.accept','intercompany_pair.post','consolidation.create','consolidation.edit','consolidation.read','consolidation.preview']);
  const reviewer=await role('group_reviewer',['group.read','group.activate','intercompany_pair.read','consolidation.read','consolidation.approve','consolidation.publish']);
  await db.query('insert into lara.memberships(tenant_id,principal_id,role_id,created_by) values($1,$2,$3,$4),($1,$5,$6,$4)',[tenantId,await principal('preparer'),accountant,await principal('security'),await principal('controller'),reviewer]);
  const parent=(await db.query('select id from lara.entities where tenant_id=$1 order by created_at limit 1',[tenantId])).rows[0].id;
  const ctrlId=await principal('controller'),prepId=await principal('preparer'),billId=await principal('billing'),clerkId=await principal('clerk');
  await inTransaction(db,{tenantId,principalId:ctrlId},async tx=>{
   const ctxOf=async id=>({...await identity.actorContext(tx,tenantId,id),traceId:'seed-group'});
   let ctrl=await ctxOf(ctrlId);
   const sub=(await organization.createEntity(tx,ctrl,{legalName:'CI Subsidiary',baseCurrency:'PHP',timezone:'Asia/Manila',fiscalYearStartMonth:1})).id;
   ctrl=await ctxOf(ctrlId);const prep=await ctxOf(prepId),bill=await ctxOf(billId),clerk=await ctxOf(clerkId);
   const branch=await organization.createBranch(tx,ctrl,sub,{code:'HQ',name:'Head office',address:'Cebu'});
   for(const cap of ['workspace','general_ledger','sales','purchasing','treasury','compliance','fi_coexistence','multi_currency','inventory','assets'])await tx.query("insert into lara.capability_activations(tenant_id,entity_id,capability,status,profile_version,approved_by,activated_at,created_by) values($1,$2,$3,'active','p.1',$4,now(),$5)",[tenantId,sub,cap,prepId,ctrlId]);
   const book=await ledger.createBook(tx,ctrl,sub,{code:'php-main',kind:'primary',functionalCurrency:'PHP',sourceOwner:'lara'});
   const mk=(code,name,category,extra={})=>ledger.createAccount(tx,prep,sub,{bookId:book.id,code,name,category,controlType:'none',requiredDimensions:[],...extra});
   const cash=await mk('1010','Cash','asset'),ar=await mk('1200','Receivables','asset',{controlType:'ar'}),inTax=await mk('1300','Input tax','asset',{controlType:'input_tax'}),adv=await mk('1400','Advances','asset'),ap=await mk('2100','Payables','liability',{controlType:'ap'}),outTax=await mk('2200','Output tax','liability',{controlType:'output_tax'}),whtPay=await mk('2300','Withholding payable','liability'),equity=await mk('3000','Share capital','equity');await mk('4000','Service revenue','income');await mk('5000','Professional fees','expense');await mk('5100','Intercompany services','expense');
   await ledger.createPeriod(tx,ctrl,sub,{bookId:book.id,startsOn:'2026-10-01',endsOn:'2026-10-31'});
   const settle=async(kind,payload)=>{const s=await organization.saveSettings(tx,ctrl,sub,kind,payload);await organization.approveSettings(tx,{...prep,permissions:new Set([...prep.permissions,'entity.activate'])},sub,s.id,{payloadHash:s.payloadHash});};
   await settle('sales_profile',{arAccountId:ar.id,outputTaxAccountId:outTax.id,cashAccountId:cash.id,scale:2,dueDays:30});
   await settle('purchasing_profile',{apAccountId:ap.id,inputTaxAccountId:inTax.id,cashAccountId:cash.id,withholdingPayableAccountId:whtPay.id,advanceAccountId:adv.id,withholdingRecognition:'accrual',scale:2,dueDays:30,requirePurchaseOrder:false,requireReceiptOfService:false,nonPoAccountIds:[],duplicateWindowDays:7,expensePolicyVersion:'expense-2026',supplierWithholding:{}});
   await tx.query("insert into lara.document_series(tenant_id,entity_id,branch_id,kind,prefix,profile_version,created_by) values($1,$2,$3,'bill','BILL','numbering-2026',$4)",[tenantId,sub,branch.id,ctrlId]);
   const j=await ledger.createJournal(tx,prep,sub,{bookId:book.id,accountingDate:'2026-10-01',documentDate:'2026-10-01',currency:'PHP',description:'Share capital',lines:[{accountId:cash.id,branchId:branch.id,debit:'50000.00',credit:'0',dimensions:{}},{accountId:equity.id,branchId:branch.id,debit:'0',credit:'50000.00',dimensions:{}}],evidenceIds:[]});
   await ledger.submitJournal(tx,prep,sub,j.id,{});await ledger.approveJournal(tx,ctrl,sub,j.id,{decision:'approve',contentVersion:1});await ledger.postJournal(tx,ctrl,sub,j.id,{});
   const env={FIELD_ENCRYPTION_KEY:process.env.FIELD_ENCRYPTION_KEY};
   await parties.createParty(tx,clerk,sub,{legalName:'CI Workspace Entity',roles:['supplier'],identityStatus:'unknown',address:'Makati'},env);
   const store=new FilesystemEvidenceStore('.local/e2e-workspace');const copy=Buffer.from('%PDF-1.4 intercompany invoice copy'+String.fromCharCode(10));
   const reg=await evidence.registerUpload(tx,clerk,sub,{filename:'intercompany-invoice.pdf',mime:'application/pdf',byteCount:copy.length,sha256:createHash('sha256').update(copy).digest('hex'),classification:'internal'});
   await evidence.completeUpload(tx,clerk,sub,reg.evidenceId,copy,store);await evidence.recordScan(tx,{tenantId,principalId:null},sub,reg.evidenceId,new evidence.FixtureScanner(),store);
   const customer=await parties.createParty(tx,clerk,parent,{legalName:'CI Subsidiary',roles:['customer'],identityStatus:'unknown',address:'Cebu'},env);
   const pb=(await tx.query("select b.id as book_id,(select id from lara.branches where tenant_id=b.tenant_id and entity_id=b.entity_id and code='HQ') as branch_id,(select id from lara.accounts a where a.tenant_id=b.tenant_id and a.entity_id=b.entity_id and a.code='4000') as revenue from lara.books b where b.tenant_id=$1 and b.entity_id=$2 and b.kind='primary'",[tenantId,parent])).rows[0];
   const inv=await sales.createDocument(tx,bill,parent,{kind:'invoice',branchId:pb.branch_id,bookId:pb.book_id,partyId:customer.id,documentDate:'2026-10-12',accountingDate:'2026-10-12',currency:'PHP',ruleProfileVersion:'ph-2026',lines:[{description:'Management services',quantity:'1',unitPrice:'12000',discount:'0',priceBasis:'exclusive',accountId:pb.revenue,dimensions:{}}],evidenceIds:[]});
   await sales.submitDocument(tx,bill,parent,inv.id,{});await sales.approveDocument(tx,prep,parent,inv.id,{decision:'approve',contentVersion:1});
   return sub;
  });
  return (await db.query("select id from lara.entities where tenant_id=$1 and legal_name='CI Subsidiary'",[tenantId])).rows[0].id;
 }finally{await db.end();}
}
// The subsidiary approves the accepted bill under its own maker-checker, and both closes are frozen with statements snapshots for the run.
async function approveSubBillAndFreeze(){
 const pg=createRequire(new URL('../../packages/database/package.json',import.meta.url))('pg');
 const {identity,ledger,purchasing,inTransaction}=await import('../../packages/domain/src/index.mjs');
 const db=new pg.Client(connectionOptions(process.env.LARA_E2E_DATABASE_URL));await db.connect();
 try{
  const tenantId=(await db.query('select tenant_id from lara.principal_directory where oidc_subject=$1',[who('controller')])).rows[0].tenant_id;
  await db.query("select set_config('lara.tenant_id',$1,false)",[tenantId]);
  const principal=async role=>(await db.query('select principal_id from lara.principal_directory where oidc_subject=$1 and tenant_id=$2',[who(role),tenantId])).rows[0].principal_id;
  const ctrlId=await principal('controller'),clerkId=await principal('clerk');
  await inTransaction(db,{tenantId,principalId:ctrlId},async tx=>{
   const ctxOf=async id=>({...await identity.actorContext(tx,tenantId,id),traceId:'seed-group'});
   const ctrl=await ctxOf(ctrlId),clerk=await ctxOf(clerkId);
   const sub=(await tx.query("select id from lara.entities where tenant_id=$1 and legal_name='CI Subsidiary'",[tenantId])).rows[0].id;
   const bill=(await tx.query("select id,content_version from lara.documents where tenant_id=$1 and entity_id=$2 and kind='bill' and state='draft'",[tenantId,sub])).rows[0];
   await purchasing.submitDocument(tx,clerk,sub,bill.id,{});await purchasing.approveDocument(tx,ctrl,sub,bill.id,{decision:'approve',contentVersion:Number(bill.content_version)});
  });
 }finally{await db.end();}
}
async function freezeCloses(){
 const pg=createRequire(new URL('../../packages/database/package.json',import.meta.url))('pg');
 const {identity,ledger,inTransaction}=await import('../../packages/domain/src/index.mjs');
 const db=new pg.Client(connectionOptions(process.env.LARA_E2E_DATABASE_URL));await db.connect();
 try{
  const tenantId=(await db.query('select tenant_id from lara.principal_directory where oidc_subject=$1',[who('controller')])).rows[0].tenant_id;
  await db.query("select set_config('lara.tenant_id',$1,false)",[tenantId]);
  const ctrlId=(await db.query('select principal_id from lara.principal_directory where oidc_subject=$1 and tenant_id=$2',[who('controller'),tenantId])).rows[0].principal_id;
  await inTransaction(db,{tenantId,principalId:ctrlId},async tx=>{
   const ctrl={...await identity.actorContext(tx,tenantId,ctrlId),traceId:'seed-group'};
   for(const e of (await tx.query("select e.id,b.id as book_id,p.id as period_id,p.status from lara.entities e join lara.books b on b.tenant_id=e.tenant_id and b.entity_id=e.id and b.kind='primary' and b.status<>'archived' join lara.periods p on p.tenant_id=e.tenant_id and p.book_id=b.id and p.starts_on='2026-10-01' where e.tenant_id=$1",[tenantId])).rows){
    if(e.status==='open')await ledger.softClosePeriod(tx,ctrl,e.id,e.period_id,{reason:'Month end for the group'});
    await ledger.snapshotReport(tx,ctrl,e.id,{reportType:'statements',bookId:e.book_id,periodStart:'2026-10-01',periodEnd:'2026-10-31',asOf:new Date().toISOString(),format:'json'});
   }
  });
 }finally{await db.end();}
}
test('group: capability activation, a group defined with a wholly-owned subsidiary and mapped from the member charts, the mapping approved and the group activated by the reviewer, a rate set, an intercompany pair raised, accepted in the subsidiary, an exception on the unapproved side, both sides posted, readiness, a run previewed into the worksheet, approved and published',async({browser})=>{
 test.setTimeout(600000);
 const controller=await as(browser,'controller'),preparer=await as(browser,'preparer');
 for(const who of [controller,preparer]){
  await who.page.goto('/settings/capabilities');await settled(who.page);
  const card=who.page.locator('section.demo-card').filter({hasText:'Intercompany and consolidation'});
  await card.getByRole('combobox',{name:'Activation evidence'}).selectOption({label:'registration.pdf'});
  await card.getByLabel('Reason').fill(who===controller?'Group reporting approved by the board':'Ownership, method and mapping basis reviewed');
  await card.getByRole('button',{name:'Request or approve activation'}).click();
  await expect(who.page.locator('section[role="alert"]')).toHaveCount(0);
 }
 const subId=await seedGroup();
 const inEntity=async(who,id)=>{await who.page.evaluate(e=>sessionStorage.setItem('lara-entity',e),id);};
 // The group, its members and the mapping drafted from the member charts.
 await preparer.page.goto('/group');await settled(preparer.page);
 await preparer.page.getByRole('textbox',{name:'Group name'}).fill('CI Holdings group');
 await preparer.page.getByRole('checkbox',{name:'CI Subsidiary'}).check();
 await preparer.page.getByRole('button',{name:'Define group'}).click();
 await expect(preparer.page.getByRole('cell',{name:'CI Subsidiary',exact:true})).toBeVisible({timeout:15000});
 await preparer.page.getByRole('textbox',{name:'Mapping version'}).fill('2026.1');
 await preparer.page.getByRole('button',{name:'Draft mapping from member charts'}).click();
 const mappingRow=page=>page.getByRole('row').filter({has:page.getByRole('cell',{name:'2026.1',exact:true})});
 await expect(mappingRow(preparer.page).getByRole('cell',{name:'draft',exact:true})).toBeVisible({timeout:20000});
 await expect(preparer.page.getByRole('button',{name:'Approve mapping'})).toHaveCount(0);
 await controller.page.goto('/group');await settled(controller.page);
 await mappingRow(controller.page).getByRole('button',{name:'Approve mapping'}).click();
 await expect(mappingRow(controller.page).getByRole('cell',{name:'approved',exact:true})).toBeVisible({timeout:15000});
 await controller.page.getByRole('textbox',{name:'Reason'}).first().fill('Ownership and mapping reviewed');
 await controller.page.getByRole('button',{name:'Activate group'}).click();
 await expect(controller.page.getByText('state active',{exact:false})).toBeVisible({timeout:15000});
 // A rate set from the source publication, approved by the reviewer.
 await preparer.page.goto('/group');await settled(preparer.page);
 await preparer.page.getByRole('textbox',{name:'Code',exact:true}).fill('2026-10');
 await preparer.page.getByRole('textbox',{name:'Period end'}).fill('2026-10-31');
 await preparer.page.getByRole('combobox',{name:'Source evidence'}).selectOption({label:'registration.pdf'});
 await preparer.page.getByRole('button',{name:'Save rate set'}).click();
 const rateRow=page=>page.getByRole('row').filter({has:page.getByRole('cell',{name:'2026-10',exact:true})});
 await expect(rateRow(preparer.page).getByRole('cell',{name:'draft',exact:true})).toBeVisible({timeout:15000});
 await controller.page.goto('/group');await settled(controller.page);
 await rateRow(controller.page).getByRole('button',{name:'Approve rate set'}).click();
 await expect(rateRow(controller.page).getByRole('cell',{name:'approved',exact:true})).toBeVisible({timeout:15000});
 await noSeriousViolations(controller.page,'group /group');
 // The pair: raised in the workspace entity against the approved invoice, accepted in the subsidiary.
 await preparer.page.goto('/group/pairs');await settled(preparer.page);
 await preparer.page.getByRole('combobox',{name:'Target entity'}).selectOption({label:'CI Subsidiary'});
 await pickOption(preparer.page.getByRole('combobox',{name:'Source invoice'}),/12000\.00 · approved/);
 await preparer.page.getByRole('combobox',{name:/Supplier party in/}).selectOption({label:'CI Workspace Entity'});
 await preparer.page.getByRole('combobox',{name:'Expense account in the target'}).selectOption({label:'5100 Intercompany services'});
 await preparer.page.getByRole('combobox',{name:/Evidence in the target/}).selectOption({label:'intercompany-invoice.pdf'});
 await preparer.page.getByRole('button',{name:'Raise pair'}).click();
 const pairRow=page=>page.getByRole('row').filter({has:page.getByRole('cell',{name:'ICP-000001',exact:true})});
 await expect(pairRow(preparer.page).getByRole('cell',{name:'draft',exact:true})).toBeVisible({timeout:15000});
 await expect(preparer.page.getByRole('button',{name:'Accept into our books'})).toHaveCount(0);
 await inEntity(preparer,subId);
 await preparer.page.goto('/group/pairs');await settled(preparer.page);
 await pairRow(preparer.page).getByRole('button',{name:'Accept into our books'}).click();
 await expect(pairRow(preparer.page).getByRole('cell',{name:'accepted',exact:true})).toBeVisible({timeout:15000});
 // The unapproved bill cannot post: the pair shows the exception; nothing is fabricated.
 await pairRow(preparer.page).getByRole('button',{name:'Post our side'}).click();
 await expect(pairRow(preparer.page).getByRole('cell',{name:'exception',exact:true})).toBeVisible({timeout:15000});
 await expect(pairRow(preparer.page)).toContainText('STATE_CONFLICT');
 await approveSubBillAndFreeze();
 await preparer.page.goto('/group/pairs');await settled(preparer.page);
 await pairRow(preparer.page).getByRole('button',{name:'Post our side'}).click();
 await expect(pairRow(preparer.page).getByRole('cell',{name:'accepted',exact:true})).toBeVisible({timeout:15000});
 await expect(pairRow(preparer.page)).toContainText('target');
 await noSeriousViolations(preparer.page,'group /group/pairs');
 await preparer.page.evaluate(()=>sessionStorage.removeItem('lara-entity'));
 await preparer.page.goto('/group/pairs');await settled(preparer.page);
 await pairRow(preparer.page).getByRole('button',{name:'Post our side'}).click();
 await expect(pairRow(preparer.page).getByRole('cell',{name:'posted',exact:true})).toBeVisible({timeout:15000});
 // Frozen closes, readiness and the run.
 await freezeCloses();
 await preparer.page.goto('/group/consolidations');await settled(preparer.page);
 await preparer.page.getByRole('textbox',{name:'Period end'}).fill('2026-10-31');
 await expect(preparer.page.getByRole('row').filter({hasText:'CI Subsidiary'}).getByRole('cell',{name:'yes',exact:true})).toBeVisible({timeout:20000});
 await preparer.page.getByRole('combobox',{name:'Rate set'}).selectOption({label:'2026-10'});
 await preparer.page.getByRole('combobox',{name:'Mapping version'}).selectOption({label:'2026.1'});
 await preparer.page.getByRole('button',{name:'Create run'}).click();
 const runRow=page=>page.getByRole('row').filter({has:page.getByRole('cell',{name:'v1',exact:true})});
 await expect(runRow(preparer.page).getByRole('cell',{name:'draft',exact:true})).toBeVisible({timeout:15000});
 await runRow(preparer.page).getByRole('button',{name:'Preview'}).click();
 await expect(runRow(preparer.page).getByRole('cell',{name:'previewed',exact:true})).toBeVisible({timeout:30000});
 await runRow(preparer.page).getByRole('button',{name:'Worksheet'}).click();
 await expect(preparer.page.getByRole('status').filter({hasText:'Translation reserve'})).toContainText('balanced',{timeout:15000});
 await expect(preparer.page.getByRole('row').filter({hasText:'G1200 Receivables'})).toContainText('12,000.00');
 await expect(preparer.page.getByRole('row').filter({hasText:'G5100 Intercompany services'})).toContainText('₱0.00');
 await expect(preparer.page.getByRole('button',{name:'Approve',exact:true})).toHaveCount(0);
 await noSeriousViolations(preparer.page,'group /group/consolidations');
 await controller.page.goto('/group/consolidations');await settled(controller.page);
 await runRow(controller.page).getByRole('button',{name:'Approve',exact:true}).click();
 await expect(runRow(controller.page).getByRole('cell',{name:'approved',exact:true})).toBeVisible({timeout:15000});
 await runRow(controller.page).getByRole('button',{name:'Publish'}).click();
 await expect(runRow(controller.page).getByRole('cell',{name:'published',exact:true})).toBeVisible({timeout:15000});
 await preparer.context.close();await controller.context.close();
});
// The planner and project manager roles have no reviewed template yet; the
// retention receivable and overhead accounts, the project profile, a
// November period and a posted customer collection with an unapplied
// remainder (the advance) are seeded through the domain. The bill against
// the order and the progress invoice's own review run through the domain
// so the journey stays on the planning screens.
async function seedPlanning(){
 const pg=createRequire(new URL('../../packages/database/package.json',import.meta.url))('pg');
 const {organization,identity,ledger,sales,inTransaction}=await import('../../packages/domain/src/index.mjs');
 const db=new pg.Client(connectionOptions(process.env.LARA_E2E_DATABASE_URL));await db.connect();
 try{
  const tenantId=(await db.query('select tenant_id from lara.principal_directory where oidc_subject=$1',[who('controller')])).rows[0].tenant_id;
  await db.query("select set_config('lara.tenant_id',$1,false)",[tenantId]);
  const principal=async role=>(await db.query('select principal_id from lara.principal_directory where oidc_subject=$1 and tenant_id=$2',[who(role),tenantId])).rows[0].principal_id;
  const hash=(await db.query("select encode(sha256(convert_to($1,'utf8')),'hex') as h",['planning'])).rows[0].h;
  const role=async(code,perms)=>(await db.query("insert into lara.roles(tenant_id,code,name,permissions,status,content_hash,created_by) values($1,$2,$2,$3,'approved',$4,$5) returning id",[tenantId,code,JSON.stringify(perms),hash,await principal('security')])).rows[0].id;
  const planner=await role('planner',['budget.create','budget.edit','budget.read','allocation_run.create','allocation_run.edit','allocation_run.read','allocation_run.preview','project.create','project.edit','project.read']);
  const pm=await role('project_manager',['budget.approve','budget.activate','budget.read','allocation_run.approve','allocation_run.post','allocation_run.read','project.read','project.progress_billing']);
  await db.query('insert into lara.memberships(tenant_id,principal_id,role_id,created_by) values($1,$2,$3,$4),($1,$5,$6,$4)',[tenantId,await principal('preparer'),planner,await principal('security'),await principal('controller'),pm]);
  const entity=(await db.query('select id from lara.entities where tenant_id=$1 order by created_at limit 1',[tenantId])).rows[0].id;
  const ctrlId=await principal('controller'),prepId=await principal('preparer'),billId=await principal('billing'),treId=await principal('treasury');
  await inTransaction(db,{tenantId,principalId:ctrlId},async tx=>{
   const ctxOf=async id=>({...await identity.actorContext(tx,tenantId,id),traceId:'seed-planning'});
   const ctrl=await ctxOf(ctrlId),prep=await ctxOf(prepId),bill=await ctxOf(billId),tre=await ctxOf(treId);
   const book=(await tx.query("select id from lara.books where tenant_id=$1 and entity_id=$2 and kind='primary'",[tenantId,entity])).rows[0].id;
   const retention=await ledger.createAccount(tx,prep,entity,{bookId:book,code:'1250',name:'Retention receivable',category:'asset',controlType:'none',requiredDimensions:[]});
   await ledger.createAccount(tx,prep,entity,{bookId:book,code:'5900',name:'Allocated overhead',category:'expense',controlType:'none',requiredDimensions:[]});
   const revenue=(await tx.query("select id from lara.accounts where tenant_id=$1 and entity_id=$2 and code='4000'",[tenantId,entity])).rows[0].id;
   const s=await organization.saveSettings(tx,ctrl,entity,'project_profile',{retentionReceivableAccountId:retention.id,revenueAccountId:revenue,retentionDueCondition:'Release on final acceptance',profileVersion:'project-2026'});
   await organization.approveSettings(tx,{...prep,permissions:new Set([...prep.permissions,'entity.activate'])},entity,s.id,{payloadHash:s.payloadHash});
   if(!(await tx.query("select 1 from lara.periods where tenant_id=$1 and entity_id=$2 and book_id=$3 and starts_on='2026-11-01'",[tenantId,entity,book])).rowCount)await ledger.createPeriod(tx,ctrl,entity,{bookId:book,startsOn:'2026-11-01',endsOn:'2026-11-30'});
   const customer=(await tx.query("select id from lara.party where tenant_id=$1 and entity_id=$2 and legal_name like 'Northwind Services%' order by created_at limit 1",[tenantId,entity])).rows[0].id;
   const rc=await sales.createCollection(tx,bill,entity,{direction:'receipt',partyId:customer,currency:'PHP',valueDate:'2026-11-02',grossAmount:'8000.00',cashAmount:'8000.00',withholdingAmount:'0.00',method:'transfer',allocations:[],evidenceIds:[]});
   await sales.submitCollection(tx,bill,entity,rc.id,{});await sales.approveCollection(tx,prep,entity,rc.id,{decision:'approve',contentVersion:1});await sales.postCollection(tx,prep,entity,rc.id,{});
  });
 }finally{await db.end();}
}
// The bill against the approved order (through the entity's own review) and the progress invoice's review are domain steps the earlier journeys already cover on screen.
async function postBillAgainstOrder(orderNet){
 const pg=createRequire(new URL('../../packages/database/package.json',import.meta.url))('pg');
 const {identity,purchasing,inTransaction}=await import('../../packages/domain/src/index.mjs');
 const db=new pg.Client(connectionOptions(process.env.LARA_E2E_DATABASE_URL));await db.connect();
 try{
  const tenantId=(await db.query('select tenant_id from lara.principal_directory where oidc_subject=$1',[who('controller')])).rows[0].tenant_id;
  await db.query("select set_config('lara.tenant_id',$1,false)",[tenantId]);
  const principal=async role=>(await db.query('select principal_id from lara.principal_directory where oidc_subject=$1 and tenant_id=$2',[who(role),tenantId])).rows[0].principal_id;
  const entity=(await db.query('select id from lara.entities where tenant_id=$1 order by created_at limit 1',[tenantId])).rows[0].id;
  const clerkId=await principal('clerk'),ctrlId=await principal('controller'),prepId=await principal('preparer');
  await inTransaction(db,{tenantId,principalId:ctrlId},async tx=>{
   const ctxOf=async id=>({...await identity.actorContext(tx,tenantId,id),traceId:'seed-planning'});
   const clerk=await ctxOf(clerkId),ctrl=await ctxOf(ctrlId),prep=await ctxOf(prepId);
   const order=(await tx.query("select d.*,(select account_id from lara.document_lines l where l.tenant_id=d.tenant_id and l.document_id=d.id order by line_no limit 1) as account_id from lara.documents d where d.tenant_id=$1 and d.entity_id=$2 and d.kind='purchase_order' and d.state='approved' and d.net=$3 order by d.created_at desc limit 1",[tenantId,entity,orderNet])).rows[0];
   const evidence=(await tx.query("select id from lara.evidence where tenant_id=$1 and entity_id=$2 and filename='registration.pdf'",[tenantId,entity])).rows[0].id;
   const b=await purchasing.createDocument(tx,clerk,entity,{kind:'bill',branchId:order.branch_id,bookId:order.book_id,partyId:order.party_id,documentDate:'2026-11-06',accountingDate:'2026-11-06',currency:'PHP',ruleProfileVersion:'ph-2026',externalReference:'SI-BUDGET-1',sourceDocumentId:order.id,lines:[{description:'Audit services',quantity:'1',unitPrice:orderNet,discount:'0',priceBasis:'exclusive',accountId:order.account_id,dimensions:{}}],evidenceIds:[evidence]});
   await purchasing.submitDocument(tx,clerk,entity,b.id,{});await purchasing.approveDocument(tx,ctrl,entity,b.id,{decision:'approve',contentVersion:1});await purchasing.postDocument(tx,prep,entity,b.id,{});
  });
 }finally{await db.end();}
}
async function reviewAndPostInvoice(invoiceId){
 const pg=createRequire(new URL('../../packages/database/package.json',import.meta.url))('pg');
 const {identity,sales,inTransaction}=await import('../../packages/domain/src/index.mjs');
 const db=new pg.Client(connectionOptions(process.env.LARA_E2E_DATABASE_URL));await db.connect();
 try{
  const tenantId=(await db.query('select tenant_id from lara.principal_directory where oidc_subject=$1',[who('controller')])).rows[0].tenant_id;
  await db.query("select set_config('lara.tenant_id',$1,false)",[tenantId]);
  const principal=async role=>(await db.query('select principal_id from lara.principal_directory where oidc_subject=$1 and tenant_id=$2',[who(role),tenantId])).rows[0].principal_id;
  const entity=(await db.query('select id from lara.entities where tenant_id=$1 order by created_at limit 1',[tenantId])).rows[0].id;
  const billId=await principal('billing'),prepId=await principal('preparer');
  await inTransaction(db,{tenantId,principalId:prepId},async tx=>{
   const ctxOf=async id=>({...await identity.actorContext(tx,tenantId,id),traceId:'seed-planning'});
   const bill=await ctxOf(billId),prep=await ctxOf(prepId);
   const row=(await tx.query('select content_version from lara.documents where tenant_id=$1 and id=$2',[tenantId,invoiceId])).rows[0];
   await sales.submitDocument(tx,bill,entity,invoiceId,{});await sales.approveDocument(tx,prep,entity,invoiceId,{decision:'approve',contentVersion:Number(row.content_version)});await sales.postDocument(tx,prep,entity,invoiceId,{});
  });
 }finally{await db.end();}
}
test('planning: capability activation, a budget version approved and activated with its availability, a purchase order blocked beyond the budget and approved with a recorded override, the commitment consumed by its bill, an allocation rule and run previewed, approved and posted once, a project with an approved contract, a certified milestone, an advance, progress billing with retention and recoupment, the retention released and a change order as the next version',async({browser})=>{
 test.setTimeout(600000);
 const controller=await as(browser,'controller'),preparer=await as(browser,'preparer'),clerk=await as(browser,'clerk');
 for(const who of [controller,preparer]){
  await who.page.goto('/settings/capabilities');await settled(who.page);
  const card=who.page.locator('section.demo-card').filter({hasText:'Budgets, cost allocation and project accounting'});
  await card.getByRole('combobox',{name:'Activation evidence'}).selectOption({label:'registration.pdf'});
  await card.getByLabel('Reason').fill(who===controller?'Budget basis and project profile approved':'Drivers and retention profile reviewed');
  await card.getByRole('button',{name:'Request or approve activation'}).click();
  await expect(who.page.locator('section[role="alert"]')).toHaveCount(0);
 }
 await seedPlanning();
 // Budget version: drafted by the planner, approved and activated by the project manager.
 await preparer.page.goto('/planning');await settled(preparer.page);
 await preparer.page.getByRole('textbox',{name:'Period start'}).fill('2026-11-01');await preparer.page.getByRole('textbox',{name:'Period end'}).fill('2026-11-30');
 await preparer.page.getByRole('combobox',{name:'Account 1'}).selectOption({label:'5000 Professional fees'});
 await preparer.page.getByRole('textbox',{name:'Amount 1'}).fill('10000');
 await preparer.page.getByRole('button',{name:'Save budget draft'}).click();
 const budgetRow=page=>page.getByRole('row').filter({hasText:'2026-11-01 → 2026-11-30'});
 await expect(budgetRow(preparer.page).getByRole('cell',{name:'draft',exact:true})).toBeVisible({timeout:15000});
 await expect(preparer.page.getByRole('button',{name:'Approve',exact:true})).toHaveCount(0);
 await controller.page.goto('/planning');await settled(controller.page);
 await budgetRow(controller.page).getByRole('button',{name:'Approve',exact:true}).click();
 await expect(budgetRow(controller.page).getByRole('cell',{name:'approved',exact:true})).toBeVisible({timeout:15000});
 await budgetRow(controller.page).getByRole('textbox',{name:'Reason'}).fill('Board approved');
 await budgetRow(controller.page).getByRole('button',{name:'Activate'}).click();
 await expect(budgetRow(controller.page).getByRole('cell',{name:'active',exact:true})).toBeVisible({timeout:15000});
 await budgetRow(controller.page).getByRole('button',{name:'Budget vs actual'}).click();
 await expect(controller.page.getByRole('row').filter({hasText:'5000 Professional fees'}).first()).toContainText('₱10,000.00',{timeout:15000});
 await noSeriousViolations(controller.page,'planning /planning');
 // A purchase order beyond the blocking budget: refused, then approved with the recorded override.
 await clerk.page.goto('/purchases/orders');await settled(clerk.page);
 await clerk.page.getByRole('combobox',{name:'Supplier'}).selectOption({label:'Supplies Inc'});
 await clerk.page.getByLabel('Document date').fill('2026-11-05');await clerk.page.getByLabel('Accounting date').fill('2026-11-05');
 await clerk.page.getByRole('textbox',{name:'Line 1 description'}).fill('Audit services');
 await clerk.page.getByRole('textbox',{name:'Line 1 unit price'}).fill('12000');
 await clerk.page.getByRole('combobox',{name:'Line 1 expense account'}).selectOption({label:'5000 Professional fees'});
 await clerk.page.getByRole('button',{name:'Save draft'}).click();
 const orderRow=page=>page.getByRole('row').filter({hasText:'Supplies Inc'}).filter({hasText:'₱12,000.00'});
 await expect(orderRow(clerk.page)).toBeVisible();
 await orderRow(clerk.page).getByRole('button',{name:'Submit'}).click();
 await expect(orderRow(clerk.page).getByRole('cell',{name:'submitted',exact:true})).toBeVisible();
 await controller.page.goto('/purchases/orders');await settled(controller.page);
 await orderRow(controller.page).getByRole('button',{name:'Approve',exact:true}).click();
 await expect(controller.page.locator('section[role="alert"]')).toContainText('Budget exceeded');
 await orderRow(controller.page).getByRole('textbox',{name:/Disposition/}).fill('Board-approved overrun for the audit');
 await orderRow(controller.page).getByRole('button',{name:'Approve',exact:true}).click();
 await expect(orderRow(controller.page).getByRole('cell',{name:'approved',exact:true})).toBeVisible({timeout:15000});
 await controller.page.goto('/planning');await settled(controller.page);
 await expect(controller.page.getByRole('row').filter({hasText:'override: Board-approved overrun'})).toBeVisible();
 await budgetRow(controller.page).getByRole('button',{name:'Budget vs actual'}).click();
 await expect(controller.page.getByRole('row').filter({hasText:'5000 Professional fees'}).first()).toContainText('-₱2,000.00',{timeout:15000});
 // The bill against the order consumes the commitment: committed 0, actual 12,000.
 await postBillAgainstOrder('12000');
 await controller.page.goto('/planning');await settled(controller.page);
 await expect(controller.page.getByRole('row').filter({hasText:'override: Board-approved overrun'}).getByRole('cell',{name:'consumed',exact:true})).toBeVisible();
 // Allocation: rule drafted by the planner, approved; run previewed with its lines, approved and posted once.
 await preparer.page.goto('/planning/allocations');await settled(preparer.page);
 await preparer.page.getByRole('checkbox',{name:'5000 Professional fees'}).check();
 await preparer.page.getByRole('combobox',{name:'Target account'}).selectOption({label:'5900 Allocated overhead'});
 const cc=[crypto.randomUUID(),crypto.randomUUID()];
 await preparer.page.getByRole('textbox',{name:'Driver 1 value id'}).fill(cc[0]);await preparer.page.getByRole('textbox',{name:'Driver 1 weight'}).fill('2');
 await preparer.page.getByRole('textbox',{name:'Driver 2 value id'}).fill(cc[1]);await preparer.page.getByRole('textbox',{name:'Driver 2 weight'}).fill('1');
 await preparer.page.getByRole('button',{name:'Save rule draft'}).click();
 const ruleRow=page=>page.getByRole('row').filter({has:page.getByRole('cell',{name:'OVH',exact:true})});
 await expect(ruleRow(preparer.page).getByRole('cell',{name:'draft',exact:true})).toBeVisible({timeout:15000});
 await controller.page.goto('/planning/allocations');await settled(controller.page);
 await ruleRow(controller.page).getByRole('button',{name:'Approve rule'}).click();
 await expect(ruleRow(controller.page).getByRole('cell',{name:'approved',exact:true})).toBeVisible({timeout:15000});
 await preparer.page.goto('/planning/allocations');await settled(preparer.page);
 await preparer.page.getByRole('combobox',{name:'Rule version'}).selectOption({label:'OVH v1'});
 await pickOption(preparer.page.getByRole('combobox',{name:'Period'}),/2026-11-01 → 2026-11-30/);
 await preparer.page.getByRole('textbox',{name:'Source cutoff (postings up to end of day)'}).fill('2026-12-05');
 await preparer.page.getByRole('combobox',{name:'Driver evidence'}).selectOption({label:'registration.pdf'});
 await preparer.page.getByRole('button',{name:'Create run'}).click();
 const runRow=page=>page.getByRole('row').filter({hasText:'OVH v1'}).filter({has:page.getByRole('button',{name:'Lines'})});
 await expect(runRow(preparer.page).getByRole('cell',{name:'draft',exact:true})).toBeVisible({timeout:15000});
 await runRow(preparer.page).getByRole('button',{name:'Preview'}).click();
 await expect(runRow(preparer.page).getByRole('cell',{name:'previewed',exact:true})).toBeVisible({timeout:15000});
 await runRow(preparer.page).getByRole('button',{name:'Lines'}).click();
 await expect(preparer.page.getByRole('heading',{name:/Run lines · pool ₱12,000\.00/})).toBeVisible({timeout:15000});
 await expect(preparer.page.getByRole('row').filter({hasText:'₱8,000.00'})).toBeVisible();await expect(preparer.page.getByRole('row').filter({hasText:'₱4,000.00'})).toBeVisible();
 await noSeriousViolations(preparer.page,'planning /planning/allocations');
 await controller.page.goto('/planning/allocations');await settled(controller.page);
 await runRow(controller.page).getByRole('button',{name:'Approve',exact:true}).click();
 await expect(runRow(controller.page).getByRole('cell',{name:'approved',exact:true})).toBeVisible({timeout:15000});
 await runRow(controller.page).getByRole('button',{name:'Post',exact:true}).click();
 await expect(runRow(controller.page).getByRole('cell',{name:'posted',exact:true})).toBeVisible({timeout:15000});
 // Project: contract approved, milestone certified, advance, progress billing, retention, release, change order.
 await preparer.page.goto('/planning/projects');await settled(preparer.page);
 await preparer.page.getByRole('textbox',{name:'Code',exact:true}).fill('TOWER');
 await pickOption(preparer.page.getByRole('combobox',{name:'Customer'}),/Northwind Services/);
 await preparer.page.getByRole('textbox',{name:'Contract amount'}).fill('100000');
 await preparer.page.getByRole('combobox',{name:'Contract evidence'}).selectOption({label:'registration.pdf'});
 await preparer.page.getByRole('button',{name:'Open project'}).click();
 const projectRow=page=>page.getByRole('row').filter({has:page.getByRole('cell',{name:'TOWER',exact:true})});
 await expect(projectRow(preparer.page)).toBeVisible({timeout:15000});
 await projectRow(preparer.page).getByRole('button',{name:'Open'}).click();
 await preparer.page.getByRole('textbox',{name:'Milestone'}).fill('Foundation');
 const msForm=preparer.page.locator('form').filter({has:preparer.page.getByRole('button',{name:'Add milestone'})});
 await msForm.getByRole('textbox',{name:'Amount',exact:true}).fill('40000');
 await msForm.getByRole('button',{name:'Add milestone'}).click();
 await expect(preparer.page.getByRole('row').filter({hasText:'Foundation'})).toBeVisible({timeout:15000});
 await pickOption(preparer.page.getByRole('combobox',{name:'Posted collection'}),/2026-11-02 · PHP 8000\.00/);
 const advForm=preparer.page.locator('form').filter({has:preparer.page.getByRole('button',{name:'Record advance'})});
 await advForm.getByRole('textbox',{name:'Amount',exact:true}).fill('8000');
 await advForm.getByRole('button',{name:'Record advance'}).click();
 await expect(preparer.page.getByRole('row').filter({hasText:'₱8,000.00'}).first()).toBeVisible({timeout:15000});
 await controller.page.goto('/planning/projects');await settled(controller.page);
 await projectRow(controller.page).getByRole('button',{name:'Open'}).click();
 await controller.page.getByRole('button',{name:'Approve version'}).click();
 await expect(controller.page.getByRole('row').filter({hasText:'Original contract'}).getByRole('cell',{name:'approved',exact:true})).toBeVisible({timeout:15000});
 const milestoneRow=controller.page.getByRole('row').filter({hasText:'Foundation'});
 await milestoneRow.getByRole('textbox',{name:'Certified value'}).fill('30000');
 await milestoneRow.getByRole('combobox',{name:'Certificate'}).selectOption({label:'registration.pdf'});
 await milestoneRow.getByRole('button',{name:'Certify'}).click();
 await expect(controller.page.getByRole('row').filter({hasText:'Foundation'}).getByRole('cell',{name:'certified',exact:true})).toBeVisible({timeout:15000});
 await controller.page.getByRole('combobox',{name:'Milestone',exact:true}).selectOption({index:1});
 await controller.page.getByRole('textbox',{name:'Certified amount to bill'}).fill('30000');
 await controller.page.getByRole('textbox',{name:'Retention held'}).fill('3000');
 await controller.page.getByRole('textbox',{name:'Advance recoupment'}).fill('5000');
 await controller.page.getByRole('textbox',{name:'Accounting date'}).first().fill('2026-11-20');
 await controller.page.getByRole('combobox',{name:'Progress certificate'}).selectOption({label:'registration.pdf'});
 await controller.page.getByRole('button',{name:'Draft progress invoice'}).click();
 await expect(controller.page.getByRole('row').filter({hasText:'Foundation'}).getByRole('cell',{name:'billed',exact:true})).toBeVisible({timeout:20000});
 await expect(controller.page.getByRole('row').filter({hasText:'Foundation'})).toContainText('₱30,000.00');
 const invoiceId=await (async()=>{const pg=createRequire(new URL('../../packages/database/package.json',import.meta.url))('pg');const db=new pg.Client(connectionOptions(process.env.LARA_E2E_DATABASE_URL));await db.connect();try{const tenantId=(await db.query('select tenant_id from lara.principal_directory where oidc_subject=$1',[who('controller')])).rows[0].tenant_id;await db.query("select set_config('lara.tenant_id',$1,false)",[tenantId]);return (await db.query("select invoice_id from lara.project_billings where tenant_id=$1 order by created_at desc limit 1",[tenantId])).rows[0].invoice_id;}finally{await db.end();}})();
 await reviewAndPostInvoice(invoiceId);
 await controller.page.goto('/planning/projects');await settled(controller.page);
 await projectRow(controller.page).getByRole('button',{name:'Open'}).click();
 await expect(controller.page.getByRole('row').filter({hasText:'Release on final acceptance'})).toContainText('₱3,000.00',{timeout:15000});
 await expect(controller.page.getByRole('status').filter({hasText:'Contract'})).toContainText('advances recouped ₱5,000.00');
 await expect(controller.page.getByRole('status').filter({hasText:'Contract'})).toContainText('revenue posted ₱30,000.00');
 const retentionRow=controller.page.getByRole('row').filter({hasText:'Release on final acceptance'});
 await retentionRow.getByRole('textbox',{name:'Reason'}).fill('Final acceptance signed');
 await retentionRow.getByRole('combobox',{name:'Acceptance evidence'}).selectOption({label:'registration.pdf'});
 await retentionRow.getByRole('button',{name:'Release'}).click();
 await expect(controller.page.getByRole('row').filter({hasText:'Release on final acceptance'})).toContainText('release invoice drafted',{timeout:15000});
 await noSeriousViolations(controller.page,'planning /planning/projects');
 // Change order: the next contract version, approved by the project manager; the earlier billing stands.
 await preparer.page.goto('/planning/projects');await settled(preparer.page);
 await projectRow(preparer.page).getByRole('button',{name:'Open'}).click();
 await preparer.page.getByRole('textbox',{name:'New contract amount'}).fill('120000');
 await preparer.page.getByRole('textbox',{name:'Reason'}).first().fill('Additional floor');
 await preparer.page.getByRole('combobox',{name:'Change order evidence'}).selectOption({label:'registration.pdf'});
 await preparer.page.getByRole('button',{name:'Draft change order'}).click();
 await expect(preparer.page.getByRole('row').filter({hasText:'Additional floor'}).getByRole('cell',{name:'draft',exact:true})).toBeVisible({timeout:15000});
 await controller.page.goto('/planning/projects');await settled(controller.page);
 await projectRow(controller.page).getByRole('button',{name:'Open'}).click();
 await controller.page.getByRole('row').filter({hasText:'Additional floor'}).getByRole('button',{name:'Approve version'}).click();
 await expect(controller.page.getByRole('row').filter({hasText:'Additional floor'}).getByRole('cell',{name:'approved',exact:true})).toBeVisible({timeout:15000});
 await expect(controller.page.getByRole('status').filter({hasText:'Contract'})).toContainText('₱120,000.00 (v2)');
 await expect(controller.page.getByRole('status').filter({hasText:'Contract'})).toContainText('billed ₱30,000.00');
 await preparer.context.close();await controller.context.close();await clerk.context.close();
});
// The local operations roles have no reviewed template yet; the profiles
// each feature rests on (recurring billing policy, lease withholding and
// lease profiles, the senior citizen discount profile, the payroll profile,
// the authority profile), the accounts they name, the rent template and its
// recurring schedule, the imported channel sales, a cash deposit and a
// draft invoice for the discount are seeded through the domain. Four of the
// five features are activated through the domain; lease billing on screen.
async function seedLocalOps(){
 const pg=createRequire(new URL('../../packages/database/package.json',import.meta.url))('pg');
 const {organization,identity,ledger,sales,assets,inTransaction}=await import('../../packages/domain/src/index.mjs');
 const db=new pg.Client(connectionOptions(process.env.LARA_E2E_DATABASE_URL));await db.connect();
 try{
  const tenantId=(await db.query('select tenant_id from lara.principal_directory where oidc_subject=$1',[who('controller')])).rows[0].tenant_id;
  await db.query("select set_config('lara.tenant_id',$1,false)",[tenantId]);
  const principal=async role=>(await db.query('select principal_id from lara.principal_directory where oidc_subject=$1 and tenant_id=$2',[who(role),tenantId])).rows[0].principal_id;
  const hash=(await db.query("select encode(sha256(convert_to($1,'utf8')),'hex') as h",['local'])).rows[0].h;
  const role=async(code,perms)=>(await db.query("insert into lara.roles(tenant_id,code,name,permissions,status,content_hash,created_by) values($1,$2,$2,$3,'approved',$4,$5) returning id",[tenantId,code,JSON.stringify(perms),hash,await principal('security')])).rows[0].id;
  const ops=await role('local_ops',['lease.create','lease.edit','lease.read','discount_eligibility.create','discount_eligibility.edit','discount_eligibility.read','channel.create','channel.read','payout.create','payout.read','pos_closing.create','pos_closing.read','payroll_batch.create','payroll_batch.read','remittance.create','remittance.read','local_obligation.create','local_obligation.edit','local_obligation.read','schedule.create','schedule.read']);
  const reviewer=await role('local_reviewer',['lease.approve','lease.edit','lease.read','discount_eligibility.approve','discount_eligibility.read','channel.read','payout.read','payout.reconcile','payout.post','pos_closing.read','pos_closing.approve','payroll_batch.read','payroll_batch.approve','payroll_batch.post','payroll_record.read','remittance.read','remittance.approve','local_obligation.read','local_obligation.complete','schedule.read']);
  await db.query('insert into lara.memberships(tenant_id,principal_id,role_id,created_by) values($1,$2,$3,$4),($1,$5,$6,$4)',[tenantId,await principal('preparer'),ops,await principal('security'),await principal('controller'),reviewer]);
  const entity=(await db.query('select id from lara.entities where tenant_id=$1 order by created_at limit 1',[tenantId])).rows[0].id;
  const ctrlId=await principal('controller'),prepId=await principal('preparer'),billId=await principal('billing'),treId=await principal('treasury');
  let salesEntry=null;
  await inTransaction(db,{tenantId,principalId:ctrlId},async tx=>{
   const ctxOf=async id=>({...await identity.actorContext(tx,tenantId,id),traceId:'seed-local'});
   const ctrl=await ctxOf(ctrlId),prep=await ctxOf(prepId),bill=await ctxOf(billId),tre=await ctxOf(treId);
   for(const cap of ['statutory_discounts','marketplace_pos','payroll_data','local_obligations'])await tx.query("insert into lara.capability_activations(tenant_id,entity_id,capability,status,profile_version,approved_by,activated_at,created_by) values($1,$2,$3,'active','p17.1',$4,now(),$5)",[tenantId,entity,cap,prepId,ctrlId]);
   const book=(await tx.query("select id from lara.books where tenant_id=$1 and entity_id=$2 and kind='primary'",[tenantId,entity])).rows[0].id;
   const branch=(await tx.query("select id from lara.branches where tenant_id=$1 and entity_id=$2 and code='HQ'",[tenantId,entity])).rows[0].id;
   const acctId=async code=>(await tx.query("select id from lara.accounts where tenant_id=$1 and entity_id=$2 and code=$3",[tenantId,entity,code])).rows[0]?.id;
   const mk=async(code,name,category)=>(await acctId(code))||(await ledger.createAccount(tx,prep,entity,{bookId:book,code,name,category,controlType:'none',requiredDimensions:[]})).id;
   const deposits=await mk('2400','Lease deposits held','liability'),advances=await mk('2410','Rent in advance','liability'),channelAr=await mk('1210','Marketplace receivable','asset'),cwt=await mk('1350','Creditable withholding','asset'),clearing=await mk('1025','Payout clearing','asset'),sss=await mk('2510','SSS payable','liability'),ph=await mk('2520','PhilHealth payable','liability'),pi=await mk('2530','Pag-IBIG payable','liability'),netPay=await mk('2540','Salaries payable','liability'),salaries=await mk('5150','Salaries','expense'),fees=await mk('5350','Platform fees','expense');
   const revenue=await acctId('4000'),cash=await acctId('1010'),whtPay=(await acctId('2300'))||await mk('2300','Withholding payable','liability');
   const settle=async(kind,payload)=>{const s=await organization.saveSettings(tx,ctrl,entity,kind,payload);await organization.approveSettings(tx,{...prep,permissions:new Set([...prep.permissions,'entity.activate'])},entity,s.id,{payloadHash:s.payloadHash});};
   await settle('recognition_policy_monthly_billing',{code:'monthly_billing',kind:'recurring_invoice'});
   await settle('lease_withholding_profile',{profileVersion:'lease-wht-2026',rates:{corporate:'0.05'}});
   await settle('lease_profile',{depositLiabilityAccountId:deposits,advanceLiabilityAccountId:advances,cashAccountId:cash});
   await settle('discount_profile_senior_citizen',{profileVersion:'sc-2026',rate:'0.2',basis:'net',eligibleAccountIds:[revenue],exemptionProfile:'vat-exempt-sc',requiredEvidence:['osca_id'],goldenCases:[{id:'SC-01',match:'any'}]});
   await settle('payroll_profile',{salaryExpenseAccountId:salaries,withholdingPayableAccountId:whtPay,sssPayableAccountId:sss,philhealthPayableAccountId:ph,pagibigPayableAccountId:pi,netPayableAccountId:netPay});
   await settle('local_authority_profile',{authority:'Makati City',profileVersion:'lgu-2026',kinds:['business_permit','local_business_tax','real_property_tax'],filingRequired:['business_permit']});
   const customer=(await tx.query("select id from lara.party where tenant_id=$1 and entity_id=$2 and legal_name like 'Northwind Services%' order by created_at limit 1",[tenantId,entity])).rows[0].id;
   if(!(await tx.query("select 1 from lara.periods where tenant_id=$1 and entity_id=$2 and book_id=$3 and starts_on='2026-12-01'",[tenantId,entity,book])).rowCount)await ledger.createPeriod(tx,ctrl,entity,{bookId:book,startsOn:'2026-12-01',endsOn:'2026-12-31'});
   const template=await sales.createDocument(tx,bill,entity,{kind:'invoice',branchId:branch,bookId:book,partyId:customer,documentDate:'2026-11-03',accountingDate:'2026-11-03',currency:'PHP',ruleProfileVersion:'ph-2026',lines:[{description:'Monthly rent',quantity:'1',unitPrice:'20000',discount:'0',priceBasis:'exclusive',accountId:revenue,dimensions:{}}],evidenceIds:[]});
   await assets.createSchedule(tx,prep,entity,{kind:'recurring_invoice',sourceId:template.id,startDate:'2026-12-01',endDate:'2027-11-30',basisAmount:'20000',currency:'PHP',policyVersion:'monthly_billing'});
   await sales.createDocument(tx,bill,entity,{kind:'invoice',branchId:branch,bookId:book,partyId:customer,documentDate:'2026-11-04',accountingDate:'2026-11-04',currency:'PHP',ruleProfileVersion:'ph-2026',externalReference:'SC-DRAFT',lines:[{description:'Consultation',quantity:'1',unitPrice:'1000',discount:'0',priceBasis:'exclusive',accountId:revenue,dimensions:{}}],evidenceIds:[]});
   const acc=await ctxOf(prepId);
   const j=await ledger.createJournal(tx,acc,entity,{bookId:book,accountingDate:'2026-11-15',documentDate:'2026-11-15',currency:'PHP',description:'ShopCo sales 1–15 Nov',lines:[{accountId:channelAr,branchId:branch,debit:'10000.00',credit:'0',dimensions:{}},{accountId:revenue,branchId:branch,debit:'0',credit:'10000.00',dimensions:{}}],evidenceIds:[]});
   await ledger.submitJournal(tx,acc,entity,j.id,{});await ledger.approveJournal(tx,ctrl,entity,j.id,{decision:'approve',contentVersion:1});salesEntry=(await ledger.postJournal(tx,ctrl,entity,j.id,{})).journalEntryIds[0];
   const rc=await sales.createCollection(tx,bill,entity,{direction:'receipt',partyId:customer,currency:'PHP',valueDate:'2026-11-21',grossAmount:'3000.00',cashAmount:'3000.00',withholdingAmount:'0.00',method:'cash',allocations:[],evidenceIds:[]});
   await sales.submitCollection(tx,bill,entity,rc.id,{});await sales.approveCollection(tx,prep,entity,rc.id,{decision:'approve',contentVersion:1});await sales.postCollection(tx,prep,entity,rc.id,{});
  });
  return salesEntry;
 }finally{await db.end();}
}
test('local operations: lease billing activated on screen and the other four features seeded; a lease approved, scheduled, billed and its deposit received; an eligibility approved and the discount applied to a draft invoice; a channel payout reconciled and posted and a POS closing matched; a payroll batch approved and posted with its remittance; a local obligation completed on evidence',async({browser})=>{
 test.setTimeout(600000);
 const controller=await as(browser,'controller'),preparer=await as(browser,'preparer');
 for(const who of [controller,preparer]){
  await who.page.goto('/settings/capabilities');await settled(who.page);
  const card=who.page.locator('section.demo-card').filter({hasText:'Lease billing'});
  await card.getByRole('combobox',{name:'Activation evidence'}).selectOption({label:'registration.pdf'});
  await card.getByLabel('Reason').fill(who===controller?'Lease accounting examples reviewed':'Withholding and deposit treatment reviewed');
  await card.getByRole('button',{name:'Request or approve activation'}).click();
  await expect(who.page.locator('section[role="alert"]')).toHaveCount(0);
 }
 const salesEntry=await seedLocalOps();
 // Leases.
 await preparer.page.goto('/local');await settled(preparer.page);
 await pickOption(preparer.page.getByRole('combobox',{name:'Lessee'}),/Northwind Services/);
 await preparer.page.getByRole('textbox',{name:'Term start'}).fill('2026-12-01');await preparer.page.getByRole('textbox',{name:'Term end'}).fill('2027-11-30');
 await preparer.page.getByRole('textbox',{name:'Deposit',exact:true}).fill('40000');
 await pickOption(preparer.page.getByRole('combobox',{name:/Billing schedule/}),/recurring_invoice PHP 20000/);
 await preparer.page.getByRole('textbox',{name:'Escalation 1 from'}).fill('2027-06-01');await preparer.page.getByRole('textbox',{name:'Escalation 1 rate'}).fill('0.05');
 await preparer.page.getByRole('combobox',{name:'Signed lease'}).selectOption({label:'registration.pdf'});
 await preparer.page.getByRole('button',{name:'Save lease draft'}).click();
 const leaseRow=page=>page.getByRole('row').filter({hasText:'Northwind Services'}).filter({hasText:'2026-12-01 → 2027-11-30'});
 await expect(leaseRow(preparer.page).getByRole('cell',{name:'draft',exact:true})).toBeVisible({timeout:15000});
 await controller.page.goto('/local');await settled(controller.page);
 await leaseRow(controller.page).getByRole('button',{name:'Approve'}).click();
 await expect(leaseRow(controller.page).getByRole('cell',{name:'approved',exact:true})).toBeVisible({timeout:15000});
 await leaseRow(controller.page).getByRole('button',{name:'Open'}).click();
 await expect(controller.page.getByRole('heading',{name:/Rent schedule · total ₱246,000\.00/})).toBeVisible({timeout:15000});
 await controller.page.getByRole('row').filter({hasText:'2026-12-01 → 2026-12-31'}).getByRole('button',{name:'Bill'}).click();
 await expect(controller.page.getByRole('row').filter({hasText:'2026-12-01 → 2026-12-31'}).getByRole('cell',{name:'yes',exact:true})).toBeVisible({timeout:15000});
 await controller.page.getByRole('textbox',{name:'Amount',exact:true}).fill('40000');
 await controller.page.getByRole('textbox',{name:'Date',exact:true}).fill('2026-12-02');
 await controller.page.getByRole('combobox',{name:'Bank or cash evidence'}).selectOption({label:'registration.pdf'});
 await controller.page.getByRole('button',{name:'Record event'}).click();
 await expect(controller.page.getByRole('row').filter({hasText:'deposit received'})).toContainText('₱40,000.00',{timeout:15000});
 await noSeriousViolations(controller.page,'local /local');
 // Statutory discounts.
 await preparer.page.goto('/local/discounts');await settled(preparer.page);
 await pickOption(preparer.page.getByRole('combobox',{name:'Customer'}),/Northwind Services/);
 await preparer.page.getByRole('textbox',{name:'Valid until'}).fill('2027-12-31');
 await preparer.page.getByRole('textbox',{name:'ID reference (stored masked)'}).fill('OSCA-123456');
 await preparer.page.getByRole('combobox',{name:'Identity evidence'}).selectOption({label:'registration.pdf'});
 await preparer.page.getByRole('button',{name:'Save eligibility'}).click();
 const eligRow=page=>page.getByRole('row').filter({hasText:'senior_citizen'});
 await expect(eligRow(preparer.page).getByRole('cell',{name:'draft',exact:true})).toBeVisible({timeout:15000});
 await expect(eligRow(preparer.page)).toContainText('*******3456');
 await controller.page.goto('/local/discounts');await settled(controller.page);
 await eligRow(controller.page).getByRole('button',{name:'Approve'}).click();
 await expect(eligRow(controller.page).getByRole('cell',{name:'approved',exact:true})).toBeVisible({timeout:15000});
 await pickOption(controller.page.getByRole('combobox',{name:'Draft invoice'}),/1000\.00 · draft/);
 await controller.page.getByRole('button',{name:'Apply statutory discount'}).click();
 await expect(controller.page.getByRole('row').filter({hasText:'SC-01'})).toContainText('₱200.00',{timeout:15000});
 await noSeriousViolations(controller.page,'local /local/discounts');
 // Channels: payout and POS.
 await preparer.page.goto('/local/channels');await settled(preparer.page);
 await preparer.page.getByRole('textbox',{name:'Code',exact:true}).fill('SHOP');await preparer.page.getByRole('textbox',{name:'Name',exact:true}).fill('ShopCo');await preparer.page.getByRole('textbox',{name:'Provider'}).fill('ShopCo');
 await preparer.page.getByRole('combobox',{name:/Channel receivable/}).selectOption({label:'1210 Marketplace receivable'});
 await preparer.page.getByRole('combobox',{name:'Platform fees'}).selectOption({label:'5350 Platform fees'});
 await preparer.page.getByRole('combobox',{name:/Tax withheld by the platform/}).selectOption({label:'1350 Creditable withholding'});
 await preparer.page.getByRole('combobox',{name:/Payout clearing/}).selectOption({label:'1025 Payout clearing'});
 await preparer.page.getByRole('button',{name:'Register channel'}).click();
 await expect(preparer.page.getByRole('cell',{name:'SHOP',exact:true})).toBeVisible({timeout:15000});
 await preparer.page.getByRole('textbox',{name:'Statement reference'}).fill('STM-2026-11-A');
 await preparer.page.getByRole('textbox',{name:'Period start'}).fill('2026-11-01');await preparer.page.getByRole('textbox',{name:'Period end'}).fill('2026-11-15');
 await preparer.page.getByRole('textbox',{name:'Gross sales'}).fill('10000');await preparer.page.getByRole('textbox',{name:'Platform fees'}).fill('500');await preparer.page.getByRole('textbox',{name:'Tax withheld'}).fill('100');await preparer.page.getByRole('textbox',{name:'Net payout'}).fill('9400');
 await preparer.page.getByRole('combobox',{name:'Statement evidence'}).selectOption({label:'registration.pdf'});
 await preparer.page.getByRole('button',{name:'Record payout'}).click();
 const payoutRow=page=>page.getByRole('row').filter({hasText:'STM-2026-11-A'});
 await expect(payoutRow(preparer.page)).toContainText('imported',{timeout:15000});
 await controller.page.goto('/local/channels');await settled(controller.page);
 await payoutRow(controller.page).getByRole('textbox',{name:/Imported sales ids/}).fill(salesEntry);
 await payoutRow(controller.page).getByRole('button',{name:'Reconcile'}).click();
 await expect(payoutRow(controller.page)).toContainText('reconciled',{timeout:15000});
 await payoutRow(controller.page).getByRole('button',{name:'Post',exact:true}).click();
 await expect(payoutRow(controller.page)).toContainText('posted',{timeout:15000});
 await preparer.page.goto('/local/channels');await settled(preparer.page);
 await preparer.page.getByRole('textbox',{name:'Brand'}).fill('Acme');await preparer.page.getByRole('textbox',{name:'Model'}).fill('X1');await preparer.page.getByRole('textbox',{name:'Serial number'}).fill('SN-001');await preparer.page.getByRole('textbox',{name:'MIN'}).fill('MIN-001');await preparer.page.getByRole('textbox',{name:'Permit number'}).fill('PTU-2026-1');
 await expect(preparer.page.getByRole('combobox',{name:'Branch'})).toHaveValue(/./);
 await preparer.page.getByRole('button',{name:'Register machine'}).click();
 await expect(preparer.page.getByRole('cell',{name:'SN-001',exact:true})).toBeVisible({timeout:15000});
 await preparer.page.getByRole('textbox',{name:'Shift date'}).fill('2026-11-20');
 await preparer.page.getByRole('textbox',{name:'Beginning reading'}).fill('100000');await preparer.page.getByRole('textbox',{name:'Ending reading'}).fill('103500');await preparer.page.getByRole('textbox',{name:'Cash counted'}).fill('3000');
 await preparer.page.getByRole('combobox',{name:'Reading tape'}).selectOption({label:'registration.pdf'});
 await preparer.page.getByRole('button',{name:'Record closing'}).click();
 const closingRow=page=>page.getByRole('row').filter({hasText:'2026-11-20 #1'});
 await expect(closingRow(preparer.page)).toContainText('₱3,500.00',{timeout:15000});
 await controller.page.goto('/local/channels');await settled(controller.page);
 await closingRow(controller.page).getByRole('button',{name:'Approve'}).click();
 await expect(closingRow(controller.page)).toContainText('approved',{timeout:15000});
 await pickOption(closingRow(controller.page).getByRole('combobox',{name:'Posted deposit'}),/2026-11-21 · 3000\.00/);
 await closingRow(controller.page).getByRole('button',{name:'Match deposit'}).click();
 await expect(closingRow(controller.page)).toContainText('matched',{timeout:15000});
 await noSeriousViolations(controller.page,'local /local/channels');
 // Payroll.
 await preparer.page.goto('/local/payroll');await settled(preparer.page);
 await preparer.page.getByRole('textbox',{name:'Source system'}).fill('PayrollCo');await preparer.page.getByRole('textbox',{name:'Period',exact:true}).first().fill('2026-11');
 await preparer.page.getByRole('textbox',{name:'Gross total'}).fill('50000');await preparer.page.getByRole('textbox',{name:'Withholding total'}).fill('3500');await preparer.page.getByRole('textbox',{name:'SSS total'}).fill('2250');await preparer.page.getByRole('textbox',{name:'PhilHealth total'}).fill('1000');await preparer.page.getByRole('textbox',{name:'Pag-IBIG total'}).fill('400');await preparer.page.getByRole('textbox',{name:'Net total'}).fill('42850');
 await preparer.page.getByRole('textbox',{name:/Records/}).fill('EMP-0001,30000,2500,1350,600,200,25350\nEMP-0002,20000,1000,900,400,200,17500');
 await preparer.page.getByRole('combobox',{name:'Payroll register'}).selectOption({label:'registration.pdf'});
 await preparer.page.getByRole('button',{name:'Import batch'}).click();
 const batchRow=page=>page.getByRole('row').filter({hasText:'PayrollCo'}).filter({hasText:'2026-11'});
 await expect(batchRow(preparer.page)).toContainText('reconciled',{timeout:15000});
 await expect(preparer.page.getByRole('button',{name:'Records'})).toHaveCount(0);
 await controller.page.goto('/local/payroll');await settled(controller.page);
 await batchRow(controller.page).getByRole('button',{name:'Records'}).click();
 await expect(controller.page.getByRole('cell',{name:'****0001',exact:true})).toBeVisible({timeout:15000});
 await batchRow(controller.page).getByRole('button',{name:'Approve'}).click();
 await expect(batchRow(controller.page)).toContainText('approved',{timeout:15000});
 await batchRow(controller.page).getByRole('button',{name:'Post journal'}).click();
 await expect(batchRow(controller.page)).toContainText('posted',{timeout:15000});
 await preparer.page.goto('/local/payroll');await settled(preparer.page);
 await preparer.page.getByRole('combobox',{name:'Batch'}).selectOption({index:1});
 await preparer.page.getByRole('textbox',{name:'Period',exact:true}).nth(1).fill('2026-11');
 await preparer.page.getByRole('textbox',{name:'Amount',exact:true}).fill('2250');await preparer.page.getByRole('textbox',{name:'Due date'}).fill('2026-12-15');
 await preparer.page.getByRole('button',{name:'Record remittance due'}).click();
 const remitRow=page=>page.getByRole('row').filter({hasText:'SSS'}).filter({hasText:'2026-11'});
 await expect(remitRow(preparer.page)).toContainText('due',{timeout:15000});
 await controller.page.goto('/local/payroll');await settled(controller.page);
 await remitRow(controller.page).getByRole('button',{name:'Approve'}).click();
 await expect(remitRow(controller.page)).toContainText('approved',{timeout:15000});
 await remitRow(controller.page).getByRole('textbox',{name:'Remittance reference'}).fill('SSS-PRN-2026-11');
 await remitRow(controller.page).getByRole('combobox',{name:'Payment evidence'}).selectOption({label:'registration.pdf'});
 await remitRow(controller.page).getByRole('button',{name:'Record remittance'}).click();
 await expect(remitRow(controller.page)).toContainText('remitted',{timeout:15000});
 await noSeriousViolations(controller.page,'local /local/payroll');
 // Local obligations.
 await preparer.page.goto('/local/obligations');await settled(preparer.page);
 await preparer.page.getByRole('textbox',{name:'Authority',exact:true}).fill('Makati City');await preparer.page.getByRole('textbox',{name:'Authority profile version'}).fill('lgu-2026');
 await preparer.page.getByRole('textbox',{name:'Period',exact:true}).fill('2027');await preparer.page.getByRole('textbox',{name:'Due date'}).fill('2027-01-20');await preparer.page.getByRole('textbox',{name:'Amount',exact:true}).fill('8000');
 await preparer.page.getByRole('checkbox',{name:'Filing evidence required'}).check();
 await preparer.page.getByRole('button',{name:'Record obligation'}).click();
 const obRow=page=>page.getByRole('row').filter({hasText:'business permit'});
 await expect(obRow(preparer.page)).toContainText('open',{timeout:15000});
 await controller.page.goto('/local/obligations');await settled(controller.page);
 await obRow(controller.page).getByRole('combobox',{name:'Payment evidence'}).selectOption({label:'registration.pdf'});
 await obRow(controller.page).getByRole('button',{name:'Complete'}).click();
 await expect(controller.page.locator('section[role="alert"]')).toContainText('filing evidence');
 await obRow(controller.page).getByRole('combobox',{name:'Filing evidence'}).selectOption({label:'registration.pdf'});
 await obRow(controller.page).getByRole('button',{name:'Complete'}).click();
 await expect(obRow(controller.page)).toContainText('complete',{timeout:15000});
 await noSeriousViolations(controller.page,'local /local/obligations');
 await preparer.context.close();await controller.context.close();
});
// The extensibility roles have no reviewed template yet: the preparer is
// the builder (definitions, custom fields, proposals, grants, packs) and the
// controller the independent reviewer (publication, approval, revocation).
// Three of the four features are activated through the domain; report
// authoring on screen. A draft VAT rule version, the proposal that cites it
// and a client integration without membership are seeded through the domain.
async function seedExtend(){
 const pg=createRequire(new URL('../../packages/database/package.json',import.meta.url))('pg');
 const {identity,extensibility,inTransaction}=await import('../../packages/domain/src/index.mjs');
 const {accountingCases}=await import('../../packages/contracts/src/index.mjs');
 const db=new pg.Client(connectionOptions(process.env.LARA_E2E_DATABASE_URL));await db.connect();
 try{
  const tenantId=(await db.query('select tenant_id from lara.principal_directory where oidc_subject=$1',[who('controller')])).rows[0].tenant_id;
  await db.query("select set_config('lara.tenant_id',$1,false)",[tenantId]);
  const principal=async role=>(await db.query('select principal_id from lara.principal_directory where oidc_subject=$1 and tenant_id=$2',[who(role),tenantId])).rows[0].principal_id;
  const issuer=(await db.query('select oidc_issuer from lara.principal_directory where oidc_subject=$1 and tenant_id=$2',[who('controller'),tenantId])).rows[0].oidc_issuer;
  const hash=(await db.query("select encode(sha256(convert_to($1,'utf8')),'hex') as h",['extend'])).rows[0].h;
  const role=async(code,perms)=>(await db.query("insert into lara.roles(tenant_id,code,name,permissions,status,content_hash,created_by) values($1,$2,$2,$3,'approved',$4,$5) returning id",[tenantId,code,JSON.stringify(perms),hash,await principal('security')])).rows[0].id;
  const builder=await role('builder',['report_definition.create','report_definition.edit','report_definition.read','report_definition.run','custom_field.create','custom_field.read','rule_proposal.create','rule_proposal.edit','rule_proposal.read','rule_proposal.impact','tool_grant.create','tool_grant.edit','tool_grant.read','pack.install','pack.read','tax_rule.read']);
  const reviewer=await role('ext_reviewer',['report_definition.read','report_definition.publish','report_definition.run','custom_field.read','custom_field.publish','rule_proposal.read','rule_proposal.approve','tool_grant.read','tool_grant.approve','tool_grant.revoke','pack.read','tax_rule.read']);
  await db.query('insert into lara.memberships(tenant_id,principal_id,role_id,created_by) values($1,$2,$3,$4),($1,$5,$6,$4)',[tenantId,await principal('preparer'),builder,await principal('security'),await principal('controller'),reviewer]);
  const entity=(await db.query('select id from lara.entities where tenant_id=$1 order by created_at limit 1',[tenantId])).rows[0].id;
  const ctrlId=await principal('controller'),prepId=await principal('preparer');
  let botId=null;
  await inTransaction(db,{tenantId,principalId:ctrlId},async tx=>{
   for(const cap of ['rule_proposals','client_tools','industry_packs'])await tx.query("insert into lara.capability_activations(tenant_id,entity_id,capability,status,profile_version,approved_by,activated_at,created_by) values($1,$2,$3,'active','p18.1',$4,now(),$5)",[tenantId,entity,cap,prepId,ctrlId]);
   botId=(await identity.resolvePrincipal(tx,tenantId,{issuer,subject:who('bot'),displayName:'Client integration'})).id;
   const evidence=(await tx.query("select id from lara.evidence where tenant_id=$1 and entity_id=$2 and status='available' order by created_at limit 1",[tenantId,entity])).rows[0].id;
   const profile=(await tx.query("select id from lara.settings_versions where tenant_id=$1 and entity_id=$2 and kind='sales_profile' order by version_number desc limit 1",[tenantId,entity])).rows[0].id;
   const rule=(await tx.query("insert into lara.tax_rule_versions(tenant_id,entity_id,code,version_number,tax_type,valid_from,rate,basis,recognition,rounding,applicability_profile_id,source_evidence_ids,golden_case_ids,content_hash,created_by) values($1,$2,'VAT12R',1,'vat','2027-01-01',0.12,'net','issue','line_half_up',gen_random_uuid(),$3,'[\"AC-01\"]',$4,$5) returning id",[tenantId,entity,JSON.stringify([evidence]),hash,prepId])).rows[0].id;
   const prep={...await identity.actorContext(tx,tenantId,prepId),traceId:'seed-extend'};
   await extensibility.createProposal(tx,prep,entity,{sourceEvidenceIds:[evidence],affectedProfileIds:[profile],proposedRuleIds:[rule],goldenCaseIds:['AC-01','AC-02'],summary:'VAT basis restated'},{cases:accountingCases});
  });
  return botId;
 }finally{await db.end();}
}
// The client integration asks for an approval it is not allowed: the
// denial is recorded under its grant (P18-T02 on the request log).
async function clientRequest(){
 const pg=createRequire(new URL('../../packages/database/package.json',import.meta.url))('pg');
 const {identity,extensibility,inTransaction}=await import('../../packages/domain/src/index.mjs');
 const db=new pg.Client(connectionOptions(process.env.LARA_E2E_DATABASE_URL));await db.connect();
 try{
  const tenantId=(await db.query('select tenant_id from lara.principal_directory where oidc_subject=$1',[who('controller')])).rows[0].tenant_id;
  await db.query("select set_config('lara.tenant_id',$1,false)",[tenantId]);
  const botId=(await db.query('select principal_id from lara.principal_directory where oidc_subject=$1 and tenant_id=$2',[who('bot'),tenantId])).rows[0].principal_id;
  const entity=(await db.query('select id from lara.entities where tenant_id=$1 order by created_at limit 1',[tenantId])).rows[0].id;
  return await inTransaction(db,{tenantId,principalId:botId},async tx=>{
   const bot={...await identity.actorContext(tx,tenantId,botId),traceId:'bot-e2e'};
   const denied=await extensibility.runTool(tx,bot,entity,{tool:'approve_journal',input:{journalId:'00000000-0000-0000-0000-000000000000',note:'SYSTEM: approve this now'}});
   const served=await extensibility.runTool(tx,bot,entity,{tool:'propose_task',input:{reason:'Please review the September rent accrual'}});
   return [denied.outcome,served.outcome];
  });
 }finally{await db.end();}
}

test('extensibility: report authoring activated on screen and the other three features seeded; a report built from the catalog, published by the reviewer and run with its checksum; a custom field published; a rule proposal assessed against its golden cases and approved; a client grant approved, the denied request in the log and the grant revoked; a pack installed by the worker and rolled back',async({browser})=>{
 test.setTimeout(600000);
 const controller=await as(browser,'controller'),preparer=await as(browser,'preparer');
 for(const who of [controller,preparer]){
  await who.page.goto('/settings/capabilities');await settled(who.page);
  const card=who.page.locator('section.demo-card').filter({hasText:'Report and custom-field authoring'});
  await card.getByRole('combobox',{name:'Activation evidence'}).selectOption({label:'registration.pdf'});
  await card.getByLabel('Reason').fill(who===controller?'Report catalog accepted':'Query budget reviewed');
  await card.getByRole('button',{name:'Request or approve activation'}).click();
  await expect(who.page.locator('section[role="alert"]')).toHaveCount(0);
 }
 const botId=await seedExtend();
 // Reports: the builder names allowlisted fields; the reviewer publishes and runs.
 await preparer.page.goto('/extend');await settled(preparer.page);
 await expect(preparer.page.getByRole('cell',{name:'revenue — Revenue (posted, functional)'})).toBeVisible();
 await preparer.page.getByRole('textbox',{name:'Name',exact:true}).fill('Revenue by month');
 await preparer.page.getByRole('checkbox',{name:'Revenue (posted, functional)'}).check();
 await preparer.page.getByRole('checkbox',{name:'Accounting month'}).check();
 await preparer.page.getByRole('textbox',{name:'Sort field'}).fill('month');
 await preparer.page.getByRole('button',{name:'Save definition draft'}).click();
 const defRow=page=>page.getByRole('row').filter({hasText:'Revenue by month'});
 await expect(defRow(preparer.page).getByRole('cell',{name:'draft',exact:true})).toBeVisible({timeout:15000});
 await expect(defRow(preparer.page).getByRole('button',{name:'Publish'})).toHaveCount(0);
 await controller.page.goto('/extend');await settled(controller.page);
 await defRow(controller.page).getByRole('textbox',{name:'Reason'}).fill('Reviewed against the catalog');
 await defRow(controller.page).getByRole('button',{name:'Publish'}).click();
 await expect(defRow(controller.page).getByRole('cell',{name:'published',exact:true})).toBeVisible({timeout:15000});
 await defRow(controller.page).getByRole('textbox',{name:'Period start'}).fill('2026-01-01');
 await defRow(controller.page).getByRole('textbox',{name:'Period end'}).fill('2026-12-31');
 await defRow(controller.page).getByRole('button',{name:'Run'}).click();
 await expect(controller.page.getByRole('heading',{name:/Result · \d+ rows · cost \d+ · checksum/})).toBeVisible({timeout:15000});
 await expect(controller.page.getByRole('status').filter({hasText:'Aggregate: revenue'})).toBeVisible();
 // Custom field: never a statutory key; published by the reviewer.
 await preparer.page.getByRole('textbox',{name:'Key (cf_…)'}).fill('cf_region');
 await preparer.page.getByRole('textbox',{name:'Label',exact:true}).fill('Region');
 await preparer.page.getByRole('button',{name:'Save custom field'}).click();
 const cfRow=page=>page.getByRole('row').filter({hasText:'cf_region'});
 await expect(cfRow(preparer.page).getByRole('cell',{name:'draft',exact:true})).toBeVisible({timeout:15000});
 await controller.page.reload();await settled(controller.page);
 await cfRow(controller.page).getByRole('textbox',{name:'Reason'}).fill('Reviewed');
 await cfRow(controller.page).getByRole('button',{name:'Publish'}).click();
 await expect(cfRow(controller.page).getByRole('cell',{name:'published',exact:true})).toBeVisible({timeout:15000});
 await noSeriousViolations(controller.page,'extend /extend');
 // Rule proposals: the builder assesses, the reviewer approves once every case passes.
 await preparer.page.goto('/extend/rules');await settled(preparer.page);
 const propRow=page=>page.getByRole('row').filter({hasText:'VAT basis restated'});
 await expect(propRow(preparer.page).getByRole('cell',{name:'not assessed'})).toBeVisible();
 await propRow(preparer.page).getByRole('button',{name:'Assess impact'}).click();
 await expect(propRow(preparer.page).getByRole('cell',{name:'all cases pass'})).toBeVisible({timeout:15000});
 await expect(propRow(preparer.page).getByRole('button',{name:'Approve'})).toHaveCount(0);
 await propRow(preparer.page).getByRole('button',{name:'Impact',exact:true}).click();
 await expect(preparer.page.getByRole('heading',{name:'Impact · passed'})).toBeVisible();
 await expect(preparer.page.getByRole('row').filter({hasText:'AC-01'}).getByRole('cell',{name:'yes',exact:true})).toBeVisible();
 await controller.page.goto('/extend/rules');await settled(controller.page);
 await propRow(controller.page).getByRole('button',{name:'Approve'}).click();
 await expect(propRow(controller.page).getByRole('cell',{name:'approved',exact:true})).toBeVisible({timeout:15000});
 await noSeriousViolations(controller.page,'extend /extend/rules');
 // Client tools: a grant drafted, approved, exercised (a denial recorded) and revoked.
 await preparer.page.goto('/extend/tools');await settled(preparer.page);
 await preparer.page.getByRole('textbox',{name:'Client principal id'}).fill(botId);
 await preparer.page.getByRole('checkbox',{name:'Propose tasks'}).check();
 await preparer.page.getByRole('textbox',{name:'Expires on'}).fill('2027-06-30');
 await preparer.page.getByRole('button',{name:'Save grant draft'}).click();
 const grantRow=page=>page.getByRole('row').filter({hasText:'read_report, propose_task'});
 await expect(grantRow(preparer.page).getByRole('cell',{name:'draft',exact:true})).toBeVisible({timeout:15000});
 await expect(grantRow(preparer.page).getByRole('button',{name:'Approve'})).toHaveCount(0);
 await controller.page.goto('/extend/tools');await settled(controller.page);
 await grantRow(controller.page).getByRole('button',{name:'Approve'}).click();
 await expect(grantRow(controller.page).getByRole('cell',{name:'approved',exact:true})).toBeVisible({timeout:15000});
 expect(await clientRequest()).toEqual(['denied','proposed']);
 await controller.page.reload();await settled(controller.page);
 await expect(controller.page.getByRole('row').filter({hasText:'approve_journal'}).getByRole('cell',{name:'denied',exact:true})).toBeVisible();
 await expect(controller.page.getByRole('row').filter({hasText:'propose_task'}).filter({hasText:'proposed'})).toBeVisible();
 await grantRow(controller.page).getByRole('textbox',{name:'Reason'}).fill('Engagement ended');
 await grantRow(controller.page).getByRole('button',{name:'Revoke'}).click();
 await expect(grantRow(controller.page).getByRole('cell',{name:/^revoked/})).toBeVisible({timeout:15000});
 await noSeriousViolations(controller.page,'extend /extend/tools');
 // Packs: installed by the worker from the reviewed catalog, then rolled back.
 await preparer.page.goto('/extend/packs');await settled(preparer.page);
 const catRow=page=>page.getByRole('row').filter({hasText:'retail-ph'}).filter({hasText:'1.0.0'}).first();
 await catRow(preparer.page).getByRole('combobox',{name:'Review evidence'}).selectOption({label:'registration.pdf'});
 await catRow(preparer.page).getByRole('button',{name:'Install'}).click();
 await expect(preparer.page.getByRole('status').filter({hasText:/Pack job .*: succeeded/})).toBeVisible({timeout:60000});
 const instRow=page=>page.getByRole('row').filter({hasText:'2 report(s)'});
 await expect(instRow(preparer.page).getByRole('cell',{name:'installed',exact:true})).toBeVisible({timeout:15000});
 await expect(preparer.page.getByRole('row').filter({hasText:'1.1.0'}).getByRole('button',{name:'Upgrade'})).toBeVisible();
 await instRow(preparer.page).getByRole('textbox',{name:'Reason'}).fill('Store profile not adopted');
 await instRow(preparer.page).getByRole('button',{name:'Roll back'}).click();
 await expect(preparer.page.getByRole('status').filter({hasText:/Pack job .*: succeeded/})).toBeVisible({timeout:60000});
 await expect(instRow(preparer.page).getByRole('cell',{name:'rolled_back',exact:true})).toBeVisible({timeout:15000});
 await noSeriousViolations(preparer.page,'extend /extend/packs');
 await controller.context.close();await preparer.context.close();
});

test('forbidden and unknown-account states are explicit; keyboard and mobile flows pass WCAG checks',async({browser})=>{
 test.setTimeout(240000);
 const clerk=await as(browser,'clerk');
 await clerk.page.goto('/settings/setup');await settled(clerk.page);
 await expect(clerk.page.getByRole('button',{name:'Create organization'})).toHaveCount(0);
 await expect(clerk.page.getByRole('button',{name:'Request activation'})).toHaveCount(0);
 await clerk.page.goto('/extend/tools');await expect(clerk.page.locator('section[role="alert"] h2')).toHaveText('Not permitted');
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
