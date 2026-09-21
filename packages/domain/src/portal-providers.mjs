// Messaging and payment provider adapters (P13). One qualified channel and
// one payment provider are configured per deployment; this release ships the
// local adapters only: the local mail adapter writes each authorized message
// as a JSON file into the object bucket (the demo "mailbox"), and the fixture
// payment provider keeps intents in a file so the API and the worker share
// them. Both are idempotent on the send or intent key so a retry never sends
// or charges twice; an invite to a masked f*** address fails its first send. A hosted channel or provider arrives as a separate
// adapter behind the same interface.
import {createHmac,createHash,randomBytes} from 'node:crypto';
import {DomainError} from './core.mjs';

export function localMessagingProvider(store){
 return {
  name:'local-mail',
  // Sends once per key: a repeated key returns the first reference without a second delivery.
  async send({key,channel,to,subject,link,body}){
   const objectKey='messages/'+key+'.json';
   try{const existing=await store.get(objectKey);const parsed=JSON.parse(existing.toString('utf8'));return {reference:parsed.reference,duplicate:true};}catch{}
   // Fixture failure: an invite whose masked address starts with f*** fails its first attempt (the relay 'did not answer').
   if(/^invite:f\*\*\*@/.test(to)&&!(await store.get('messages/'+key+'.attempted').catch(()=>null))){await store.put('messages/'+key+'.attempted',Buffer.from('1'));throw new DomainError('DEPENDENCY_UNAVAILABLE','The mail relay did not answer.');}
   const reference='local:'+createHash('sha256').update(key).digest('hex').slice(0,16);
   await store.put(objectKey,Buffer.from(JSON.stringify({reference,channel,to,subject,link,body,sentAt:new Date().toISOString()},null,1)));
   return {reference,duplicate:false};
  }
 };
}
export function fixturePaymentProvider(store,secret){
 const key=id=>'payments/'+id+'.json';
 const read=async id=>{try{return JSON.parse((await store.get(key(id))).toString('utf8'));}catch{return null;}};
 return {
  name:'fixture-pay',
  async createIntent({intentKey,amount,currency,reference,expiresAt}){
   const existing=await read(intentKey);if(existing)return {providerKey:existing.providerKey,checkoutUrl:existing.checkoutUrl};
   const providerKey='pi_'+randomBytes(8).toString('hex');
   const record={providerKey,intentKey,amount,currency,reference,expiresAt,status:'pending',checkoutUrl:'https://pay.fixture.invalid/checkout/'+providerKey};
   await store.put(key(intentKey),Buffer.from(JSON.stringify(record)));await store.put(key(providerKey),Buffer.from(JSON.stringify(record)));
   return {providerKey,checkoutUrl:record.checkoutUrl};
  },
  // Server-to-server truth: what the provider says about the key, never what the browser says.
  async verify(providerKey){const r=await read(providerKey);if(!r)throw new DomainError('NOT_FOUND','Unknown payment intent at the provider.');return {status:r.status,amount:r.amount,currency:r.currency,payee:r.payee||'merchant-fixture',paidAt:r.paidAt||null};},
  // Test hook: the provider marks an intent paid (or otherwise) as the customer's bank would.
  async settleAtProvider(providerKey,{amount,currency,status='paid',payee='merchant-fixture'}){const r=await read(providerKey);if(!r)throw new DomainError('NOT_FOUND','Unknown intent.');const next={...r,status,paidAt:new Date().toISOString(),amount:amount??r.amount,currency:currency??r.currency,payee};await store.dispose(key(providerKey));await store.put(key(providerKey),Buffer.from(JSON.stringify(next)));return next;},
  sign(timestamp,body){return createHmac('sha256',secret).update(timestamp+'.'+body).digest('hex');},
  verifySignature(timestamp,body,signature){const expected=createHmac('sha256',secret).update(timestamp+'.'+body).digest('hex');return expected.length===String(signature||'').length&&expected===signature;}
 };
}
export function messagingProviderFromEnv(env,store){
 const name=env.MESSAGING_ADAPTER||env.MAIL_ADAPTER||'local';
 if(name==='local')return localMessagingProvider(store);
 throw new DomainError('FEATURE_NOT_ENABLED','Messaging adapter '+name+' is not configured in this release; only the local mail adapter exists.');
}
export function paymentProviderFromEnv(env,store){
 const name=env.PAYMENT_ADAPTER||'fixture';
 if(name==='fixture')return fixturePaymentProvider(store,env.PAYMENT_WEBHOOK_SECRET||'fixture-webhook-secret');
 throw new DomainError('FEATURE_NOT_ENABLED','Payment adapter '+name+' is not configured in this release; only the fixture provider exists.');
}
