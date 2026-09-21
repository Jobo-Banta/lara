// Development sign-in account: a Supabase Auth user whose credentials the
// consent page prefills so a developer or tester reaches the app with one
// click. Refused outside demo/local mode; the credentials live in .env.local
// (never committed) as DEV_LOGIN_EMAIL / DEV_LOGIN_PASSWORD.
//
//   node scripts/dev-account.mjs            create or confirm the account
//   node scripts/dev-account.mjs --print    show the prefilled credentials
import {createRequire} from 'node:module';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {loadLocalEnv} from './local-env.mjs';
import {connectionOptions} from '../packages/database/src/connection.mjs';
loadLocalEnv();
const mode=process.env.LARA_MODE||'demo';
if(!['demo','local'].includes(mode))throw Error('The development account exists only in demo or local mode (LARA_MODE='+mode+').');
const email=process.env.DEV_LOGIN_EMAIL||'lara.dev@example.com';
const password=process.env.DEV_LOGIN_PASSWORD||'lara-dev-2026';
if(process.argv.includes('--print')){console.log(JSON.stringify({email,password}));process.exit(0);}
const ownerUrl=process.env.SUPABASE_OWNER_DATABASE_URL;
if(!ownerUrl)throw Error('SUPABASE_OWNER_DATABASE_URL is required.');
// The user and its email identity are written the way the provider writes them, without a sign-up mail; a second run resets the password and keeps the id.
const pg=createRequire(new URL('../packages/database/package.json',import.meta.url))('pg');
const db=new pg.Client({...connectionOptions(ownerUrl),connectionTimeoutMillis:15000});
await db.connect();
try{
 await db.query('begin');
 let user=(await db.query('select id from auth.users where email=$1 and is_sso_user=false',[email])).rows[0];
 if(!user){
  user=(await db.query("insert into auth.users(instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at,confirmation_token,recovery_token,email_change,email_change_token_new,email_change_token_current,is_sso_user) values('00000000-0000-0000-0000-000000000000',gen_random_uuid(),'authenticated','authenticated',$1,extensions.crypt($2,extensions.gen_salt('bf')),now(),'{\"provider\":\"email\",\"providers\":[\"email\"]}','{}',now(),now(),'','','','','',false) returning id",[email,password])).rows[0];
  await db.query("insert into auth.identities(id,user_id,provider_id,provider,identity_data,last_sign_in_at,created_at,updated_at) values(gen_random_uuid(),$1::uuid,$2,'email',jsonb_build_object('sub',$2::text,'email',$3::text,'email_verified',true),now(),now(),now())",[user.id,String(user.id),email]);
 }else await db.query("update auth.users set email_confirmed_at=coalesce(email_confirmed_at,now()),encrypted_password=extensions.crypt($2,extensions.gen_salt('bf')),updated_at=now() where id=$1",[user.id,password]);
 await db.query('commit');
 console.log(JSON.stringify({email,subject:user.id,mode}));
}catch(e){await db.query('rollback').catch(()=>{});throw e;}finally{await db.end();}
// Record the credentials for the consent page prefill (.env.local is ignored by git).
const envPath=new URL('../.env.local',import.meta.url);
if(existsSync(envPath)){
 let text=readFileSync(envPath,'utf8');const add=[];
 if(!/^DEV_LOGIN_EMAIL=/m.test(text))add.push('DEV_LOGIN_EMAIL='+email);
 if(!/^DEV_LOGIN_PASSWORD=/m.test(text))add.push('DEV_LOGIN_PASSWORD='+password);
 if(add.length){text=text.replace(/\s*$/,'\n')+'# Development sign-in prefill (demo/local modes only)\n'+add.join('\n')+'\n';writeFileSync(envPath,text);console.log('Recorded DEV_LOGIN_* in .env.local');}
}
