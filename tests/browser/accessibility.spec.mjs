import {test,expect} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import {seal} from '../../packages/config/src/session-cookie.mjs';

// P01-T05: keyboard and mobile critical flows must pass WCAG 2.1 A/AA automated checks.
const routes=['/work','/overview','/sales/invoices','/sales/invoices/new','/purchases/bills/bill-fixture','/payments','/bank/reconcile','/close/2026-09','/compliance','/reports','/evidence','/demo/scenarios','/feedback'];
const widths=[{width:1440,height:900},{width:390,height:844}];
async function scan(page,label){
 const results=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa']).analyze();
 const serious=results.violations.filter(v=>['serious','critical'].includes(v.impact));
 expect(serious,label+'\n'+JSON.stringify(serious.map(v=>({id:v.id,impact:v.impact,nodes:v.nodes.map(n=>n.target)})),null,1)).toEqual([]);
}

test('login page has no serious accessibility violations at desktop and mobile',async({page})=>{
 for(const size of widths){await page.setViewportSize(size);await page.goto('/');await expect(page.locator('h1')).toBeVisible();await scan(page,'login '+size.width);}
});

test('authenticated workspace routes have no serious accessibility violations',async({page,context})=>{
 test.skip(!process.env.LARA_E2E_DATABASE_URL,'Requires a provisioned synthetic PostgreSQL subject');
 test.setTimeout(240000);
 await context.addCookies([{name:'lara_session',value:seal({sub:process.env.LARA_E2E_SUBJECT||'ci-browser-subject',expiresAt:Date.now()+3600000},'browser-fixture-session-key-32-characters'),url:'http://127.0.0.1:3015',httpOnly:true,sameSite:'Lax'}]);
 const s=await (await page.request.get('/api/demo/workspace')).json();
 await page.request.post('/api/demo/command',{headers:{origin:'http://127.0.0.1:3015'},data:{action:'reset',scenario:'DEMO-02',confirm:'RESET MY SYNTHETIC SESSION',run:s.run,version:s.version,key:crypto.randomUUID()}});
 for(const size of widths){
  await page.setViewportSize(size);
  for(const route of routes){
   await page.goto(route);await expect(page.locator('h1')).not.toHaveText(/Loading workspace|Workspace unavailable/);
   await scan(page,route+' '+size.width);
  }
 }
});

test('primary navigation and actions are reachable by keyboard',async({page,context})=>{
 test.skip(!process.env.LARA_E2E_DATABASE_URL,'Requires a provisioned synthetic PostgreSQL subject');
 await context.addCookies([{name:'lara_session',value:seal({sub:process.env.LARA_E2E_SUBJECT||'ci-browser-subject',expiresAt:Date.now()+3600000},'browser-fixture-session-key-32-characters'),url:'http://127.0.0.1:3015',httpOnly:true,sameSite:'Lax'}]);
 await page.goto('/sales/invoices/new');await expect(page.locator('h1')).toHaveText('New invoice');
 await page.keyboard.press('Tab');await expect(page.getByRole('link',{name:'Skip to content'})).toBeFocused();
 await page.keyboard.press('Enter');
 for(let i=0;i<40;i++){await page.keyboard.press('Tab');if(await page.getByLabel('Customer',{exact:true}).evaluate(e=>e===document.activeElement))break;}
 await expect(page.getByLabel('Customer',{exact:true})).toBeFocused();
 await page.getByLabel('Unit price PHP').first().fill('2500.50');await page.keyboard.press('Tab');
 await expect(page.getByText('Amount preview: subtotal ₱2,500.50 · test VAT ₱300.06 · total ₱2,800.56')).toBeVisible();
});
