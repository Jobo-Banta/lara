import {randomUUID, createHash} from 'node:crypto';

export const actors = ['Clerk','Billing','Reviewer','Treasury','Tax','Controller','Auditor'];
export const scenarios = ['Direct invoice','Uncertain bill','Repeated request','Rejected reporting','Cash match','Period close','Scoped audit','Interruption'].map((title,i)=>({id:`DEMO-0${i+1}`,title}));
export class DemoError extends Error { constructor(status, message) { super(message); this.status=status; } }
const fail=(status,message)=>{throw new DemoError(status,message);};
const requireValue=(value,message)=>{if(!value)fail(422,message);};
const text=(value,max=160)=>{requireValue(typeof value==='string' && value.trim().length>0 && value.length<=max,'A required text field is missing or too long.');return value.trim();};
export function cents(value) {
 requireValue(typeof value==='string' && /^\d{1,9}(\.\d{1,2})?$/.test(value),'Enter a positive amount with at most two decimal places.');
 const [whole,fraction='']=value.split('.');return Number(whole)*100+Number(fraction.padEnd(2,'0'));
}
export const money=value=>(value/100).toFixed(2);
const today='2026-09-18';
const date=value=>{requireValue(typeof value==='string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0,10)===value,'Enter a valid business date.');return value;};
const event=(s,source,action,details='')=>s.events.push({id:randomUUID(),source,action,actor:s.actor,at:new Date().toISOString(),details});
const allow=(s,roles)=>{if(!roles.includes(s.actor))fail(403,`Requires ${roles.join(' or ')} demo identity.`);};
const find=(rows,id)=>rows.find(row=>row.id===id) || fail(404,'Record not found in this demo session.');
const openPeriod=s=>{if(s.period.locked)fail(409,'This synthetic period is locked. Reset your scenario or use an open period; the retained report cannot be overwritten.');};
const line=(account,debit=0,credit=0)=>({account,debit:money(debit),credit:money(credit)});
function journal(s,source,kind,lines) {
 openPeriod(s);
 requireValue(lines.reduce((sum,l)=>sum+cents(l.debit)-cents(l.credit),0)===0,'Unbalanced simulation.');
 const entry={id:randomUUID(),number:`SIM-${String(s.journals.length+1).padStart(5,'0')}`,source,kind,lines,evidence:'evidence-source',date:today};s.journals.push(entry);return entry.number;
}
export function seedWorkspace() {
 return {schema:1,run:randomUUID(),version:0,synthetic:true,actor:'Billing',branch:'HQ',company:'LARA Demo Finance',scenario:'DEMO-01',asOf:'2026-09-18T02:00:00Z',
 settings:{company:'LARA Demo Finance',party:'Northwind Services',rolesReviewed:false},
 invoices:[],bills:[{id:'bill-fixture',supplier:'Harbor Cloud Hosting',tin:'',amount:'11200.00',confidence:'0.62',correction:'',route:'Non-PO',status:'Draft',creator:'Clerk',approvedBy:null,evidence:'evidence-source',duplicate:false}],
 payments:[],lines:[{id:'bank-receipt',description:'Fixture customer receipts',amount:'11200.00',allocations:[],status:'Unmatched'},{id:'bank-fee',description:'Fixture bank fee',amount:'50.00',allocations:[],status:'Unmatched'}],
 tasks:[{id:'review-bill',title:'Review uncertain supplier bill',owner:'Clerk',due:today,source:'/purchases/bills/bill-fixture',status:'Open',amount:'11200.00'},{id:'close-bank',title:'Attach bank evidence',owner:'Controller',due:today,source:'/close/2026-09',status:'Open',amount:'0.00'}],
 period:{id:'2026-09',locked:false,report:null,tasks:[{id:'bank',title:'Review bank reconciliation',owner:'Controller',complete:false,evidence:null},{id:'tax',title:'Review simulated reporting queue',owner:'Tax',complete:false,evidence:null}]},
 evidence:[{id:'evidence-source',title:'Synthetic supplier invoice',status:'Available',related:'/purchases/bills/bill-fixture',content:'SIMULATED — NOT A TAX DOCUMENT\nHarbor Cloud Hosting\nSubtotal PHP 10,000.00\nTest VAT PHP 1,200.00\nTotal PHP 11,200.00\nAll identities and amounts are fictional.'},{id:'evidence-bank',title:'Synthetic bank statement',status:'Available',related:'/bank/reconcile',content:'SIMULATED — SYNTHETIC CSV\ndate,description,amount\n2026-09-18,Customer receipts,11200.00\n2026-09-18,Bank fee,50.00'},{id:'evidence-quarantine',title:'Quarantined fixture',status:'Quarantined',related:'/evidence',content:''}],
 reporting:[],journals:[],events:[],comments:[],feedback:[],receipts:{}};
}
export function balances(s) {
 const accounts={};for(const j of s.journals)for(const l of j.lines)accounts[l.account]=(accounts[l.account]||0)+cents(l.debit)-cents(l.credit);
 return Object.entries(accounts).map(([account,balance])=>({account,debit:money(Math.max(0,balance)),credit:money(Math.max(0,-balance)),balance:money(balance)}));
}
export function view(s) { const {receipts,...result}=s;return {...result,actors,scenarios,balances:balances(s)}; }
function editInvoice(b) {
 const customer=text(b.customer),issueDate=date(b.issueDate),dueDate=date(b.dueDate);requireValue(dueDate>=issueDate,'Due date must not precede issue date.');
 requireValue(Array.isArray(b.lines)&&b.lines.length>0&&b.lines.length<=30,'Add between one and thirty invoice lines.');
 const lines=b.lines.map(l=>{const quantity=Number(l.quantity);requireValue(Number.isInteger(quantity)&&quantity>0&&quantity<=10000,'Quantity must be a whole number from 1 to 10,000.');return {description:text(l.description),quantity,unitPrice:money(cents(l.unitPrice))};});
 const subtotal=lines.reduce((sum,l)=>sum+cents(l.unitPrice)*l.quantity,0);requireValue(subtotal>0&&subtotal<=99999999900,'Invoice amount is outside the demo limit.');
 const tax=Math.floor((subtotal*12+50)/100);return {customer,issueDate,dueDate,lines,terms:text(b.terms||'30 days'),subtotal:money(subtotal),tax:money(tax),total:money(subtotal+tax)};
}
// Caller owns the SQL row lock. The entire aggregate and replay receipt commit together.
export function command(original,b) {
 requireValue(b && typeof b==='object','Command required.');
 const key=text(b.key,100);requireValue(/^[a-zA-Z0-9_-]+$/.test(key),'Invalid retry key.');
 if(b.run!==original.run)fail(409,'This demo run was reset. Reload before making another change.');
 const hash=createHash('sha256').update(JSON.stringify(b)).digest('hex');
 if(original.receipts[key]) {if(original.receipts[key].hash!==hash)fail(409,'Retry key already belongs to a different command.');return {state:original,result:original.receipts[key].result};}
 if(b.version!==original.version)fail(412,'Another action changed this workspace. Your draft is retained. Reload the latest version and merge explicitly.');
 const s=structuredClone(original),a=b.action;let source=b.id||'workspace',createdId;
 if(a==='switch-actor'){requireValue(actors.includes(b.actor),'Unknown demo identity.');s.actor=b.actor;}
 else if(a==='context'){requireValue(['HQ','Cebu'].includes(b.branch),'Unknown branch.');s.branch=b.branch;}
 else if(a==='reset') {requireValue(b.confirm==='RESET MY SYNTHETIC SESSION','Confirm the scope of this reset.');requireValue(scenarios.some(x=>x.id===b.scenario),'Select a scenario.');const fresh=seedWorkspace();fresh.scenario=b.scenario;fresh.version=s.version+1;return {state:fresh,result:{synthetic:true,run:fresh.run,version:fresh.version,message:'Only your demo session was reset.'}};}
 else if(a==='save-invoice') {
  allow(s,['Billing','Clerk']);const fields=editInvoice(b);
  if(b.id){const invoice=find(s.invoices,b.id);requireValue(['Draft','Submitted','Approved'].includes(invoice.status),'Posted sources are immutable. Create a linked correction.');Object.assign(invoice,fields,{status:'Draft',approvedBy:null});}
  else {createdId=randomUUID();source=createdId;s.invoices.push({id:createdId,...fields,status:'Draft',creator:s.actor,approvedBy:null,delivery:'Not sent',reporting:'Not submitted',settlement:'Unpaid'});}
 }
 else if(['submit-invoice','approve-invoice','post-invoice','collect-invoice','correct-invoice'].includes(a)) {
  const i=find(s.invoices,b.id);
  if(a==='submit-invoice'){allow(s,['Billing','Clerk']);requireValue(i.status==='Draft','Only a draft can be submitted.');i.status='Submitted';i.submittedBy=s.actor;}
  if(a==='approve-invoice'){allow(s,['Reviewer','Controller']);requireValue(i.status==='Submitted','Submit this draft first.');if([i.creator,i.submittedBy].includes(s.actor))fail(403,'Self-approval is prohibited.');i.status='Approved';i.approvedBy=s.actor;}
  if(a==='post-invoice'){allow(s,['Reviewer','Controller']);requireValue(i.status==='Approved','Approval required before simulated posting.');i.number=journal(s,i.id,'Invoice',[line('Accounts receivable',cents(i.total)),line('Revenue',0,cents(i.subtotal)),line('Test output VAT',0,cents(i.tax))]);i.status='Posted';i.reporting='Rejected';s.reporting.push({id:randomUUID(),source:i.id,status:'Rejected',reason:'Fixture: buyer reference missing',history:[]});}
  if(a==='collect-invoice'){allow(s,['Treasury']);requireValue(i.status==='Posted'&&i.settlement==='Unpaid','Only unpaid posted invoices can be collected.');journal(s,i.id,'Collection',[line('Bank',cents(i.total)),line('Accounts receivable',0,cents(i.total))]);i.settlement='Paid';}
  if(a==='correct-invoice'){allow(s,['Billing','Tax']);requireValue(i.status==='Posted','Corrections require a posted source.');createdId=randomUUID();s.invoices.push({...structuredClone(i),id:createdId,number:undefined,status:'Draft',creator:s.actor,approvedBy:null,correctionOf:i.id,delivery:'Not sent',reporting:'Not submitted',settlement:'Unpaid'});}
 }
 else if(['save-bill','submit-bill','approve-bill','post-bill'].includes(a)) {
  const bill=find(s.bills,b.id);
  if(a==='save-bill'){allow(s,['Clerk']);requireValue(bill.status!=='Posted','Posted source is immutable.');bill.tin=text(b.tin);bill.correction=text(b.correction);requireValue(['PO','Non-PO'].includes(b.route),'Select the purchasing route.');bill.route=b.route;bill.status='Draft';bill.approvedBy=null;}
  if(a==='submit-bill'){allow(s,['Clerk']);requireValue(bill.status==='Draft'&&bill.tin&&bill.correction&&!bill.duplicate,'Correct the uncertain field and missing synthetic TIN before submitting.');requireValue(find(s.evidence,bill.evidence).status==='Available','Available evidence is required.');bill.status='Submitted';bill.submittedBy=s.actor;}
  if(a==='approve-bill'){allow(s,['Reviewer','Controller']);requireValue(bill.status==='Submitted','Submit this bill first.');if([bill.creator,bill.submittedBy].includes(s.actor))fail(403,'Self-approval is prohibited.');bill.status='Approved';bill.approvedBy=s.actor;}
  if(a==='post-bill'){allow(s,['Reviewer','Controller']);requireValue(bill.status==='Approved','Approval required.');bill.number=journal(s,bill.id,'Supplier bill',[line('Expense',1000000),line('Test input VAT',120000),line('Accounts payable',0,1100000),line('Test withholding payable',0,20000)]);bill.status='Posted';s.payments.push({id:randomUUID(),bill:bill.id,beneficiary:bill.supplier,amount:'11000.00',authority:'Draft',release:'Not released',settlement:'Unpaid',changedBy:'Clerk',approvedBy:null});}
 }
 else if(['save-payment','approve-payment','release-payment'].includes(a)) {
  const p=find(s.payments,b.id);requireValue(p.release==='Not released','Released payment is immutable.');
  if(a==='save-payment'){allow(s,['Treasury']);p.beneficiary=text(b.beneficiary);p.authority='Draft';p.approvedBy=null;p.changedBy=s.actor;}
  if(a==='approve-payment'){allow(s,['Reviewer','Controller']);if(p.changedBy===s.actor)fail(403,'Self-approval is prohibited.');p.authority='Approved';p.approvedBy=s.actor;}
  if(a==='release-payment'){allow(s,['Treasury']);requireValue(p.authority==='Approved','Payment authority must be approved.');journal(s,p.id,'Simulated payment',[line('Accounts payable',cents(p.amount)),line('Bank',0,cents(p.amount))]);p.release='Simulated';p.settlement='Paid';}
 }
 else if(a==='match-bank') {
  allow(s,['Treasury']);const l=find(s.lines,b.id),amount=cents(b.amount);requireValue(amount>0,'Allocation must be positive.');const used=l.allocations.reduce((n,x)=>n+cents(x.amount),0);requireValue(used+amount<=cents(l.amount),'Allocation exceeds the remaining statement amount.');
  if(l.id==='bank-fee'){requireValue(b.adjustment===true,'A bank fee requires an explicit adjustment.');journal(s,l.id,'Explicit bank fee',[line('Bank fees',amount),line('Bank',0,amount)]);}
  else {const i=find(s.invoices,b.source);requireValue(i.settlement==='Paid','Select a collected invoice.');const allocated=s.lines.flatMap(x=>x.allocations).filter(x=>x.source===i.id).reduce((n,x)=>n+cents(x.amount),0);requireValue(allocated+amount<=cents(i.total),'Receipt is already allocated.');}
  l.allocations.push({id:randomUUID(),source:b.source||'explicit-fee',amount:money(amount),adjustment:!!b.adjustment});l.status=used+amount===cents(l.amount)?'Matched':'Partial';
 }
 else if(a==='resolve-reporting') {allow(s,['Tax']);const r=find(s.reporting,b.id);requireValue(r.status!=='Accepted','Already resolved.');r.history.push({status:r.status,reason:r.reason,repair:text(b.repair)});r.status='Accepted';r.reason='Simulated transport repair accepted; original source retained.';}
 else if(a==='complete-close') {allow(s,['Controller','Tax']);openPeriod(s);const t=find(s.period.tasks,b.id);requireValue(t.owner===s.actor,'Switch to the task owner.');requireValue(find(s.evidence,b.evidence).status==='Available','Available evidence is required.');if(t.id==='bank')requireValue(s.lines.every(x=>x.status==='Matched'),'Resolve all statement differences first.');if(t.id==='tax')requireValue(s.reporting.every(x=>x.status==='Accepted'),'Resolve rejected reporting first.');t.complete=true;t.evidence=b.evidence;}
 else if(a==='lock-period'){allow(s,['Reviewer','Controller']);openPeriod(s);requireValue(s.period.tasks.every(x=>x.complete&&x.evidence),'Complete required tasks and attach evidence first.');s.period.report=balances(s);s.period.locked=true;}
 else if(a==='assign-task'){allow(s,['Controller']);requireValue(actors.includes(b.owner),'Unknown owner.');find(s.tasks,b.id).owner=b.owner;}
 else if(a==='save-settings'){allow(s,['Controller']);s.settings={company:text(b.company),party:text(b.party),rolesReviewed:b.rolesReviewed===true};}
 else if(a==='comment'){requireValue([...s.invoices,...s.bills,...s.payments].some(x=>x.id===b.id),'Source not found.');s.comments.push({id:randomUUID(),source:b.id,actor:s.actor,text:text(b.text,2000)});}
 else if(a==='feedback'){requireValue(scenarios.some(x=>x.id===b.scenario),'Select a scenario.');requireValue(['minor','major','blocking'].includes(b.severity),'Choose a severity.');s.feedback.push({id:randomUUID(),scenario:b.scenario,route:text(b.route),severity:b.severity,text:text(b.text,2000),actor:s.actor});}
 else fail(404,'Unknown demo action.');
 event(s,source,a);s.version++;
 const result={synthetic:true,run:s.run,version:s.version,message:'Saved to your synthetic demo session.',...(createdId?{id:createdId}:{})};s.receipts[key]={hash,result};return {state:s,result};
}
