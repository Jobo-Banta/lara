import {readFile} from 'node:fs/promises';
const file=process.argv[2];if(!file)throw Error('Provide an actual usability results JSON file.');
const data=JSON.parse(await readFile(file,'utf8'));
const participants=data.participants||[];
const errors=[];
if(participants.length<8)errors.push('At least eight actual participants required.');
if(new Set(participants.map(p=>p.code)).size!==participants.length)errors.push('Participant codes must be unique.');
if(participants.filter(p=>p.inexperienced===true).length<2)errors.push('At least two inexperienced participants required.');
let total=0,success=0;
for(const p of participants){
 if(!p.code||!p.role||!p.observedAt||!p.observer)errors.push('Participant identity code, role, observation time and observer required.');
 if(!Array.isArray(p.tasks)||p.tasks.length!==6||new Set(p.tasks.map(t=>t.card)).size!==6)errors.push('Each participant needs six distinct task observations.');
 for(const t of p.tasks||[]){total++;if(t.completed===true&&t.assisted===false)success++;if(!Number.isFinite(t.activeSeconds)||t.activeSeconds<=0||!Number.isInteger(t.rework)||!Number.isInteger(t.helpRequests)||typeof t.comment!=='string')errors.push('Incomplete task observation.');}
}
if((data.openBlockingDefects||[]).length)errors.push('Resolve role-blocking defects.');
const rate=total?success/total:0;if(rate<0.9)errors.push('Unassisted completion below 90%.');
console.log(JSON.stringify({pass:errors.length===0,participants:participants.length,attempts:total,unassisted:success,rate,errors},null,2));
if(errors.length)process.exitCode=1;
