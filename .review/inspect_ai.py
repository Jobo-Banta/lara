from docx import Document
from lxml import etree
from pathlib import Path
d=Document('docs/DCP_BRD_LARA_v1_0.docx')
for t in d.tables:
 if any('AI-013' in c.text for r in t.rows for c in r.cells):
  for r in t._tbl:
   s=' | '.join(r.xpath('.//w:t/text()'))
   print(s.encode('ascii','replace').decode())
