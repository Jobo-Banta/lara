import {seedWorkspace,command,view,DemoError} from './demo-domain.mjs';

export async function demoRequest(db,identity,method,path,body) {
 if(!identity.sid || !/^[a-zA-Z0-9_-]{16,100}$/.test(identity.sid))throw new DemoError(401,'A session-bound demo identity is required.');
 await db.connect();
 try {
  await db.query('begin');
  await db.query("select set_config('lara.subject',$1,true),set_config('lara.session',$2,true)",[identity.sub,identity.sid]);
  if(!(await db.query('select id from lara_demo.runs')).rowCount)throw new DemoError(403,'Demo access has not been provisioned.');
  await db.query('insert into lara_demo.workspaces(owner_subject,session_id,state) values($1,$2,$3) on conflict do nothing',[identity.sub,identity.sid,seedWorkspace()]);
  const {rows:[row]}=await db.query('select state from lara_demo.workspaces where owner_subject=$1 and session_id=$2 for update',[identity.sub,identity.sid]);
  let result;
  if(method==='GET'&&path==='/demo/workspace')result=view(row.state);
  else if(method==='POST'&&path==='/demo/command') {
   const changed=command(row.state,body);
   await db.query('update lara_demo.workspaces set state=$3,updated_at=now() where owner_subject=$1 and session_id=$2',[identity.sub,identity.sid,changed.state]);result=changed.result;
  } else throw new DemoError(404,'Not found.');
  await db.query('commit');return result;
 }catch(error){await db.query('rollback');throw error;}finally{await db.end();}
}
