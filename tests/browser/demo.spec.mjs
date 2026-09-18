import {test,expect} from '@playwright/test';
import {seal} from '../../packages/config/src/session-cookie.mjs';

test.beforeEach(async({context})=>{
 test.skip(!process.env.LARA_E2E_DATABASE_URL,'Requires a provisioned synthetic PostgreSQL subject');
 await context.addCookies([{name:'lara_session',value:seal({sub:process.env.LARA_E2E_SUBJECT||'ci-browser-subject',expiresAt:Date.now()+3600000},'browser-fixture-session-key-32-characters'),url:'http://127.0.0.1:3015',httpOnly:true,sameSite:'Lax'}]);
});
const state=async p=>(await p.request.get('/api/demo/workspace')).json();
async function command(p,action,fields={}){const s=await state(p);const response=await p.request.post('/api/demo/command',{headers:{origin:'http://127.0.0.1:3015'},data:{action,...fields,run:s.run,version:s.version,key:crypto.randomUUID()}});expect(response.status(),await response.text()).toBe(200);return response.json();}
const role=(p,actor)=>command(p,'switch-actor',{actor});
const reset=(p,scenario)=>command(p,'reset',{scenario,confirm:'RESET MY SYNTHETIC SESSION'});
async function go(p,path){await p.goto(path);await expect(p.locator('h1')).not.toHaveText('Loading workspace…');await expect(p.locator('h1')).not.toHaveText('Workspace unavailable');}
async function click(p,label){const [r]=await Promise.all([p.waitForResponse(r=>r.url().endsWith('/api/demo/command')&&r.request().method()==='POST'),p.getByRole('button',{name:label,exact:true}).click()]);expect(r.status(),await r.text()).toBe(200);await expect(p.locator('.workspace-actions')).toBeEnabled();await expect(p.locator('.error-panel')).toHaveCount(0);await expect(p.getByRole('status').filter({hasText:'Saved to your synthetic demo session.'})).toBeVisible();}

test('DEMO-01 invoice persists, reviewer approves, treasury collects at mobile width',async({page})=>{
 test.setTimeout(180000);await go(page,'/sales/invoices/new');
 await page.getByLabel('Customer',{exact:true}).fill('Browser synthetic customer');
 await page.getByRole('button',{name:'Save draft',exact:true}).click();
 await expect(page).toHaveURL(/sales\/invoices\/[a-f0-9-]+$/);
 await expect(page.getByText('Total ₱11,200.00',{exact:false})).toBeVisible();
 const url=page.url();await page.reload();await expect(page.getByLabel('Customer',{exact:true})).toHaveValue('Browser synthetic customer');
 await click(page,'Submit invoice');await expect(page.getByRole('button',{name:'Approve invoice',exact:true})).toBeDisabled();
 await go(page,'/demo/scenarios');await page.getByLabel('Active actor').selectOption('Reviewer');await expect(page.getByText('Reviewer · Demo identity')).toBeVisible();
 await page.setViewportSize({width:390,height:844});await go(page,new URL(url).pathname);
 const approve=page.getByRole('button',{name:'Approve invoice',exact:true});await approve.focus();await expect(approve).toBeFocused();await approve.press('Enter');await expect(page.getByRole('button',{name:'Simulate posting',exact:true})).toBeVisible();
 await click(page,'Simulate posting');await expect(page.getByText('Workflow: Posted',{exact:false})).toBeVisible();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.screenshot({path:'.local/p01-mobile-invoice.png',fullPage:true});
 await role(page,'Treasury');await page.reload();await click(page,'Record collection');await expect(page.getByText('Settlement: Paid',{exact:false})).toBeVisible();
});

test('DEMO-02 uncertain bill and payment approval invalidation',async({page})=>{
 test.setTimeout(180000);await reset(page,'DEMO-02');await go(page,'/purchases/bills/bill-fixture');
 await page.getByLabel('Synthetic supplier TIN').fill('SYNTHETIC-TIN');await page.getByLabel('Correction explanation').fill('Verified fixture');
 await click(page,'Save draft');await page.reload();await expect(page.getByLabel('Correction explanation')).toHaveValue('Verified fixture');
 await click(page,'Submit bill');await role(page,'Reviewer');await page.reload();await click(page,'Approve bill');await click(page,'Simulate bill posting');
 const s=await state(page),id=s.payments[0].id;await go(page,'/payments/'+id);await click(page,'Approve authority');
 await role(page,'Treasury');await page.reload();await page.getByLabel('Beneficiary').fill('Synthetic replacement');await click(page,'Save draft');
 await expect(page.getByText('Authority: Draft',{exact:false})).toBeVisible();
 await role(page,'Reviewer');await page.reload();await click(page,'Approve authority');await role(page,'Treasury');await page.reload();await click(page,'Simulate release');await expect(page.getByText('Release: Simulated',{exact:false})).toBeVisible();
});

test('DEMO-03 dropped response replays one committed posting',async({page})=>{
 await reset(page,'DEMO-03');const s=await state(page),id=s.invoices[0].id;await go(page,'/sales/invoices/'+id);
 let dropped=false;await page.route('**/api/demo/command',async route=>{if(!dropped&&route.request().postDataJSON().action==='post-invoice'){dropped=true;await route.fetch();await route.abort('connectionreset');}else await route.continue();});
 await page.getByRole('button',{name:'Simulate posting',exact:true}).click();await expect(page.getByRole('button',{name:'Retry the same command'})).toBeVisible();
 await page.getByRole('button',{name:'Retry the same command'}).click();await expect(page.getByText('Workflow: Posted',{exact:false})).toBeVisible();
 expect((await state(page)).journals).toHaveLength(1);
});

test('DEMO-04 rejected and unknown acknowledgements repair without changing source',async({page})=>{
 await reset(page,'DEMO-04');const original=(await state(page)).invoices[0];await go(page,'/compliance');
 await expect(page.getByRole('heading',{name:'Unknown acknowledgement',exact:true})).toBeVisible();
 for(let i=0;i<2;i++){await page.getByLabel('Buyer reference repair').first().fill('Synthetic buyer reference');await Promise.all([page.waitForResponse(r=>r.url().endsWith('/api/demo/workspace')&&r.status()===200),page.getByRole('button',{name:'Simulate transport repair'}).first().click()]);await expect(page.getByRole('heading',{name:'Accepted',exact:true})).toHaveCount(i+1);await expect.poll(async()=>(await state(page)).reporting.filter(r=>r.status==='Accepted').length).toBe(i+1);}
 expect((await state(page)).invoices[0]).toEqual(original);
});

test('DEMO-05 partial receipt and explicit fee tie the statement',async({page})=>{
 await reset(page,'DEMO-05');const id=(await state(page)).invoices[0].id;await go(page,'/bank/reconcile');
 await page.getByLabel('Allocation PHP').first().fill('5000.00');await page.getByLabel('Collected invoice').selectOption(id);await click(page,'Allocate receipt');
 await expect(page.getByText('Partial · Statement',{exact:false})).toBeVisible();
 await page.getByLabel('Allocation PHP').first().fill('6200.00');await click(page,'Allocate receipt');await click(page,'Record explicit fee adjustment');
 expect((await state(page)).lines.every(l=>l.status==='Matched')).toBe(true);
});

test('DEMO-06 close requires owned evidence and retains report',async({page})=>{
 await reset(page,'DEMO-06');await go(page,'/close/2026-09');
 const bank=page.locator('section.demo-card').filter({has:page.getByRole('heading',{name:'Review bank reconciliation'})});await bank.getByLabel('Evidence').selectOption('evidence-bank');await bank.getByRole('button',{name:'Complete task'}).click();await expect(bank.getByText('Controller · Complete')).toBeVisible();
 await role(page,'Tax');await page.reload();await page.getByRole('button',{name:'Complete task'}).click();await expect(page.getByText('Tax · Complete')).toBeVisible();
 await role(page,'Reviewer');await page.reload();await click(page,'Lock synthetic period');await expect(page.getByText('Locked · original report retained.',{exact:false})).toBeVisible();
 const s=await state(page);expect(s.period.report.length).toBeGreaterThan(0);
});

test('DEMO-07 audit follows journal to evidence and authorized export',async({page})=>{
 await reset(page,'DEMO-07');await go(page,'/reports');await page.getByRole('link',{name:'Accounts receivable',exact:true}).click();
 await page.getByRole('link',{name:'Inspect evidence'}).first().click();await expect(page.getByText('SIMULATED — NOT A TAX DOCUMENT',{exact:false})).toBeVisible();
 expect((await page.request.get('/api/demo/evidence/other-tenant')).status()).toBe(404);
 expect((await page.request.get('/api/demo/evidence/evidence-quarantine')).status()).toBe(409);
 const download=await page.request.get('/api/demo/export');expect(download.status()).toBe(200);expect((await download.json()).content).toContain('SIMULATED');
 await role(page,'Clerk');expect((await page.request.get('/api/demo/export')).status()).toBe(403);
});

test('DEMO-08 offline draft survives refresh and stale save requires explicit merge',async({page,context})=>{
 await reset(page,'DEMO-08');const id=(await state(page)).invoices[0].id;await go(page,'/sales/invoices/'+id);
 await context.setOffline(true);await page.getByLabel('Customer',{exact:true}).fill('Retained offline draft');await page.getByRole('button',{name:'Save draft',exact:true}).click();await expect(page.locator('.error-panel')).toBeVisible();
 await context.setOffline(false);await command(page,'comment',{id,text:'Concurrent change'});
 await page.getByRole('button',{name:'Retry the same command'}).click();await expect(page.locator('.error-panel')).toContainText('draft is retained');
 await expect(page.getByLabel('Customer',{exact:true})).toHaveValue('Retained offline draft');
 await page.getByRole('button',{name:'Reload latest workspace'}).click();await expect(page.locator('.error-panel')).toHaveCount(0);await click(page,'Save draft');
 await expect.poll(async()=>(await state(page)).invoices[0].customer).toBe('Retained offline draft');
 await page.reload();await expect(page.getByLabel('Customer',{exact:true})).toHaveValue('Retained offline draft');
});

test('branch isolation, setup, feedback, navigation and desktop layout',async({page})=>{
 test.setTimeout(120000);await reset(page,'DEMO-07');await command(page,'context',{branch:'Cebu'});expect((await state(page)).invoices).toHaveLength(0);await command(page,'context',{branch:'HQ'});expect((await state(page)).invoices).toHaveLength(1);
 await role(page,'Controller');await go(page,'/settings/setup');await page.getByLabel('Organization').fill('Synthetic demo organization');await page.getByLabel('Role checklist reviewed').selectOption('yes');await click(page,'Save draft');await page.reload();await expect(page.getByLabel('Organization')).toHaveValue('Synthetic demo organization');
 await go(page,'/feedback');await page.getByLabel('Feedback',{exact:true}).fill('Synthetic usability test feedback');await click(page,'Record feedback');expect((await state(page)).feedback).toHaveLength(1);
 for(const width of [1440,1024,390,320]){await page.setViewportSize({width,height:900});await go(page,'/overview');expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);}
 await page.setViewportSize({width:1440,height:900});await page.screenshot({path:'.local/p01-desktop-overview.png',fullPage:true});
});
