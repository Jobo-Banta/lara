"use client";
// P17 local operations. Leases: contracts on a recurring billing schedule
// with escalation steps, the rent schedule, billing per period, deposits and
// advances received, applied (by another principal) or refunded. Statutory
// discounts: eligibility per customer and category on identity evidence,
// approval, and the discount applied to a draft invoice per the approved
// profile with the recorded lines. Channels: marketplace and e-wallet
// payouts reconciled to imported sales and posted once; POS machines and
// closings matched to deposits. Payroll: imported batches whose totals tie,
// restricted records, posting per the approved profile, remittances per
// agency. Local obligations: due dates, payment and filing evidence. Each
// screen shows its authoritative source; nothing bypasses the API.
import {useEffect,useState} from 'react';
import {api,asError,useCommand,ErrorPanel,Editor,table,useList,Loading,input,select,when,type Row,type ApiError} from './workspace-kit';
import {amount} from './workspace-fx';

type Ctx={entityId:string,me:Row,can:(p:string)=>boolean,tick:number,refresh:()=>void};
const today=()=>new Date().toISOString().slice(0,10);
const short=(id?:string|null)=>id?id.slice(0,8):'—';
const MONEY={required:true,inputMode:'decimal',pattern:'[0-9]{1,18}(\\.[0-9]{1,6})?'};
const MONEY0={inputMode:'decimal',pattern:'[0-9]{1,18}(\\.[0-9]{1,6})?'};
function NotEnabled({me,feature,after}:{me:Row,feature:string,after:string}){return <section className="demo-card"><h2>{feature} not enabled</h2><p>This feature release is activated per entity after {after}, with its authority, provider and accounting examples and source formats reviewed. {me.permissions.includes('capability.activate')?<a href="/settings/capabilities">Open capabilities</a>:'Ask a controller to activate it.'}</p></section>;}
const evidenceSelect=(items:Row[]|null,name:string,label:string,required=true)=><label>{label}<select name={name} required={required}><option value="">Select evidence</option>{(items||[]).map((e:Row)=><option key={e.id} value={e.id}>{e.filename}</option>)}</select></label>;

// P17A leases.
export function Leases({entityId,me,can,tick,refresh}:Ctx){
 if(!me.capabilities.includes('leases'))return <NotEnabled me={me} feature="Lease billing" after="sales and recurring schedules"/>;
 const leases=useList('/leases',entityId,tick);
 const parties=useList('/parties',entityId,tick);
 const schedules=useList('/schedules',entityId,tick);
 const evidence=useList('/evidence',entityId,tick,{status:'available'});
 const invoices=useList('/invoices',entityId,tick);
 const cmd=useCommand(refresh);
 const [open,setOpen]=useState<string|null>(null),[detail,setDetail]=useState<{schedule:Row,events:Row[]}|null>(null),[detailError,setDetailError]=useState<ApiError|null>(null);
 useEffect(()=>{let live=true;setDetail(null);if(!open)return;Promise.all([api('GET','/leases/'+open+'/schedule',{entityId}),api('GET','/leases/'+open+'/events',{entityId})]).then(([s,e])=>{if(live){setDetail({schedule:s.data,events:e.data.items});setDetailError(null);}}).catch(e=>{if(live)setDetailError(asError(e));});return()=>{live=false;};},[open,entityId,tick]);
 const customers=(parties.items||[]).filter((p:Row)=>(p.roles||[]).includes('customer'));
 const lease=(leases.items||[]).find((l:Row)=>l.id===open)||null;
 return <>
  <ErrorPanel error={cmd.error||leases.error||detailError} onRetry={cmd.retry} onReload={cmd.reload} canRetry={cmd.canRetry}/>
  <p>Authoritative source: the signed lease and the approved withholding and lease profiles. Deposits and advances are liabilities until another principal applies or refunds them; rent is recognized by the invoice alone. Lessee right-of-use measurement is not part of this release.</p>
  {can('lease.create')&&<section className="demo-card"><h2>Draft a lease</h2>
   <Editor id={'lease-new'+entityId} label="Save lease draft" resetOnSave onSave={async d=>{const escalation=[1,2].filter(i=>d['ef'+i]&&d['er'+i]).map(i=>({effectiveFrom:d['ef'+i],rate:d['er'+i]}));return !!await cmd.run('POST','/leases',{entityId,body:{partyId:d.partyId,startDate:d.startDate,endDate:d.endDate,currency:'PHP',deposit:d.deposit||'0.00',advance:d.advance||'0.00',billingScheduleId:d.billingScheduleId,withholdingProfileVersion:d.withholdingProfileVersion,evidenceIds:[d.evidenceId],escalation}});}}>
    <label>Lessee<select name="partyId" required><option value="">Select</option>{customers.map((p:Row)=><option key={p.id} value={p.id}>{p.legalName}</option>)}</select></label>
    {input('Term start','startDate',today(),'date',{required:true})}{input('Term end','endDate','','date',{required:true})}{input('Deposit','deposit','0.00','text',MONEY0)}{input('Advance','advance','0.00','text',MONEY0)}
    <label>Billing schedule (recurring invoice)<select name="billingScheduleId" required><option value="">Select</option>{(schedules.items||[]).filter((s:Row)=>s.kind==='recurring_invoice').map((s:Row)=><option key={s.id} value={s.id}>{s.kind} {s.currency} {s.basisAmount} · {s.state}</option>)}</select></label>
    {input('Withholding profile version','withholdingProfileVersion','lease-wht-2026','text',{required:true})}
    {[1,2].map(i=><div key={i} className="action-row">{input('Escalation '+i+' from','ef'+i,'','date')}{input('Escalation '+i+' rate','er'+i,'','text',{inputMode:'decimal',pattern:'[0-9]{1,12}(\\.[0-9]{1,12})?'})}</div>)}
    {evidenceSelect(evidence.items,'evidenceId','Signed lease')}
   </Editor></section>}
  <h2>Leases</h2>
  {leases.items===null?<Loading/>:table(['Lessee','Term','Base rent','Deposit','Advance','State','Actions'],leases.items.map((l:Row)=>[customers.find((c:Row)=>c.id===l.partyId)?.legalName||short(l.partyId),l.startDate+' → '+l.endDate,amount(l.baseRent,l.currency),amount(l.deposit,l.currency),amount(l.advance,l.currency),l.state,<div key="a" className="action-row"><button type="button" onClick={()=>setOpen(open===l.id?null:l.id)}>{open===l.id?'Close':'Open'}</button>{l.state==='draft'&&can('lease.approve')&&<button disabled={cmd.busy} onClick={()=>void cmd.run('POST','/leases/'+l.id+'/approve',{entityId,ifMatch:l.version,body:{decision:'approve',contentVersion:l.contentVersion}})}>Approve</button>}</div>]),'No lease yet.')}
  {lease&&(detail===null?<Loading/>:<>
   <section className="demo-card"><h2>Rent schedule · total {amount(detail.schedule.total,lease.currency)}</h2>
    {table(['Period','Rent','Escalation','Billed','Actions'],detail.schedule.lines.map((s:Row)=>[s.periodStart+' → '+s.periodEnd,amount(s.rent,lease.currency),s.rate==='0'?'—':s.rate,s.billed?'yes':'no',<div key="a" className="action-row">{!s.billed&&lease.state==='approved'&&can('lease.edit')&&<button disabled={cmd.busy} onClick={()=>void cmd.run('POST','/leases/'+lease.id+'/bill',{entityId,body:{periodStart:s.periodStart,periodEnd:s.periodEnd,accountingDate:s.periodStart,evidenceIds:[]}})}>Bill</button>}</div>]),'')}
    <p>Deposit held {amount(detail.schedule.depositHeld,lease.currency)} of {amount(detail.schedule.deposit,lease.currency)} · advance held {amount(detail.schedule.advanceHeld,lease.currency)} of {amount(detail.schedule.advance,lease.currency)}.</p>
   </section>
   <section className="demo-card"><h2>Deposits and advances</h2>
    {table(['Kind','Amount','Date','Entry','Invoice','Approved by'],detail.events.map((e:Row)=>[e.kind.replace('_',' '),amount(e.amount,lease.currency),e.eventDate,short(e.entryId),e.documentId?<a key="d" href={'/sales/invoices/'+e.documentId}>{short(e.documentId)}</a>:'—',short(e.approvedBy)]),'No event yet.')}
    {lease.state==='approved'&&can('lease.edit')&&<Editor id={'ev'+lease.id} label="Record event" resetOnSave onSave={async d=>!!await cmd.run('POST','/leases/'+lease.id+'/events',{entityId,body:{kind:d.kind,amount:d.amount,eventDate:d.eventDate,...(d.documentId?{documentId:d.documentId}:{}),evidenceIds:d.evidenceId?[d.evidenceId]:[],...(d.reason?{reason:d.reason}:{})}})}>
     {select('Kind','kind',[['deposit_received','Deposit received'],['advance_received','Advance received'],['deposit_applied','Deposit applied to a rent invoice'],['advance_applied','Advance applied to a rent invoice'],['deposit_refunded','Deposit refunded']],'deposit_received')}
     {input('Amount','amount','','text',MONEY)}{input('Date','eventDate',today(),'date',{required:true})}
     <label>Posted rent invoice (for application)<select name="documentId"><option value="">—</option>{(invoices.items||[]).filter((i:Row)=>i.partyId===lease.partyId&&i.state==='posted').map((i:Row)=><option key={i.id} value={i.id}>{i.officialNumber||short(i.id)} · {i.gross}</option>)}</select></label>
     {evidenceSelect(evidence.items,'evidenceId','Bank or cash evidence',false)}{input('Reason','reason','','text')}
    </Editor>}
   </section>
  </>)}
 </>;
}

// P17B statutory discounts.
export function Discounts({entityId,me,can,tick,refresh}:Ctx){
 if(!me.capabilities.includes('statutory_discounts'))return <NotEnabled me={me} feature="Statutory discounts" after="sales and compliance"/>;
 const eligibility=useList('/discount-eligibility',entityId,tick);
 const parties=useList('/parties',entityId,tick);
 const evidence=useList('/evidence',entityId,tick,{status:'available'});
 const invoices=useList('/invoices',entityId,tick);
 const cmd=useCommand(refresh);
 const [open,setOpen]=useState<string|null>(null),[lines,setLines]=useState<Row|null>(null),[linesError,setLinesError]=useState<ApiError|null>(null);
 useEffect(()=>{let live=true;setLines(null);if(!open)return;api('GET','/invoices/'+open+'/statutory-discount',{entityId}).then(r=>{if(live){setLines(r.data);setLinesError(null);}}).catch(e=>{if(live)setLinesError(asError(e));});return()=>{live=false;};},[open,entityId,tick]);
 const customers=(parties.items||[]).filter((p:Row)=>(p.roles||[]).includes('customer'));
 return <>
  <ErrorPanel error={cmd.error||eligibility.error||linesError} onRetry={cmd.retry} onReload={cmd.reload} canRetry={cmd.canRetry}/>
  <p>Authoritative source: the advisor-approved discount profile per category (rate, basis, exemption, required identity evidence and golden cases). Identity references are stored masked; unsupported categories have no profile and cannot be recorded.</p>
  {can('discount_eligibility.create')&&<section className="demo-card"><h2>Record eligibility</h2>
   <Editor id={'elig-new'+entityId} label="Save eligibility" resetOnSave onSave={async d=>!!await cmd.run('POST','/discount-eligibility',{entityId,body:{partyId:d.partyId,category:d.category,profileVersion:d.profileVersion,validUntil:d.validUntil,evidenceIds:[d.evidenceId],...(d.idReference?{idReference:d.idReference}:{})}})}>
    <label>Customer<select name="partyId" required><option value="">Select</option>{customers.map((p:Row)=><option key={p.id} value={p.id}>{p.legalName}</option>)}</select></label>
    {input('Category','category','senior_citizen','text',{required:true,pattern:'[a-z][a-z0-9_]{0,31}'})}{input('Profile version','profileVersion','sc-2026','text',{required:true})}{input('Valid until','validUntil','','date',{required:true})}{input('ID reference (stored masked)','idReference','','text')}
    {evidenceSelect(evidence.items,'evidenceId','Identity evidence')}
   </Editor></section>}
  <h2>Eligibility</h2>
  {eligibility.items===null?<Loading/>:table(['Customer','Category','Profile','Valid until','ID','State','Actions'],eligibility.items.map((e:Row)=>[customers.find((c:Row)=>c.id===e.partyId)?.legalName||short(e.partyId),e.category,e.profileVersion,e.validUntil,e.idReferenceMasked||'—',e.state,<div key="a" className="action-row">{e.state==='draft'&&can('discount_eligibility.approve')&&<button disabled={cmd.busy} onClick={()=>void cmd.run('POST','/discount-eligibility/'+e.id+'/approve',{entityId,ifMatch:e.version,body:{decision:'approve',contentVersion:e.contentVersion}})}>Approve</button>}{e.state==='draft'&&can('discount_eligibility.approve')&&<Editor id={'rej'+e.id} label="Reject" onSave={async d=>!!await cmd.run('POST','/discount-eligibility/'+e.id+'/approve',{entityId,ifMatch:e.version,body:{decision:'reject',contentVersion:e.contentVersion,reason:d.reason}})}>{input('Reason','reason','','text',{required:true})}</Editor>}</div>]),'No eligibility recorded.')}
  <section className="demo-card"><h2>Apply to a draft invoice</h2>
   <label>Draft invoice<select value={open||''} onChange={e=>setOpen(e.target.value||null)}><option value="">Select</option>{(invoices.items||[]).filter((i:Row)=>['draft','changes_requested','submitted','approved','posted'].includes(i.state)).map((i:Row)=><option key={i.id} value={i.id}>{(i.officialNumber||short(i.id))+' · '+(customers.find((c:Row)=>c.id===i.partyId)?.legalName||'')+' · '+i.gross+' · '+i.state}</option>)}</select></label>
   {open&&can('discount_eligibility.approve')&&<div className="action-row"><button disabled={cmd.busy} onClick={()=>void cmd.run('POST','/invoices/'+open+'/statutory-discount',{entityId,body:{}})}>Apply statutory discount</button></div>}
   {open&&(lines===null?<Loading/>:table(['Line','Category','Profile','Basis','Rate','Discount','Exemption','Golden case'],lines.items.map((l:Row)=>[String(l.lineNo),l.category,l.profileVersion,amount(l.basis),l.rate,amount(l.amount),l.exemptionProfile||'—',l.goldenCaseId||'—']),'No discount line on this invoice.'))}
  </section>
 </>;
}

// P17C channels, payouts, POS.
export function Channels({entityId,me,can,tick,refresh}:Ctx){
 if(!me.capabilities.includes('marketplace_pos'))return <NotEnabled me={me} feature="Marketplace and POS integration" after="sales and treasury"/>;
 const channels=useList('/channels',entityId,tick);
 const payouts=useList('/payouts',entityId,tick);
 const machines=useList('/pos-machines',entityId,tick);
 const closings=useList('/pos-closings',entityId,tick);
 const accounts=useList('/accounts',entityId,tick);
 const branches=useList('/branches',entityId,tick);
 const evidence=useList('/evidence',entityId,tick,{status:'available'});
 const collections=useList('/collections',entityId,tick);
 const cmd=useCommand(refresh);
 const acct=(name:string,label:string,cat?:string)=><label>{label}<select name={name} required><option value="">Select</option>{(accounts.items||[]).filter((a:Row)=>!cat||a.category===cat).map((a:Row)=><option key={a.id} value={a.id}>{a.code} {a.name}</option>)}</select></label>;
 return <>
  <ErrorPanel error={cmd.error||channels.error||payouts.error||closings.error} onRetry={cmd.retry} onReload={cmd.reload} canRetry={cmd.canRetry}/>
  <p>Authoritative source: the channel statement and the POS readings. A payout posts only after its gross reconciles to the sales already imported, so revenue is never posted twice; a replay of the same statement is refused.</p>
  {can('channel.create')&&<section className="demo-card"><h2>Register a channel</h2>
   <Editor id={'ch-new'+entityId} label="Register channel" resetOnSave onSave={async d=>!!await cmd.run('POST','/channels',{entityId,body:{code:d.code,name:d.name,kind:d.kind,provider:d.provider,mappingVersion:d.mappingVersion,receivableAccountId:d.receivableAccountId,feeAccountId:d.feeAccountId,withholdingAccountId:d.withholdingAccountId,clearingAccountId:d.clearingAccountId}})}>
    {input('Code','code','','text',{required:true,pattern:'[A-Za-z0-9._-]{1,32}'})}{input('Name','name','','text',{required:true})}{select('Kind','kind',[['marketplace','Marketplace'],['ewallet','E-wallet'],['pos','POS']],'marketplace')}{input('Provider','provider','','text',{required:true})}{input('Mapping version','mappingVersion','channel-2026','text',{required:true})}
    {acct('receivableAccountId','Channel receivable (sales imported here)','asset')}{acct('feeAccountId','Platform fees','expense')}{acct('withholdingAccountId','Tax withheld by the platform (creditable)','asset')}{acct('clearingAccountId','Payout clearing / cash','asset')}
   </Editor></section>}
  <h2>Channels</h2>
  {channels.items===null?<Loading/>:table(['Code','Name','Kind','Provider','Mapping'],channels.items.map((c:Row)=>[c.code,c.name,c.kind,c.provider,c.mappingVersion]),'No channel yet.')}
  {can('payout.create')&&channels.items&&channels.items.length>0&&<section className="demo-card"><h2>Record a payout</h2>
   <Editor id={'po-new'+entityId} label="Record payout" resetOnSave onSave={async d=>!!await cmd.run('POST','/payouts',{entityId,body:{channelId:d.channelId,sourceId:d.sourceId,periodStart:d.periodStart,periodEnd:d.periodEnd,gross:d.gross,fees:d.fees||'0.00',withholding:d.withholding||'0.00',otherDeductions:d.otherAmount?[{kind:d.otherKind||'other',amount:d.otherAmount}]:[],net:d.net,evidenceIds:[d.evidenceId]}})}>
    <label>Channel<select name="channelId" required>{channels.items.map((c:Row)=><option key={c.id} value={c.id}>{c.code} {c.name}</option>)}</select></label>
    {input('Statement reference','sourceId','','text',{required:true})}{input('Period start','periodStart','','date',{required:true})}{input('Period end','periodEnd','','date',{required:true})}
    {input('Gross sales','gross','','text',MONEY)}{input('Platform fees','fees','0.00','text',MONEY0)}{input('Tax withheld','withholding','0.00','text',MONEY0)}{input('Other deduction kind','otherKind','','text')}{input('Other deduction amount','otherAmount','','text',MONEY0)}{input('Net payout','net','','text',MONEY)}
    {evidenceSelect(evidence.items,'evidenceId','Statement evidence')}
   </Editor></section>}
  <h2>Payouts</h2>
  {payouts.items===null?<Loading/>:table(['Channel','Reference','Period','Gross','Fees','Withheld','Net','Sales','Difference','State','Actions'],payouts.items.map((p:Row)=>[(channels.items||[]).find((c:Row)=>c.id===p.channelId)?.code||short(p.channelId),p.sourceId,p.periodStart+' → '+p.periodEnd,amount(p.gross),amount(p.fees),amount(p.withholding),amount(p.net),p.salesTotal?amount(p.salesTotal):'—',p.difference?amount(p.difference):'—',p.state+(p.exceptionReason?' · '+p.exceptionReason:''),<div key="a" className="action-row">
   {['imported','exception','reconciled'].includes(p.state)&&can('payout.reconcile')&&<Editor id={'rec'+p.id+p.version} label="Reconcile" onSave={async d=>!!await cmd.run('POST','/payouts/'+p.id+'/reconcile',{entityId,ifMatch:p.version,body:{salesReferenceIds:String(d.refs).split(/[\s,]+/).filter(Boolean)}})}>{input('Imported sales ids (invoices or journal entries)','refs','','text',{required:true})}</Editor>}
   {p.state==='reconciled'&&can('payout.post')&&<button disabled={cmd.busy} onClick={()=>void cmd.run('POST','/payouts/'+p.id+'/post',{entityId,ifMatch:p.version,body:{}})}>Post</button>}
  </div>]),'No payout yet.')}
  {can('channel.create')&&<section className="demo-card"><h2>Register a POS machine</h2>
   <Editor id={'pm-new'+entityId} label="Register machine" resetOnSave onSave={async d=>!!await cmd.run('POST','/pos-machines',{entityId,body:{branchId:d.branchId,brand:d.brand,model:d.model,serialNumber:d.serialNumber,machineIdentificationNumber:d.min,permitNumber:d.permitNumber}})}>
    <label>Branch<select name="branchId" required>{(branches.items||[]).map((b:Row)=><option key={b.id} value={b.id}>{b.code} {b.name}</option>)}</select></label>{input('Brand','brand','','text',{required:true})}{input('Model','model','','text',{required:true})}{input('Serial number','serialNumber','','text',{required:true})}{input('MIN','min','','text',{required:true})}{input('Permit number','permitNumber','','text',{required:true})}
   </Editor></section>}
  <h2>POS machines</h2>
  {machines.items===null?<Loading/>:table(['Brand','Model','Serial','MIN','Permit'],machines.items.map((m:Row)=>[m.brand,m.model,m.serialNumber,m.machineIdentificationNumber,m.permitNumber]),'No machine registered.')}
  {can('pos_closing.create')&&machines.items&&machines.items.length>0&&<section className="demo-card"><h2>Record a closing</h2>
   <Editor id={'pc-new'+entityId} label="Record closing" resetOnSave onSave={async d=>!!await cmd.run('POST','/pos-closings',{entityId,body:{machineId:d.machineId,shiftDate:d.shiftDate,shiftNo:Number(d.shiftNo),readingKind:d.readingKind,beginningReading:d.beginningReading,endingReading:d.endingReading,cashCounted:d.cashCounted,nonCash:d.nonCash||'0.00',evidenceIds:[d.evidenceId]}})}>
    <label>Machine<select name="machineId" required>{machines.items.map((m:Row)=><option key={m.id} value={m.id}>{m.brand} {m.serialNumber}</option>)}</select></label>{input('Shift date','shiftDate',today(),'date',{required:true})}{input('Shift number','shiftNo','1','number',{required:true,min:1})}{select('Reading','readingKind',[['Z','Z (end of day)'],['X','X (mid-day)']],'Z')}
    {input('Beginning reading','beginningReading','','text',MONEY)}{input('Ending reading','endingReading','','text',MONEY)}{input('Cash counted','cashCounted','','text',MONEY)}{input('Non-cash','nonCash','0.00','text',MONEY0)}{evidenceSelect(evidence.items,'evidenceId','Reading tape')}
   </Editor></section>}
  <h2>Closings</h2>
  {closings.items===null?<Loading/>:table(['Machine','Shift','Reading','Gross','Cash counted','Deposit','State','Actions'],closings.items.map((c:Row)=>[(machines.items||[]).find((m:Row)=>m.id===c.machineId)?.serialNumber||short(c.machineId),c.shiftDate+' #'+c.shiftNo,c.readingKind,amount(c.grossSales),amount(c.cashCounted),c.settlementId?short(c.settlementId)+(c.depositDifference&&c.depositDifference!=='0.00'?' Δ '+amount(c.depositDifference):''):'—',c.state+(c.exceptionReason?' · '+c.exceptionReason:''),<div key="a" className="action-row">
   {c.state==='draft'&&can('pos_closing.approve')&&<button disabled={cmd.busy} onClick={()=>void cmd.run('POST','/pos-closings/'+c.id+'/approve',{entityId,ifMatch:c.version,body:{decision:'approve',contentVersion:c.contentVersion}})}>Approve</button>}
   {['approved','exception'].includes(c.state)&&can('pos_closing.approve')&&<Editor id={'match'+c.id+c.version} label="Match deposit" onSave={async d=>!!await cmd.run('POST','/pos-closings/'+c.id+'/match',{entityId,ifMatch:c.version,body:{settlementId:d.settlementId}})}><label>Posted deposit<select name="settlementId" required><option value="">Select</option>{(collections.items||[]).filter((s:Row)=>s.state==='posted').map((s:Row)=><option key={s.id} value={s.id}>{s.valueDate} · {s.cashAmount}</option>)}</select></label></Editor>}
  </div>]),'No closing yet.')}
 </>;
}

// P17D payroll data and remittances.
export function Payroll({entityId,me,can,tick,refresh}:Ctx){
 if(!me.capabilities.includes('payroll_data'))return <NotEnabled me={me} feature="Payroll data and remittances" after="the general ledger and compliance"/>;
 const batches=useList('/payroll-batches',entityId,tick);
 const remittances=useList('/remittances',entityId,tick);
 const evidence=useList('/evidence',entityId,tick,{status:'available'});
 const cmd=useCommand(refresh);
 const [open,setOpen]=useState<string|null>(null),[records,setRecords]=useState<Row[]|null>(null),[recordsError,setRecordsError]=useState<ApiError|null>(null);
 useEffect(()=>{let live=true;setRecords(null);setRecordsError(null);if(!open)return;api('GET','/payroll-batches/'+open+'/records',{entityId}).then(r=>{if(live)setRecords(r.data.items);}).catch(e=>{if(live)setRecordsError(asError(e));});return()=>{live=false;};},[open,entityId,tick]);
 return <>
  <ErrorPanel error={cmd.error||batches.error||remittances.error||recordsError} onRetry={cmd.retry} onReload={cmd.reload} canRetry={cmd.canRetry}/>
  <p>Authoritative source: the retained payroll system's validated file. LARA imports the journal and the 2316/1601-C and agency data, checks that the records tie to the totals and posts per the approved payroll profile; it does not calculate payroll. Individual records are restricted and identifiers masked.</p>
  {can('payroll_batch.create')&&<section className="demo-card"><h2>Import a payroll batch</h2>
   <Editor id={'pb-new'+entityId} label="Import batch" resetOnSave onSave={async d=>{const records=String(d.records).split(/\n+/).map(l=>l.trim()).filter(Boolean).map(l=>{const [employeeReference,gross,withholding,sss,philhealth,pagibig,net]=l.split(',').map(x=>x.trim());return {employeeReference,gross,withholding,sss,philhealth,pagibig,net};});return !!await cmd.run('POST','/payroll-batches',{entityId,body:{sourceSystem:d.sourceSystem,periodKey:d.periodKey,mappingVersion:d.mappingVersion,grossTotal:d.grossTotal,withholdingTotal:d.withholdingTotal,sssTotal:d.sssTotal,philhealthTotal:d.philhealthTotal,pagibigTotal:d.pagibigTotal,netTotal:d.netTotal,records,evidenceIds:[d.evidenceId]}});}}>
    {input('Source system','sourceSystem','','text',{required:true})}{input('Period','periodKey',today().slice(0,7),'text',{required:true,pattern:'[0-9]{4}-[0-9]{2}'})}{input('Mapping version','mappingVersion','payroll-2026','text',{required:true})}
    {input('Gross total','grossTotal','','text',MONEY)}{input('Withholding total','withholdingTotal','','text',MONEY)}{input('SSS total','sssTotal','0.00','text',MONEY)}{input('PhilHealth total','philhealthTotal','0.00','text',MONEY)}{input('Pag-IBIG total','pagibigTotal','0.00','text',MONEY)}{input('Net total','netTotal','','text',MONEY)}
    <label>Records (one per line: reference, gross, withholding, sss, philhealth, pagibig, net)<textarea name="records" required rows={4}/></label>
    {evidenceSelect(evidence.items,'evidenceId','Payroll register')}
   </Editor></section>}
  <h2>Batches</h2>
  {batches.items===null?<Loading/>:table(['Source','Period','Employees','Gross','Withholding','Net','State','Actions'],batches.items.map((b:Row)=>[b.sourceSystem,b.periodKey,String(b.employeeCount),amount(b.grossTotal),amount(b.withholdingTotal),amount(b.netTotal),b.state+(b.exceptionReason?' · '+b.exceptionReason:''),<div key="a" className="action-row">
   {can('payroll_record.read')&&<button type="button" onClick={()=>setOpen(open===b.id?null:b.id)}>{open===b.id?'Hide records':'Records'}</button>}
   {b.state==='reconciled'&&can('payroll_batch.approve')&&<button disabled={cmd.busy} onClick={()=>void cmd.run('POST','/payroll-batches/'+b.id+'/approve',{entityId,ifMatch:b.version,body:{decision:'approve',contentVersion:b.contentVersion}})}>Approve</button>}
   {b.state==='approved'&&can('payroll_batch.post')&&<button disabled={cmd.busy} onClick={()=>void cmd.run('POST','/payroll-batches/'+b.id+'/post',{entityId,ifMatch:b.version,body:{}})}>Post journal</button>}
  </div>]),'No payroll batch yet.')}
  {open&&(records===null?(recordsError?null:<Loading/>):table(['#','Employee','Gross','Withholding','SSS','PhilHealth','Pag-IBIG','Net'],records.map((r:Row)=>[String(r.lineNo),r.employeeReferenceMasked,amount(r.gross),amount(r.withholding),amount(r.sss),amount(r.philhealth),amount(r.pagibig),amount(r.net)]),'No record.'))}
  {can('remittance.create')&&<section className="demo-card"><h2>Remittance due</h2>
   <Editor id={'rm-new'+entityId} label="Record remittance due" resetOnSave onSave={async d=>!!await cmd.run('POST','/remittances',{entityId,body:{...(d.batchId?{batchId:d.batchId}:{}),agency:d.agency,periodKey:d.periodKey,amount:d.amount,dueDate:d.dueDate}})}>
    <label>Batch<select name="batchId"><option value="">—</option>{(batches.items||[]).map((b:Row)=><option key={b.id} value={b.id}>{b.sourceSystem} {b.periodKey}</option>)}</select></label>{select('Agency','agency',[['BIR','BIR (1601-C)'],['SSS','SSS'],['PhilHealth','PhilHealth'],['Pag-IBIG','Pag-IBIG']],'SSS')}{input('Period','periodKey',today().slice(0,7),'text',{required:true,pattern:'[0-9]{4}-[0-9]{2}'})}{input('Amount','amount','','text',MONEY)}{input('Due date','dueDate','','date',{required:true})}
   </Editor></section>}
  <h2>Remittances</h2>
  {remittances.items===null?<Loading/>:table(['Agency','Period','Amount','Due','Reference','State','Actions'],remittances.items.map((r:Row)=>[r.agency,r.periodKey,amount(r.amount),r.dueDate,r.reference||'—',r.state,<div key="a" className="action-row">
   {r.state==='due'&&can('remittance.approve')&&<button disabled={cmd.busy} onClick={()=>void cmd.run('POST','/remittances/'+r.id+'/approve',{entityId,ifMatch:r.version,body:{decision:'approve',contentVersion:r.contentVersion}})}>Approve</button>}
   {r.state==='approved'&&can('remittance.approve')&&<Editor id={'remit'+r.id} label="Record remittance" onSave={async d=>!!await cmd.run('POST','/remittances/'+r.id+'/remit',{entityId,ifMatch:r.version,body:{reference:d.reference,evidenceIds:[d.evidenceId]}})}>{input('Remittance reference','reference','','text',{required:true})}{evidenceSelect(evidence.items,'evidenceId','Payment evidence')}</Editor>}
  </div>]),'No remittance recorded.')}
 </>;
}

// P17E local obligations.
export function LocalObligations({entityId,me,can,tick,refresh}:Ctx){
 if(!me.capabilities.includes('local_obligations'))return <NotEnabled me={me} feature="Local obligations" after="purchasing and compliance"/>;
 const list=useList('/local-obligations',entityId,tick);
 const evidence=useList('/evidence',entityId,tick,{status:'available'});
 const cmd=useCommand(refresh);
 return <>
  <ErrorPanel error={cmd.error||list.error} onRetry={cmd.retry} onReload={cmd.reload} canRetry={cmd.canRetry}/>
  <p>Authoritative source: the reviewed local authority profile (obligation kinds, due rules, filing requirements). Payment goes through the usual bills and payments; an obligation completes on payment evidence and, where the authority requires it, filing evidence. Nothing is filed automatically.</p>
  {can('local_obligation.create')&&<section className="demo-card"><h2>Record an obligation</h2>
   <Editor id={'lo-new'+entityId} label="Record obligation" resetOnSave onSave={async d=>!!await cmd.run('POST','/local-obligations',{entityId,body:{authority:d.authority,authorityProfileVersion:d.authorityProfileVersion,kind:d.kind,...(d.propertyRef?{propertyRef:d.propertyRef}:{}),periodKey:d.periodKey,dueDate:d.dueDate,amount:d.amount,requiresFiling:d.requiresFiling==='on',evidenceIds:d.evidenceId?[d.evidenceId]:[]}})}>
    {input('Authority','authority','','text',{required:true})}{input('Authority profile version','authorityProfileVersion','','text',{required:true})}{select('Kind','kind',[['business_permit','Business permit renewal'],['local_business_tax','Local business tax'],['real_property_tax','Real property tax'],['community_tax','Community tax'],['other','Other']],'business_permit')}{input('Property reference','propertyRef','','text')}{input('Period','periodKey',today().slice(0,4),'text',{required:true})}{input('Due date','dueDate','','date',{required:true})}{input('Amount','amount','','text',MONEY)}<label><input type="checkbox" name="requiresFiling"/> Filing evidence required</label>{evidenceSelect(evidence.items,'evidenceId','Assessment or notice',false)}
   </Editor></section>}
  <h2>Obligations</h2>
  {list.items===null?<Loading/>:table(['Authority','Kind','Period','Due','Amount','Filing','State','Actions'],list.items.map((o:Row)=>[o.authority,o.kind.replace(/_/g,' ')+(o.propertyRef?' · '+o.propertyRef:''),o.periodKey,o.dueDate,amount(o.amount),o.requiresFiling?'required':'—',o.state,<div key="a" className="action-row">
   {['open','paid'].includes(o.state)&&can('local_obligation.complete')&&<Editor id={'done'+o.id+o.version} label="Complete" onSave={async d=>!!await cmd.run('POST','/local-obligations/'+o.id+'/complete',{entityId,ifMatch:o.version,body:{paymentEvidenceIds:[d.paymentEvidenceId],filingEvidenceIds:d.filingEvidenceId?[d.filingEvidenceId]:[],...(d.reason?{reason:d.reason}:{})}})}>{evidenceSelect(evidence.items,'paymentEvidenceId','Payment evidence')}{evidenceSelect(evidence.items,'filingEvidenceId','Filing evidence',false)}{input('Note','reason','','text')}</Editor>}
   {['open','paid'].includes(o.state)&&can('local_obligation.complete')&&<Editor id={'waive'+o.id} label="Waive" onSave={async d=>!!await cmd.run('POST','/local-obligations/'+o.id+'/waive',{entityId,ifMatch:o.version,body:{reason:d.reason}})}>{input('Reason','reason','','text',{required:true})}</Editor>}
  </div>]),'No local obligation recorded.')}
 </>;
}
