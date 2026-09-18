import {test,expect} from '@playwright/test';
test('clean start renders branded login at desktop and mobile',async({page})=>{
 for(const viewport of [{width:1440,height:900},{width:390,height:844}]){
  await page.setViewportSize(viewport);await page.goto('/');
  await expect(page.getByRole('img',{name:'LARA',exact:true})).toBeVisible();
  await expect(page.getByRole('link',{name:'Sign in',exact:true})).toBeVisible();
  await expect(page.locator('body')).toContainText('synthetic');
 }
});
test('PKCE challenge and HttpOnly flow cookie are issued',async({request})=>{
 const r=await request.get('/api/auth/login',{maxRedirects:0});expect(r.status()).toBe(307);
 const location=new URL(r.headers().location);expect(location.searchParams.get('code_challenge_method')).toBe('S256');
 expect(location.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
 expect(r.headers()['set-cookie']).toContain('HttpOnly');expect(r.headers()['set-cookie']).toContain('SameSite=lax');
});
test('anonymous and cross-origin commands are denied',async({request})=>{
 expect((await request.get('/api/demo/work')).status()).toBe(401);
 expect((await request.post('/api/demo/feedback',{headers:{origin:'https://untrusted.invalid'},data:{message:'blocked'}})).status()).toBe(403);
 expect((await request.get('/auth/callback?code=invalid&state=invalid')).status()).toBe(400);
});
test('protected workspace does not silently display fallback data',async({page})=>{
 await page.goto('/work');await expect(page.getByRole('heading',{name:'Workspace unavailable'})).toBeVisible();
 await expect(page.getByText('Review uncertain supplier bill')).toHaveCount(0);
 await page.getByRole('link',{name:'Sign in'}).focus();await expect(page.getByRole('link',{name:'Sign in'})).toBeFocused();
});

test('seeded authenticated workspace is isolated in the clean CI database',async({page,context})=>{
 test.skip(!process.env.LARA_E2E_DATABASE_URL,'Requires the ephemeral CI database');
 const {seal}=await import('../../packages/config/src/session-cookie.mjs');
 await context.addCookies([{name:'lara_session',value:seal({sub:process.env.LARA_E2E_SUBJECT||'ci-browser-subject',expiresAt:Date.now()+60000},'browser-fixture-session-key-32-characters'),url:'http://127.0.0.1:3015',httpOnly:true,sameSite:'Lax'}]);
 await page.goto('/work');
 await expect(page.getByText('Review uncertain supplier bill')).toBeVisible();
 await expect(page.getByText('Harbor Cloud invoice fixture')).toHaveCount(0);
 const storage=await page.evaluate(()=>({local:Object.keys(localStorage),session:Object.keys(sessionStorage),cookie:document.cookie}));
 expect(storage.cookie).not.toContain('lara_session');expect(storage.local).toEqual([]);expect(storage.session).toEqual([]);
});
