// Model provider adapters (P12). A provider receives masked evidence text
// and the resources the requester may see, plus the tool allowlist of the
// feature, and answers with proposed fields, an optional prose answer and
// the tools it wants to call. Everything a provider returns is data: the
// domain gates every tool request against the allowlist, validates every
// field against the tool schema and stores only minimized output.
//
// The `fixture` provider is deterministic and local: it reads `key: value`
// lines from the evidence text, marks a value uncertain when the line ends
// with '?' or is blank, treats instructions inside the document as data
// (while echoing any "call tool <name>" phrase as a tool request so the gate
// is exercised), simulates a timeout for evidence named *slow* and charges
// one cent per kilobyte. A hosted provider arrives as a separate adapter
// behind the same interface; none is configured in this release.
import {DomainError} from './core.mjs';

const CAPTURE_KEYS={supplier:'supplierName',tin:'supplierTin',number:'invoiceNumber',date:'documentDate',total:'gross',vat:'tax',net:'net',withholding:'withholding',reference:'reference'};
export function fixtureProvider(){
 return {
  name:'fixture',modelVersion:'fixture-1',promptVersion:'p12.1',toolSchemaVersion:'tools-1',
  async complete({feature,evidence,resources,question,tools},{signal}={}){
   if(evidence.some(e=>/slow/i.test(e.filename))){
    await new Promise((resolve,reject)=>{const t=setTimeout(resolve,60000);signal?.addEventListener('abort',()=>{clearTimeout(t);reject(new DomainError('DEPENDENCY_UNAVAILABLE','The model provider timed out.'));},{once:true});});
   }
   const bytes=evidence.reduce((s,e)=>s+e.text.length,0)+(question||'').length;
   const costMinor=Math.max(1,Math.ceil(bytes/1000));
   const toolRequests=[];const fields=[];
   for(const e of evidence){
    const lines=e.text.split(/\r?\n/);
    lines.forEach((line,i)=>{
     for(const tool of line.matchAll(/call tool ([a-z_]+)/gi))toolRequests.push({tool:tool[1].toLowerCase(),locator:e.filename+'#L'+(i+1)});
     const m=/^([A-Za-z ]{2,30}):\s*(.*)$/.exec(line.trim());
     if(!m)return;
     const key=m[1].trim().toLowerCase(),raw=m[2].trim();
     if(feature==='capture'&&CAPTURE_KEYS[key]){const uncertain=raw===''||raw.endsWith('?');fields.push({path:CAPTURE_KEYS[key],value:raw.replace(/\?$/,'').trim()||null,evidenceId:e.id,sourceLocator:e.filename+'#L'+(i+1),uncertainty:uncertain?'high':/MASKED/.test(raw)?'unknown':'low'});}
    });
   }
   if(feature==='coding')for(const r of resources)for(const [i,l] of (r.lines||[]).entries())if(l.suggestedAccountId)fields.push({path:'lines.'+i+'.accountId',value:l.suggestedAccountId,evidenceId:r.evidenceId,sourceLocator:'document:'+r.id+'#line'+(i+1),uncertainty:l.uncertainty||'medium'});
   if(feature==='matching')for(const r of resources)if(r.candidate)fields.push({path:'lines.'+r.id+'.openItemId',value:r.candidate,evidenceId:r.evidenceId,sourceLocator:'statement-line:'+r.id,uncertainty:r.ambiguous?'high':'low'});
   return {toolRequests,fields,answer:null,costMinor,modelVersion:'fixture-1'};
  }
 };
}
export function aiProviderFromEnv(env=process.env){
 const name=env.AI_PROVIDER||'fixture';
 if(name==='fixture')return fixtureProvider();
 throw new DomainError('FEATURE_NOT_ENABLED','Model provider '+name+' is not configured in this release; only the local fixture adapter exists.');
}
