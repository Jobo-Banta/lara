import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {loadLocalEnv} from './local-env.mjs';
import {connectionOptions} from '../packages/database/src/connection.mjs';
import {demoRequest} from '../apps/api/src/demo-service.mjs';
loadLocalEnv();
const pg=createRequire(new URL('../packages/database/package.json',import.meta.url))('pg');
const owner=new pg.Client(connectionOptions(process.env.SUPABASE_OWNER_DATABASE_URL));
const sub='test-p01-'+randomUUID(),other=sub+'-other';
const a={sub,sid:randomUUID()},b={sub,sid:randomUUID()},c={sub:other,sid:randomUUID()};
const request=(identity,method,path,body)=>demoRequest(new pg.Client({...connectionOptions(process.env.DATABASE_URL),connectionTimeoutMillis:10000,query_timeout:15000}),identity,method,path,body);
const read=(who=a)=>request(who,'GET','/demo/workspace');
let state;
const make=(action,fields={})=>({action,...fields,key:randomUUID(),run:state.run,version:state.version});
const post=body=>request(a,'POST','/demo/command',body);
async function act(action,fields={}){const r=await post(make(action,fields));state=await read();return r;}
const actor=role=>{console.log('Workflow stage: '+role);return act('switch-actor',{actor:role});};
const draft={customer:'Synthetic customer',issueDate:'2026-09-18',dueDate:'2026-10-18',terms:'30 days',lines:[{description:'Services',quantity:1,unitPrice:'10000.00'}]};
await owner.connect();
try{
 await owner.query("insert into lara_demo.runs(id,fixture_version,label,owner_subject) values($1,'test-p01','Synthetic test',$1),($2,'test-p01','Synthetic test',$2)",[sub,other]);
 state=await read();const second=await read(b),tenant=await read(c);assert.notEqual(state.run,second.run);assert.notEqual(state.run,tenant.run);
 const {id}=await act('save-invoice',draft);assert.equal(state.invoices[0].total,'11200.00');
 await act('submit-invoice',{id});await assert.rejects(post(make('approve-invoice',{id})),e=>e.status===403);
 await actor('Reviewer');await act('approve-invoice',{id});const posting=make('post-invoice',{id});const result=await post(posting);
 // A committed response can be lost. The same request must reproduce it 100 times.
 for(let i=0;i<100;i++){assert.deepEqual(await post(posting),result);if((i+1)%20===0)console.log('Retry verification: '+(i+1)+'/100');}
 await assert.rejects(post({...posting,id:'other'}),e=>e.status===409);state=await read();assert.equal(state.journals.length,1);
 assert.equal(state.invoices[0].delivery,'Not sent');assert.equal(state.invoices[0].settlement,'Unpaid');assert.equal(state.invoices[0].reporting,'Rejected');
 await actor('Treasury');await act('collect-invoice',{id});assert.equal(state.invoices[0].settlement,'Paid');
 await act('match-bank',{id:'bank-receipt',source:id,amount:'5000.00'});assert.equal(state.lines[0].status,'Partial');
 await assert.rejects(post(make('match-bank',{id:'bank-receipt',source:id,amount:'7000.00'})),e=>e.status===422);
 await act('match-bank',{id:'bank-receipt',source:id,amount:'6200.00'});assert.equal(state.lines[0].status,'Matched');
 await assert.rejects(post(make('match-bank',{id:'bank-fee',amount:'50.00'})),e=>e.status===422);
 await act('match-bank',{id:'bank-fee',amount:'50.00',adjustment:true});
 const original=structuredClone(state.invoices[0]);await actor('Tax');await act('resolve-reporting',{id:state.reporting[0].id,repair:'Fictional buyer reference supplied'});assert.deepEqual(state.invoices[0],original);
 await actor('Clerk');await assert.rejects(post(make('submit-bill',{id:'bill-fixture'})),e=>e.status===422);
 await act('save-bill',{id:'bill-fixture',tin:'SYNTHETIC-TIN',correction:'Verified against fixture evidence',route:'Non-PO'});await act('submit-bill',{id:'bill-fixture'});
 await actor('Reviewer');await act('approve-bill',{id:'bill-fixture'});await act('post-bill',{id:'bill-fixture'});
 const pay=state.payments[0].id;await act('approve-payment',{id:pay});await actor('Treasury');await act('save-payment',{id:pay,beneficiary:'Synthetic replacement beneficiary'});assert.equal(state.payments[0].authority,'Draft');await assert.rejects(post(make('release-payment',{id:pay})),e=>e.status===422);
 await actor('Reviewer');await act('approve-payment',{id:pay});await actor('Treasury');await act('release-payment',{id:pay});assert.equal(state.payments[0].release,'Simulated');
 await actor('Billing');const late=(await act('save-invoice',draft)).id;await act('submit-invoice',{id:late});await actor('Reviewer');await act('approve-invoice',{id:late});
 await assert.rejects(post(make('lock-period')),e=>e.status===422);
 await actor('Controller');await act('complete-close',{id:'bank',evidence:'evidence-bank'});await actor('Tax');await act('complete-close',{id:'tax',evidence:'evidence-source'});await actor('Reviewer');await act('lock-period');const retained=structuredClone(state.period.report);
 await assert.rejects(post(make('post-invoice',{id:late})),e=>e.status===409);assert.deepEqual((await read()).period.report,retained);
 await actor('Billing');const stale=make('save-invoice',{...draft,id:late});await act('save-invoice',{...draft,id:late,customer:'Changed in another tab'});await assert.rejects(post(stale),e=>e.status===412);
 const one=make('save-invoice',{...draft,id:late,customer:'Concurrent A'}),two=make('save-invoice',{...draft,id:late,customer:'Concurrent B'});const concurrent=await Promise.allSettled([post(one),post(two)]);assert.equal(concurrent.filter(x=>x.status==='fulfilled').length,1);assert.equal(concurrent.find(x=>x.status==='rejected').reason.status,412);state=await read();
 assert.equal((await read(b)).invoices.length,0);assert.equal((await read(c)).invoices.length,0);
 await assert.rejects(request(c,'POST','/demo/command',{action:'submit-invoice',id,key:randomUUID(),run:tenant.run,version:tenant.version}),e=>e.status===404);
 const beforeReset=make('save-invoice',draft);await act('reset',{scenario:'DEMO-08',confirm:'RESET MY SYNTHETIC SESSION'});assert.notEqual(state.run,beforeReset.run);await assert.rejects(post(beforeReset),e=>e.status===409);assert.equal((await read(b)).run,second.run);
 const runtime=new pg.Client(connectionOptions(process.env.DATABASE_URL));await runtime.connect();try{await runtime.query('begin');await runtime.query("select set_config('lara.subject',$1,true),set_config('lara.session',$2,true)",[sub,a.sid]);assert.equal((await runtime.query('select session_id from lara_demo.workspaces')).rowCount,1);await runtime.query('rollback');assert.equal((await runtime.query('select session_id from lara_demo.workspaces')).rowCount,0);}finally{await runtime.end();}
 console.log('PASS P01 real PostgreSQL: invoice/bill/payment, 100 exact retries, conflict/concurrency, immutable repair, partial allocations/explicit fee, retained close/late denial, RLS, same-user sessions, cross-tenant isolation and reset.');
}finally{
 await owner.query('delete from lara_demo.workspaces where owner_subject=any($1::text[])',[[sub,other]]);
 await owner.query('delete from lara_demo.runs where id=any($1::text[])',[[sub,other]]);await owner.end();
}
