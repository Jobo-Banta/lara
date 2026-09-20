"use client";
// P06 treasury screens: bank accounts under review, bank statement import
// preview and the side-by-side reconciliation workbench (statement lines
// against posted settlements and journal entries, proposals confirmed by a
// reviewer, difference breakdown), transfers, the check register and release
// calendar, cashier sessions with denomination counts, variance and the
// independent handover, and the payment file runs shown as generated versus
// settled. No screen moves money.
import {useEffect,useMemo,useState} from 'react';
import {api,asError,useCommand,ErrorPanel,Editor,table,link,useList,Loading,input,select,when,uuid,type Row,type ApiError} from './workspace-kit';
import {useBookId} from './workspace-ledger';

const money=(v:string|number|null|undefined)=>v==null?'—':new Intl.NumberFormat('en-PH',{style:'currency',currency:'PHP'}).format(Number(v));
const today=()=>new Date().toISOString().slice(0,10);
type Ctx={entityId:string,me:Row,can:(p:string)=>boolean,tick:number,refresh:()=>void};
function NotEnabled({me}:{me:Row}){return <section className="demo-card"><h2>Treasury not enabled</h2><p>The treasury capability is activated per entity after purchasing, with an approved treasury profile (petty cash and variance accounts, bank file format). {me.permissions.includes('capability.activate')?<a href="/settings/capabilities">Open capabilities</a>:'Ask a controller to activate it.'}</p></section>;}
const bankLabel=(b:Row)=>b.bankCode+' '+b.accountNumberMasked;

// ---------------------------------------------------------------------------
// Bank accounts
// ---------------------------------------------------------------------------
export function TreasuryBankAccounts({entityId,me,can,tick,refresh}:Ctx){
 if(!me.capabilities.includes('treasury'))return <NotEnabled me={me}/>;
 const list=useList('/bank-accounts',entityId,tick);
 const accounts=useList('/accounts',entityId,tick);
 const evidence=useList('/evidence',entityId,tick,{status:'available'});
 const {bookId}=useBookId(entityId,tick,me);
 const cmd=useCommand(refresh);
 const ledger=(accounts.items||[]).filter((a:Row)=>a.state==='active'&&a.category==='asset'&&a.controlType==='none');
 return <>{can('bank_account.create')&&bookId&&<><h2>New bank account</h2><p>The account number is encrypted and shown masked; a different principal approves the account against the bank's confirmation before statements, checks, transfers or payment files use it.</p>
  <Editor id={'bank-new'+entityId} label="Save draft" resetOnSave onSave={async d=>!!await cmd.run('POST','/bank-accounts',{entityId,body:{bookId,ledgerAccountId:d.ledgerAccountId,bankCode:d.bankCode,accountNumber:d.accountNumber,currency:'PHP',evidenceIds:[d.evidenceId]}})}>
   {input('Bank code','bankCode','BDO','text',{required:true,pattern:'[A-Za-z0-9]{3,20}'})}{input('Account number','accountNumber','','text',{required:true,autoComplete:'off'})}<label>Ledger account<select name="ledgerAccountId" required><option value="">Select bank ledger account</option>{ledger.map((a:Row)=><option key={a.id} value={a.id}>{a.code} {a.name}</option>)}</select></label><label>Bank confirmation<select name="evidenceId" required><option value="">Select evidence</option>{(evidence.items||[]).map((e:Row)=><option key={e.id} value={e.id}>{e.filename}</option>)}</select></label>
  </Editor></>}
  <h2>Bank accounts</h2>
  <ErrorPanel error={cmd.error||list.error} onRetry={cmd.retry} onReload={cmd.reload} canRetry={cmd.canRetry}/>
  {list.items===null?<Loading/>:table(['Bank','Account','Ledger account','State','Actions'],list.items.map(b=>[b.bankCode,b.accountNumberMasked,(accounts.items||[]).find((a:Row)=>a.id===b.ledgerAccountId)?.code||'—',b.state,<div key="a" className="action-row">{b.state==='draft'&&can('bank_account.approve')&&<button disabled={cmd.busy} onClick={()=>void cmd.run('POST','/bank-accounts/'+b.id+'/approve',{entityId,ifMatch:b.version,body:{decision:'approve',contentVersion:b.contentVersion}})}>Approve</button>}</div>]),'No bank accounts yet.')}</>;
}

// ---------------------------------------------------------------------------
// Bank reconciliation workbench
// ---------------------------------------------------------------------------
export function TreasuryReconcile({entityId,me,can,tick,refresh}:Ctx){
 if(!me.capabilities.includes('treasury'))return <NotEnabled me={me}/>;
 const banks=useList('/bank-accounts',entityId,tick,{status:'approved'});
 const [bankId,setBankId]=useState('');
 useEffect(()=>{if(!bankId&&banks.items?.length)setBankId(banks.items[0].id);},[banks.items]);
 const lines=useList('/bank-statement-lines',bankId?entityId:null,tick,{bankAccountId:bankId});
 const matches=useList('/bank-matches',bankId?entityId:null,tick,{bankAccountId:bankId});
 const settlements=useList('/collections',entityId,tick,{});
 const payments=useList('/settlements',entityId,tick,{});
 const evidence=useList('/evidence',entityId,tick,{status:'available'});
 const cmd=useCommand(refresh);
 const [recon,setRecon]=useState<Row|null>(null),[asOf,setAsOf]=useState(today());
 useEffect(()=>{if(!bankId)return;api('GET','/bank-reconciliation?bankAccountId='+bankId+'&asOf='+asOf,{entityId}).then(r=>setRecon(r.data)).catch(()=>setRecon(null));},[bankId,asOf,tick]);
 const [selectedLines,setSelectedLines]=useState<string[]>([]),[allocs,setAllocs]=useState<Row[]>([]),[journalId,setJournalId]=useState(''),[journalAmount,setJournalAmount]=useState('');
 const open=[...(settlements.items||[]),...(payments.items||[])].filter((s:Row)=>s.state==='posted');
 const lineTotal=selectedLines.reduce((t,id)=>{const l=(lines.items||[]).find((x:Row)=>x.id===id);return t+(l?Math.abs(Number(l.signedAmount))-Number(l.matchedAmount):0);},0);
 const allocTotal=allocs.reduce((t,a)=>t+Number(a.amount||0),0);
 const act=(m:Row,label:string,path:string,body:Row,permission:string)=>can(permission)?<button key={path} disabled={cmd.busy} onClick={()=>void cmd.run('POST','/bank-matches/'+m.id+'/'+path,{entityId,ifMatch:m.version,body})}>{label}</button>:null;
 return <>
  <div className="filter-row"><label>Bank account<select value={bankId} onChange={e=>{setBankId(e.target.value);setSelectedLines([]);setAllocs([]);}}>{(banks.items||[]).map((b:Row)=><option key={b.id} value={b.id}>{bankLabel(b)}</option>)}</select></label><label>As of<input type="date" value={asOf} onChange={e=>setAsOf(e.target.value)}/></label></div>
  {!bankId&&<p>No approved bank account yet; approve one under bank accounts, then import its statement as an import of kind <code>bank_statement</code> (CSV: source_line_key, booked_date, value_date, signed_amount, currency, reference, description, with opening_balance and closing_balance rows).</p>}
  <ErrorPanel error={cmd.error||lines.error} onRetry={cmd.retry} onReload={cmd.reload} canRetry={cmd.canRetry}/>
  {recon&&<section className="demo-card"><h2>Difference breakdown as of {recon.asOf}</h2><p>Statement balance {recon.statementBalance==null?'no statement yet':money(recon.statementBalance)} · ledger balance {money(recon.ledgerBalance)} · difference {recon.difference==null?'—':money(recon.difference)}</p><p>{recon.unmatchedLines.length} unmatched statement line(s) · {recon.unmatchedSettlements.length} posted settlement(s) not yet on a statement</p></section>}
  <div className="split-panel">
   <section><h2>Statement lines</h2>{lines.items===null?<Loading/>:table(['','Booked','Reference','Amount','Matched','State'],lines.items.map(l=>[<input key="c" type="checkbox" aria-label={'Select line '+l.sourceLineKey} checked={selectedLines.includes(l.id)} disabled={l.matchState==='matched'} onChange={e=>setSelectedLines(s=>e.target.checked?[...s,l.id]:s.filter(x=>x!==l.id))}/>,l.bookedDate,l.reference||l.description||l.sourceLineKey,money(l.signedAmount),money(l.matchedAmount),l.matchState.replace('_',' ')]),bankId?'No statement lines; import a statement.':'')}</section>
   <section><h2>Counterparts</h2><p>Posted receipts and payments; a fee or difference needs its own approved journal, which is matched by its entry id.</p>
    {table(['Settlement','Direction','Value date','Cash','Allocate'],open.map((s:Row)=>[s.id.slice(0,8),s.direction,s.valueDate,money(s.cashAmount),<div key="a" className="action-row"><input aria-label={'Allocate settlement '+s.id.slice(0,8)} inputMode="decimal" value={allocs.find(a=>a.resourceId===s.id)?.amount||''} onChange={e=>setAllocs(as=>[...as.filter(a=>a.resourceId!==s.id),...(e.target.value?[{resourceType:'settlement',resourceId:s.id,amount:e.target.value}]:[])])} placeholder="0.00"/><button type="button" onClick={()=>setAllocs(as=>[...as.filter(a=>a.resourceId!==s.id),{resourceType:'settlement',resourceId:s.id,amount:s.cashAmount}])}>Full</button></div>]),'No posted settlements.')}
    <div className="filter-row"><label>Journal entry id<input value={journalId} onChange={e=>setJournalId(e.target.value)} placeholder="posted entry id"/></label><label>Amount<input inputMode="decimal" value={journalAmount} onChange={e=>setJournalAmount(e.target.value)} placeholder="0.00"/></label><button type="button" disabled={!journalId||!journalAmount} onClick={()=>{setAllocs(as=>[...as.filter(a=>a.resourceId!==journalId),{resourceType:'journal',resourceId:journalId,amount:journalAmount}]);setJournalId('');setJournalAmount('');}}>Add journal</button></div>
   </section>
  </div>
  {can('bank_match.create')&&<section className="demo-card"><h2>Propose a match</h2><p role="status" aria-live="polite">Selected lines {money(lineTotal)} · allocations {money(allocTotal)}{Math.abs(lineTotal-allocTotal)>1e-9?' · amounts must conserve':' · balanced'}</p>
   <Editor id={'match'+bankId} label="Save match for confirmation" disabled={!selectedLines.length||!allocs.length||Math.abs(lineTotal-allocTotal)>1e-9} onSave={async d=>{const r=await cmd.run('POST','/bank-matches',{entityId,body:{statementLineIds:selectedLines,allocations:allocs.map(a=>({resourceType:a.resourceType,resourceId:a.resourceId,amount:a.amount})),...(d.reason?{reason:d.reason}:{})}});if(r){setSelectedLines([]);setAllocs([]);}return !!r;}}>{input('Reason (optional)','reason','','text')}</Editor></section>}
  <h2>Matches</h2>
  {matches.items===null?<Loading/>:table(['Lines','Allocations','Reason','State','Actions'],matches.items.map(m=>[m.statementLineIds.length,m.allocations.map((a:Row)=>a.resourceType+' '+a.resourceId.slice(0,8)+' '+money(a.amount)).join('; '),m.reason||'—',m.state,<div key="a" className="action-row">{['draft','proposed'].includes(m.state)&&act(m,'Confirm','confirm',{decision:'approve',contentVersion:m.contentVersion},'bank_match.confirm')}{['draft','proposed'].includes(m.state)&&can('bank_match.confirm')&&<Editor id={'rejm'+m.id} label="Reject" onSave={async d=>!!await cmd.run('POST','/bank-matches/'+m.id+'/confirm',{entityId,ifMatch:m.version,body:{decision:'reject',contentVersion:m.contentVersion,reason:d.reason}})}>{input('Reason','reason','','text',{required:true})}</Editor>}{m.state==='confirmed'&&can('bank_match.reverse')&&<Editor id={'revm'+m.id} label="Reverse" onSave={async d=>!!await cmd.run('POST','/bank-matches/'+m.id+'/reverse',{entityId,ifMatch:m.version,body:{reason:d.reason}})}>{input('Reason','reason','','text',{required:true})}</Editor>}</div>]),'No matches yet; the worker proposes exact matches after each statement commit.')}
  {evidence.items&&<p>{evidence.items.length} available evidence file(s); statement CSVs are imported under Imports with kind bank statement and this account's id as the source.</p>}
 </>;
}

// ---------------------------------------------------------------------------
// Transfers
// ---------------------------------------------------------------------------
export function TreasuryTransfers({entityId,me,can,tick,refresh}:Ctx){
 if(!me.capabilities.includes('treasury'))return <NotEnabled me={me}/>;
 const list=useList('/transfers',entityId,tick);
 const banks=useList('/bank-accounts',entityId,tick,{status:'approved'});
 const cmd=useCommand(refresh);
 const name=(id:string)=>{const b=(banks.items||[]).find((x:Row)=>x.id===id);return b?bankLabel(b):id.slice(0,8);};
 const act=(t:Row,label:string,path:string,body:Row,permission:string)=>can(permission)?<button key={path} disabled={cmd.busy} onClick={()=>void cmd.run('POST','/transfers/'+t.id+'/'+path,{entityId,ifMatch:t.version,body})}>{label}</button>:null;
 return <>{can('transfer.create')&&<><h2>New transfer</h2><p>Both sides post in one entry when an approver other than the preparer approves and the transfer posts.</p><Editor id={'transfer-new'+entityId} label="Save draft" resetOnSave onSave={async d=>!!await cmd.run('POST','/transfers',{entityId,body:{fromAccountId:d.fromAccountId,toAccountId:d.toAccountId,currency:'PHP',amount:d.amount,valueDate:d.valueDate,evidenceIds:[]}})}>
   <label>From<select name="fromAccountId" required><option value="">Select account</option>{(banks.items||[]).map((b:Row)=><option key={b.id} value={b.id}>{bankLabel(b)}</option>)}</select></label><label>To<select name="toAccountId" required><option value="">Select account</option>{(banks.items||[]).map((b:Row)=><option key={b.id} value={b.id}>{bankLabel(b)}</option>)}</select></label>{input('Amount','amount','','text',{required:true,inputMode:'decimal',placeholder:'0.00'})}{input('Value date','valueDate',today(),'date',{required:true})}
  </Editor></>}
  <h2>Transfers</h2>
  <ErrorPanel error={cmd.error||list.error} onRetry={cmd.retry} onReload={cmd.reload} canRetry={cmd.canRetry}/>
  {list.items===null?<Loading/>:table(['From','To','Amount','Value date','State','Actions'],list.items.map(t=>[name(t.fromAccountId),name(t.toAccountId),money(t.amount),t.valueDate,t.state,<div key="a" className="action-row">{t.state==='draft'&&act(t,'Submit','submit',{},'transfer.submit')}{t.state==='submitted'&&act(t,'Approve','approve',{decision:'approve',contentVersion:t.contentVersion},'transfer.approve')}{t.state==='approved'&&act(t,'Post transfer','post',{},'transfer.post')}</div>]),'No transfers yet.')}</>;
}

// ---------------------------------------------------------------------------
// Check register and release calendar
// ---------------------------------------------------------------------------
export function TreasuryChecks({entityId,me,can,tick,refresh}:Ctx){
 if(!me.capabilities.includes('treasury'))return <NotEnabled me={me}/>;
 const list=useList('/checks',entityId,tick);
 const banks=useList('/bank-accounts',entityId,tick,{status:'approved'});
 const parties=useList('/parties',entityId,tick,{status:'active'});
 const cmd=useCommand(refresh);
 const act=(c:Row,label:string,path:string,permission:string)=>can(permission)?<Editor key={path} id={path+c.id+c.version} label={label} onSave={async d=>!!await cmd.run('POST','/checks/'+c.id+'/'+path,{entityId,ifMatch:c.version,body:path==='dishonor'?{accountingDate:d.accountingDate,reason:d.reason}:{reason:d.reason}})}>{path==='dishonor'&&input('Date','accountingDate',today(),'date',{required:true})}{input('Reason','reason','','text',{required:true})}</Editor>:null;
 const upcoming=(list.items||[]).filter(c=>['custody','drafted','released','deposited'].includes(c.state)).sort((a,b)=>a.dueDate.localeCompare(b.dueDate));
 return <>{can('check.create')&&<><h2>Register a check</h2><p>A received check is custody only: the receipt it settles posts when the check clears. Issued checks are released to the payee and clear at the bank.</p><Editor id={'check-new'+entityId} label="Register" resetOnSave onSave={async d=>!!await cmd.run('POST','/checks',{entityId,body:{direction:d.direction,bankAccountId:d.bankAccountId,number:d.number,amount:d.amount,currency:'PHP',dueDate:d.dueDate,partyId:d.partyId,...(d.settlementId?{settlementId:d.settlementId}:{})}})}>
   {select('Direction','direction',[['received','Received (post-dated)'],['issued','Issued']],'received')}<label>Bank account<select name="bankAccountId" required><option value="">Select account</option>{(banks.items||[]).map((b:Row)=><option key={b.id} value={b.id}>{bankLabel(b)}</option>)}</select></label>{input('Check number','number','','text',{required:true})}{input('Amount','amount','','text',{required:true,inputMode:'decimal'})}{input('Due date','dueDate',today(),'date',{required:true})}<label>Party<select name="partyId" required><option value="">Select party</option>{(parties.items||[]).map((p:Row)=><option key={p.id} value={p.id}>{p.legalName}</option>)}</select></label>{input('Linked settlement id (optional)','settlementId','','text',{pattern:'[0-9a-fA-F-]{36}'})}
  </Editor></>}
  <h2>Release calendar</h2>
  {table(['Due','Direction','Number','Party','Amount','State'],upcoming.map(c=>[c.dueDate,c.direction,c.number,(parties.items||[]).find((p:Row)=>p.id===c.partyId)?.legalName||'—',money(c.amount),c.state]),'Nothing due.')}
  <h2>Check register</h2>
  <ErrorPanel error={cmd.error||list.error} onRetry={cmd.retry} onReload={cmd.reload} canRetry={cmd.canRetry}/>
  {list.items===null?<Loading/>:table(['Number','Direction','Party','Amount','Due','State','Actions'],list.items.map(c=>[c.number,c.direction,(parties.items||[]).find((p:Row)=>p.id===c.partyId)?.legalName||'—',money(c.amount),c.dueDate,c.state,<div key="a" className="action-row">{c.state==='drafted'&&act(c,'Release to payee','release','check.release')}{c.state==='custody'&&act(c,'Deposit','deposit','check.deposit')}{['deposited','released'].includes(c.state)&&act(c,'Clear','clear','check.clear')}{['deposited','released','cleared'].includes(c.state)&&act(c,'Dishonor','dishonor','check.dishonor')}</div>]),'No checks registered.')}</>;
}

// ---------------------------------------------------------------------------
// Cashier sessions
// ---------------------------------------------------------------------------
export function TreasuryCash({entityId,me,can,tick,refresh}:Ctx){
 if(!me.capabilities.includes('treasury'))return <NotEnabled me={me}/>;
 const list=useList('/cash-sessions',entityId,tick);
 const branches=useList('/branches',entityId,tick);
 const cmd=useCommand(refresh);
 const [counts,setCounts]=useState<Record<string,Record<string,string>>>({});
 const denominations=['1000','500','200','100','50','20','10','5','1'];
 const counted=(id:string)=>denominations.reduce((t,d)=>t+Number(d)*Number(counts[id]?.[d]||0),0);
 return <>{can('cash_session.create')&&<><h2>Open a cash session</h2><Editor id={'cash-new'+entityId} label="Open session" resetOnSave onSave={async d=>!!await cmd.run('POST','/cash-sessions',{entityId,body:{branchId:d.branchId,cashierId:me.principalId,businessDate:d.businessDate,openingAmount:d.openingAmount}})}>
   <label>Branch<select name="branchId" required>{(branches.items||[]).map((b:Row)=><option key={b.id} value={b.id}>{b.code} {b.name}</option>)}</select></label>{input('Business date','businessDate',today(),'date',{required:true})}{input('Opening float','openingAmount','0.00','text',{required:true,inputMode:'decimal'})}
  </Editor></>}
  <h2>Sessions</h2><p>Count by denomination; a variance needs a reason and posts under the approved policy at close; a different cashier attests to the handover. Counted values are never overwritten.</p>
  <ErrorPanel error={cmd.error||list.error} onRetry={cmd.retry} onReload={cmd.reload} canRetry={cmd.canRetry}/>
  {list.items===null?<Loading/>:list.items.map(s=><section key={s.id} className="demo-card"><h3>{s.businessDate} · {(branches.items||[]).find((b:Row)=>b.id===s.branchId)?.code||'branch'} · opening {money(s.openingAmount)} · {s.state.replace('_',' ')}</h3>
   {['open','counted'].includes(s.state)&&can('cash_session.count')&&<Editor id={'count'+s.id+s.version} label="Record count" onSave={async d=>!!await cmd.run('POST','/cash-sessions/'+s.id+'/count',{entityId,ifMatch:s.version,body:{lines:denominations.filter(dn=>Number(counts[s.id]?.[dn]||0)>0).map(dn=>({denomination:dn+'.00',quantity:Number(counts[s.id][dn])})),...(d.reason?{reason:d.reason}:{}),evidenceIds:[]}})}>
    <div className="table-scroll" tabIndex={0} role="region" aria-label="Denominations"><table><thead><tr><th>Denomination</th><th>Quantity</th></tr></thead><tbody>{denominations.map(dn=><tr key={dn}><td>{money(dn)}</td><td><input aria-label={'Quantity of '+dn} inputMode="numeric" value={counts[s.id]?.[dn]||''} onChange={e=>setCounts(c=>({...c,[s.id]:{...(c[s.id]||{}),[dn]:e.target.value}}))}/></td></tr>)}</tbody></table></div>
    <p role="status" aria-live="polite">Counted {money(counted(s.id))}</p>{input('Variance reason (required when the count differs from the expected cash)','reason','','text')}
   </Editor>}
   <div className="action-row">{s.state==='counted'&&can('cash_session.close')&&<Editor id={'close'+s.id} label="Close session" onSave={async d=>!!await cmd.run('POST','/cash-sessions/'+s.id+'/close',{entityId,ifMatch:s.version,body:{reason:d.reason}})}>{input('Closing note','reason','End of day','text',{required:true})}</Editor>}{s.state==='closed'&&can('cash_session.handover')&&<button disabled={cmd.busy} onClick={()=>void cmd.run('POST','/cash-sessions/'+s.id+'/handover',{entityId,ifMatch:s.version,body:{decision:'approve',contentVersion:s.contentVersion}})}>Attest handover</button>}</div>
  </section>)}
  {list.items&&!list.items.length&&<p>No cash sessions.</p>}
 </>;
}
