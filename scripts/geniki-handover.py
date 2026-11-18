import sys
import json
from pathlib import Path
from xml.sax.saxutils import escape
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

data = json.load(sys.stdin)
pdfmetrics.registerFont(TTFont("Manifest",str(next(Path("/usr/share/fonts").rglob("DejaVuSans.ttf")))))
def cell(value, size=10):
    return Paragraph(escape(str(value or "—")), ParagraphStyle("manifest",fontName="Manifest",fontSize=size,leading=size+4))

rows = data["rows"]
table = Table([[cell(v) for v in row] for row in [["Order","Voucher","Recipient","Country","Parcels"],*rows]],colWidths=[82,118,180,60,50],repeatRows=1)
table.setStyle(TableStyle([("VALIGN",(0,0),(-1,-1),"TOP"),("ROWBACKGROUNDS",(0,1),(-1,-1),[colors.white,colors.HexColor("#eff5f5")]),("LINEBELOW",(0,0),(-1,0),1,colors.black)]))
SimpleDocTemplate(sys.stdout.buffer,pagesize=A4,title="Geniki daily handover").build([cell("Geniki · Daily handover",20),cell("Courier Label / "+data["environment"]+" / "+data["date"]),Spacer(1,12),cell(str(len(rows))+" shipments · "+str(sum(int(r[-1]) for r in rows))+" parcels"),Spacer(1,16),table])
