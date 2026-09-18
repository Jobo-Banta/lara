import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
const run=JSON.parse(readFileSync(process.argv[2],'utf8'));
const commit=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
if(run.headSha!==commit || run.conclusion!=='success' || run.workflowName!=='CI' || run.event!=='push')throw Error('Release requires successful CI for the exact source commit');
const state=JSON.parse(readFileSync('status/build-status.json','utf8'));
for(const [id,ticket]of Object.entries(state.tickets))if(id.startsWith('P00-') && id!=='P00-08' && ticket.status!=='done')throw Error('Unverified engineering gate: '+id);
if(!['in_review','done'].includes(state.tickets['P00-08'].status))throw Error('Release implementation must be reviewed');
console.log('PASS: exact source CI and engineering ticket gates');
