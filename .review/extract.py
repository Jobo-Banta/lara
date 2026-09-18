from docx import Document
from pathlib import Path
p=Path('docs/DCP_BRD_LARA_v1_0.docx')
d=Document(p)
lines=[]
for el in d.element.body:
 if el.tag.endswith('}p'):
  from docx.text.paragraph import Paragraph
  q=Paragraph(el,d); lines.append(q.text)
 elif el.tag.endswith('}tbl'):
  from docx.table import Table
  for r in Table(el,d).rows: lines.append(' | '.join(c.text for c in r.cells))
Path('.review/brd_original.txt').write_text('\n'.join(lines),encoding='utf-8')
print('\n'.join(lines))
