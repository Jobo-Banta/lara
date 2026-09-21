import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { createClient } from '@supabase/supabase-js';
import { authConfig, seal, unseal } from '../../../lib/auth';
function client() {
 const config=authConfig();
 if(!config.publishableKey) throw new Error('Supabase publishable key is not configured');
 return createClient(config.issuer.replace(/\/auth\/v1\/?$/,''),config.publishableKey,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}});
}
function destination(value:string) {
 const url=new URL(value), expected=new URL(authConfig().redirectUri);
 if(url.origin!==expected.origin || url.pathname!==expected.pathname) throw new Error('Unexpected authorization destination');
 return url.toString();
}
async function provider() {
 const value=(await cookies()).get('lara_provider_session')?.value;
 const session=value?unseal(value,authConfig().verificationKeys):null;
 if(!session?.accessToken || !session.refreshToken || session.expiresAt<=Date.now()) return null;
 const supabase=client();
 const {error}=await supabase.auth.setSession({access_token:session.accessToken,refresh_token:session.refreshToken});
 return error?null:supabase;
}
async function signIn(form:FormData) {
 'use server';
 const authorizationId=String(form.get('authorization_id')||'');
 const {data,error}=await client().auth.signInWithPassword({email:String(form.get('email')||''),password:String(form.get('password')||'')});
 if(error || !data.session) redirect('/oauth/consent?authorization_id='+encodeURIComponent(authorizationId)+'&error=signin');
 (await cookies()).set('lara_provider_session',seal({sub:data.user.id,expiresAt:Date.now()+600000,accessToken:data.session.access_token,refreshToken:data.session.refresh_token},authConfig().secret),{httpOnly:true,secure:authConfig().redirectUri.startsWith('https:'),sameSite:'lax',maxAge:600,path:'/oauth'});
 // The development account (demo and local modes only) skips the consent click: the same server-side approval a person would give, for this client and redirect only.
 const dev=authConfig().devLogin;
 if(dev && String(form.get('email')||'').toLowerCase()===dev.email.toLowerCase()){
  const supabase=client();await supabase.auth.setSession({access_token:data.session.access_token,refresh_token:data.session.refresh_token});
  const details=await supabase.auth.oauth.getAuthorizationDetails(authorizationId);
  if(!details.error && details.data && !('redirect_url' in details.data) && details.data.client.id===authConfig().clientId && details.data.redirect_uri===authConfig().redirectUri){
   const approved=await supabase.auth.oauth.approveAuthorization(authorizationId,{skipBrowserRedirect:true});
   if(!approved.error && approved.data){(await cookies()).delete('lara_provider_session');redirect(destination(approved.data.redirect_url));}
  }
 }
 redirect('/oauth/consent?authorization_id='+encodeURIComponent(authorizationId));
}
async function decide(form:FormData) {
 'use server';
 const supabase=await provider();if(!supabase) redirect('/api/auth/login');
 const id=String(form.get('authorization_id')||'');
 const details=await supabase.auth.oauth.getAuthorizationDetails(id);
 if(details.error || !details.data) throw new Error('Authorization request expired');
 if('redirect_url' in details.data) redirect(destination(details.data.redirect_url));
 if(details.data.client.id!==authConfig().clientId || details.data.redirect_uri!==authConfig().redirectUri) throw new Error('Unexpected OAuth client');
 const result=form.get('decision')==='approve'?await supabase.auth.oauth.approveAuthorization(id,{skipBrowserRedirect:true}):await supabase.auth.oauth.denyAuthorization(id,{skipBrowserRedirect:true});
 if(result.error || !result.data) throw new Error('Authorization decision failed');
 (await cookies()).delete('lara_provider_session');
 redirect(destination(result.data.redirect_url));
}
export default async function Consent({searchParams}:{searchParams:Promise<{authorization_id?:string,error?:string}>}) {
 const params=await searchParams;
 if(!authConfig().publishableKey) return <main className="workspace-page"><h1>Sign-in setup needs one more setting</h1><p>The project publishable key has not been configured. Contact the operator.</p></main>;
 if(!params.authorization_id) return <main className="workspace-page"><h1>Start a new sign-in</h1><a href="/api/auth/login">Sign in</a></main>;
 const supabase=await provider();
 const dev=authConfig().devLogin;
 if(!supabase) return <main className="workspace-page"><p className="eyebrow">LARA · Secure sign-in</p><h1>Sign in to your demo account</h1>{params.error&&<p role="alert">Sign-in failed. Check your email and password.</p>}<form action={signIn} className="demo-form"><input type="hidden" name="authorization_id" value={params.authorization_id}/><label>Email<input type="email" name="email" autoComplete="username" defaultValue={dev?.email} required/></label><label>Password<input type="password" name="password" autoComplete="current-password" defaultValue={dev?.password} required/></label><button type="submit">Sign in</button>{dev&&<p className="eyebrow">Development account prefilled ({dev.email}); signing in also grants the consent.</p>}</form></main>;
 const {data,error}=await supabase.auth.oauth.getAuthorizationDetails(params.authorization_id);
 if(error || !data) return <main className="workspace-page"><h1>Authorization expired</h1><a href="/api/auth/login">Start again</a></main>;
 if('redirect_url' in data) redirect(destination(data.redirect_url));
 if(data.client.id!==authConfig().clientId) return <main className="workspace-page"><h1>Unrecognized application</h1></main>;
 return <main className="workspace-page"><h1>Allow {data.client.name} to sign you in?</h1><p>Requested access: {data.scope}</p><form action={decide}><input type="hidden" name="authorization_id" value={params.authorization_id}/><button name="decision" value="approve">Allow sign-in</button><button name="decision" value="deny">Cancel</button></form></main>;
}
