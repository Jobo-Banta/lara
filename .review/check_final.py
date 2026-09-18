from pathlib import Path
import re
p=Path('docs/DCP_BRD_LARA_v1_1.md')
s=p.read_text(encoding='utf-8'); groups=re.findall(r'(?:^\|.*\n)+',s,re.M)
errors=[]
for table in groups:
 rows=table.strip().splitlines(); counts=[len(re.split(r'(?<!\\)\|',x)) for x in rows]
 if len(set(counts))>1: errors.append(rows[0])
assert not errors,errors
for key in ['AI-017','AI-019','AI-020','AI-022']:
 row=next(x for x in s.splitlines() if x.startswith('| '+key+' |'))
 assert row.endswith('| 2 |'),row
assert len(re.findall(r'^### REV \d+',s,re.M))==16
assert 'all records, logs, attachments, and backups kept for at least 10 years' not in s.lower()
assert 'no outside licence terms apply' not in s.lower()
assert 'future access, export generation and hosted-link downloads' in s
print('PASS: table column consistency, deferred AI phases, 16 acceptance requirements, and corrected high-risk claims.')
