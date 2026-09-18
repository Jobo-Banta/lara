"use client";
// Shared primitives for the production workspace screens: typed API client,
// idempotent command runner, error panel, draft editor, table and list hook.
import {useCallback,useEffect,useMemo,useRef,useState,type FormEvent,type ReactNode} from 'react';

export type Row=Record<string,any>;
export type ApiError={code:string,message:string,traceId?:string,fieldErrors:{path:string,message:string}[],retryable:boolean,resourceVersion?:number};
export const uuid=()=>crypto.randomUUID();
export const when=(v?:string)=>v?new Date(v).toLocaleString('en-PH',{timeZone:'Asia/Manila',dateStyle:'medium',timeStyle:'short'}):'—';
export const input=(label:string,name:string,value='',type='text',extra:Row={})=><label key={name}>{label}<input name={name} defaultValue={value} type={type} {...extra}/></label>;
export const select=(label:string,name:string,options:[string,string][],value='')=><label key={name}>{label}<select name={name} defaultValue={value}>{options.map(([v,l])=><option key={v} value={v}>{l}</option>)}</select></label>;

export class RequestError extends Error{status:number;body:ApiError;constructor(status:number,body:ApiError){super(body.message);this.status=status;this.body=body;}}
export async function api(method:string,path:string,{body,entityId,ifMatch,key,raw,headers={}}:{body?:unknown,entityId?:string|null,ifMatch?:number|string,key?:string,raw?:BodyInit,headers?:Record<string,string>}={}){
 const h:Record<string,string>={...headers};
 if(entityId)h['x-entity-id']=entityId;
 if(ifMatch!==undefined)h['if-match']='"'+ifMatch+'"';
 if(key)h['idempotency-key']=key;
 if(!raw&&body!==undefined)h['content-type']='application/json';
 const response=await fetch('/api/v1'+path,{method,headers:h,body:raw??(body===undefined?undefined:JSON.stringify(body)),cache:'no-store'});
 const text=await response.text();
 let data:any=null;try{data=text?JSON.parse(text):null;}catch{data={code:'DEPENDENCY_UNAVAILABLE',message:'Unexpected response.',fieldErrors:[],retryable:true};}
 if(!response.ok)throw new RequestError(response.status,data||{code:'DEPENDENCY_UNAVAILABLE',message:'Request failed.',fieldErrors:[],retryable:true});
 return {data,etag:response.headers.get('etag')};
}
export const asError=(e:unknown):ApiError=>e instanceof RequestError?e.body:{code:'DEPENDENCY_UNAVAILABLE',message:'Connection interrupted. Retry when available.',fieldErrors:[],retryable:true};

// Command runner: one idempotency key per attempt series so a retry after a
// dropped response replays the committed result instead of repeating it.
export function useCommand(onDone:()=>Promise<unknown>|unknown){
 const [busy,setBusy]=useState(false),[error,setError]=useState<ApiError|null>(null),pending=useRef<{method:string,path:string,options:Row}|null>(null);
 const run=useCallback(async(method:string,path:string,options:Row={})=>{
  const attempt={method,path,options:{...options,key:options.key||pending.current?.options.key||uuid()}};pending.current=attempt;setBusy(true);setError(null);
  try{const r=await api(method,path,attempt.options);pending.current=null;await onDone();return r;}
  catch(e){const err=asError(e);if(!err.retryable&&err.code!=='VERSION_CONFLICT')pending.current=null;setError(err);return null;}
  finally{setBusy(false);}
 },[onDone]);
 const retry=useCallback(()=>pending.current?run(pending.current.method,pending.current.path,pending.current.options):Promise.resolve(null),[run]);
 const reload=useCallback(()=>{setError(null);pending.current=null;void onDone();},[onDone]);
 return {run,retry,busy,error,clear:()=>setError(null),reload,canRetry:!!pending.current};
}

export function ErrorPanel({error,onRetry,onReload,canRetry}:{error:ApiError|null,onRetry?:()=>void,onReload?:()=>void,canRetry?:boolean}){
 if(!error)return null;
 const title=error.code==='FORBIDDEN'?'Not permitted':error.code==='VERSION_CONFLICT'?'Someone else changed this record':error.code==='RATE_LIMITED'?'Slow down':error.code==='FEATURE_NOT_ENABLED'?'Not enabled in this release':'Action did not complete';
 return <section role="alert" className="error-panel"><h2>{title}</h2><p>{error.message}</p>{error.fieldErrors?.length>0&&<ul>{error.fieldErrors.map((f,i)=><li key={i}><strong>{f.path||'request'}</strong>: {f.message}</li>)}</ul>}{error.code==='VERSION_CONFLICT'&&<p>Your entries are kept in this form. Reload to see the latest version, then apply your change again.</p>}<div className="action-row">{onReload&&<button type="button" onClick={onReload}>Reload latest</button>}{canRetry&&error.retryable&&onRetry&&<button type="button" onClick={onRetry}>Retry the same request</button>}</div>{error.traceId&&<p className="eyebrow">Reference {error.traceId}</p>}</section>;
}

// Draft form: values survive a failed save in the DOM and in sessionStorage
// (per record), never as the system of record.
export function Editor({id,children,onSave,label='Save',disabled=false,resetOnSave=false}:{id:string,children:ReactNode,onSave:(data:Row)=>Promise<boolean>,label?:string,disabled?:boolean,resetOnSave?:boolean}){
 const ref=useRef<HTMLFormElement>(null),[dirty,setDirty]=useState(false),[saving,setSaving]=useState(false);
 useEffect(()=>{try{const saved=sessionStorage.getItem('lara-ws-draft:'+id);if(saved&&ref.current){const values=JSON.parse(saved);for(const field of Array.from(ref.current.elements)){if((field instanceof HTMLInputElement&&field.type!=='file')||field instanceof HTMLTextAreaElement||field instanceof HTMLSelectElement){if(values[field.name]!==undefined)field.value=values[field.name];}}setDirty(true);}}catch{}},[id]);
 // Create forms (no initial record) clear after a successful save so the next
 // entry starts clean; edit forms keep the saved values on screen.
 async function submit(e:FormEvent<HTMLFormElement>){e.preventDefault();const form=e.currentTarget;setSaving(true);try{if(await onSave(Object.fromEntries(new FormData(form)))){try{sessionStorage.removeItem('lara-ws-draft:'+id);}catch{}setDirty(false);if(resetOnSave&&form.isConnected)form.reset();}}finally{setSaving(false);}}
 return <form ref={ref} className="demo-form" onSubmit={submit} onChange={()=>{setDirty(true);try{if(ref.current)sessionStorage.setItem('lara-ws-draft:'+id,JSON.stringify(Object.fromEntries(Array.from(new FormData(ref.current).entries()).filter(([,v])=>typeof v==='string'))));}catch{}}}>{children}<p role="status">{saving?'Saving…':dirty?'Unsaved changes are kept in this tab.':'Up to date.'}</p><button disabled={saving||disabled} type="submit">{label}</button></form>;
}
export const table=(head:string[],rows:ReactNode[][],empty:string)=><div className="table-scroll" tabIndex={0} role="region" aria-label={head.join(', ')+' table'}><table><thead><tr>{head.map(h=><th key={h}>{h}</th>)}</tr></thead><tbody>{rows.map((r,i)=><tr key={i}>{r.map((c,j)=><td key={j}>{c}</td>)}</tr>)}</tbody></table>{!rows.length&&<p>{empty}</p>}</div>;
export const link=(href:string,label:string)=><a href={href}>{label}</a>;

export function useList(path:string,entityId:string|null,tick:number,query:Record<string,string>={}){
 const [state,setState]=useState<{items:Row[]|null,error:ApiError|null}>({items:null,error:null});
 const qs=useMemo(()=>{const p=new URLSearchParams();for(const [k,v] of Object.entries(query))if(v)p.set(k,v);p.set('limit','200');return '?'+p.toString();},[JSON.stringify(query)]);
 useEffect(()=>{let live=true;if(!entityId){setState({items:[],error:null});return;}api('GET',path+qs,{entityId}).then(r=>{if(live)setState({items:r.data.items,error:null});}).catch(e=>{if(live)setState({items:null,error:asError(e)});});return()=>{live=false;};},[path,qs,entityId,tick]);
 return state;
}
export const Loading=()=><p role="status">Loading…</p>;

