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
