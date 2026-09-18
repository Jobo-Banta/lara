import { createHash } from 'node:crypto';
export async function applyMigrations(db, files, { metadataSchema = 'public', transaction = true } = {}) {
  if (!/^[a-z_][a-z0-9_]*$/.test(metadataSchema)) throw new Error('Invalid metadata schema');
  const table = metadataSchema + '.schema_migrations';
  const applied=[];
  if(transaction) await db.query('begin');
  try {
    await db.query("select pg_advisory_xact_lock(hashtext($1))",['lara:migrations:'+metadataSchema]);
    await db.query('create table if not exists '+table+'(version text primary key,sha256 char(64) not null,applied_at timestamptz not null default now(),release text not null)');
    for(const {version,sql} of files) {
      const hash=createHash('sha256').update(sql).digest('hex');
      const old=await db.query('select sha256 from '+table+' where version=$1',[version]);
      if(old.rowCount && old.rows[0].sha256!==hash) throw new Error('Migration checksum mismatch: '+version);
      if(old.rowCount) continue;
      await db.query(sql);
      await db.query('insert into '+table+'(version,sha256,release) values($1,$2,$3)',[version,hash,'0.0.1']);
      applied.push(version);
    }
    if(transaction) await db.query('commit');
    return applied;
  } catch(error) { if(transaction) await db.query('rollback'); throw error; }
}
