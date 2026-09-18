import {randomBytes} from 'node:crypto';
export function requestTrace() {
 return {traceId:randomBytes(16).toString('hex'),spanId:randomBytes(8).toString('hex'),started:BigInt(Date.now())*1000000n};
}
export async function exportTrace(trace,status,endpoint=process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
 if(!endpoint)return;
 const payload={resourceSpans:[{resource:{attributes:[{key:'service.name',value:{stringValue:'lara-api'}}]},scopeSpans:[{scope:{name:'lara.engineering'},spans:[{traceId:trace.traceId,spanId:trace.spanId,name:'http.request',kind:2,startTimeUnixNano:String(trace.started),endTimeUnixNano:String(BigInt(Date.now())*1000000n),attributes:[{key:'http.response.status_code',value:{intValue:String(status)}}],status:{code:status>=500?2:1}}]}]}]};
 try{
  const result=await fetch(endpoint.replace(/\/$/,'')+'/v1/traces',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(2000)});
  if(!result.ok)throw Error('Exporter rejected trace');
 }catch{console.error(JSON.stringify({service:'api',event:'telemetry_unavailable',severity:'warning'}));}
}
