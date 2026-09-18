import {execFileSync,spawnSync} from 'node:child_process';
import {loadLocalEnv} from './local-env.mjs';
const env=loadLocalEnv({});
const secrets=Object.entries(env).filter(([key,value])=>/SECRET|PASSWORD|DATABASE_URL/.test(key)&&value.length>16).map(([,value])=>value);
if(!secrets.length)throw Error('No operator secret reference available for pre-publication scan');
const commits=execFileSync('git',['rev-list','--all'],{encoding:'utf8'}).trim().split(/\s+/);
for(const revision of [...commits,'--cached']){
 const r=spawnSync('git',['grep','-I','-l','-F','-f','-',...(revision==='--cached'?['--cached']:[revision]),'--','.'],{input:secrets.join('\n'),encoding:'utf8',maxBuffer:1024*1024});
 if(r.status===0){console.error('Known local credential found in tracked history. Publication blocked.');process.exit(1);}
 if(r.status!==1)throw Error('Secret scan could not finish');
}
console.log('PASS: no configured secret values in staged files or '+commits.length+' commits. CI also runs gitleaks.');
