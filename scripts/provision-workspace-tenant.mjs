// Operator command: provision a tenant with its first principals and role
// templates so people can sign in and complete setup themselves. Nothing here
// creates entities, parties or rules. Runs as the API runtime role.
//
//   node scripts/provision-workspace-tenant.mjs --slug acme --name "Acme Finance" --mode demo \
//     --controller <oidc-subject> --security <oidc-subject> [--preparer <oidc-subject>] [--clerk <oidc-subject>] [--billing <oidc-subject>] [--auditor <oidc-subject>] [--issuer <url>]
import {createRequire} from 'node:module';
import {randomUUID,createHash} from 'node:crypto';
import {parseArgs} from 'node:util';
import {loadLocalEnv} from './local-env.mjs';
import {connectionOptions} from '../packages/database/src/connection.mjs';
import {inTransaction,identity,organization,contentHash,audit} from '../packages/domain/src/index.mjs';
loadLocalEnv();
const {values}=parseArgs({options:{slug:{type:'string'},name:{type:'string'},mode:{type:'string',default:'demo'},controller:{type:'string'},security:{type:'string'},preparer:{type:'string'},clerk:{type:'string'},billing:{type:'string'},auditor:{type:'string'},issuer:{type:'string'},json:{type:'boolean',default:false}}});
if(!values.slug||!values.name||!values.controller||!values.security)throw Error('Required: --slug --name --controller <subject> --security <subject>');
if(values.controller===values.security)throw Error('The controller and the security administrator must be different people');
const issuer=values.issuer||process.env.OIDC_ISSUER;
const pg=createRequire(new URL('../packages/database/package.json',import.meta.url))('pg');
const db=new pg.Client({...connectionOptions(process.env.DATABASE_URL),connectionTimeoutMillis:15000,query_timeout:30000});
await db.connect();
try{
 const tenantId=randomUUID();
 const result=await inTransaction(db,{tenantId,principalId:null,traceId:'provision-'+tenantId},async tx=>{
  const tenant=await organization.provisionTenant(tx,{id:tenantId,slug:values.slug,name:values.name,mode:values.mode});
  const people={};
  for(const role of ['controller','security','preparer','clerk','billing','auditor'])if(values[role])people[role]=await identity.resolvePrincipal(tx,tenantId,{issuer,subject:values[role],displayName:role});
  const templates=(await tx.query('select code,name,permissions from lara.role_templates order by code')).rows;
  const roles={};
  for(const t of templates){
   // Templates are approved at provisioning by the operator record; later
   // changes go through role.edit and an independent role.approve.
   roles[t.code]=(await tx.query("insert into lara.roles(tenant_id,code,name,permissions,protected,status,content_hash,created_by) values($1,$2,$3,$4,true,'approved',$5,$6) returning id",[tenantId,t.code,t.name,JSON.stringify(t.permissions),contentHash({code:t.code,name:t.name,permissions:t.permissions}),people.security.id])).rows[0].id;
  }
  const assign={controller:'controller',security:'security_admin',preparer:'accountant',clerk:'clerk',billing:'billing',auditor:'auditor'};
  const memberships=[];
  for(const [person,role] of Object.entries(assign))if(people[person])memberships.push((await tx.query('insert into lara.memberships(tenant_id,principal_id,role_id,created_by) values($1,$2,$3,$4) returning id',[tenantId,people[person].id,roles[role],people.security.id])).rows[0].id);
  await audit(tx,{tenantId,principalId:null,traceId:'provision-'+tenantId},{action:'tenant.provision',resourceType:'tenant',resourceId:tenantId,resourceVersion:1,reason:'Operator provisioning: '+Object.keys(people).join(', ')});
  return {tenant,principals:Object.fromEntries(Object.entries(people).map(([k,v])=>[k,v.id])),roles,memberships:memberships.length};
 });
 console.log(values.json?JSON.stringify(result):'Provisioned tenant '+result.tenant.slug+' ('+result.tenant.id+') with '+result.memberships+' memberships. Principals: '+JSON.stringify(result.principals));
}finally{await db.end();}
