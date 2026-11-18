import json
import sys
from xml.sax.saxutils import escape
from reportlab.lib import colors
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.pagesizes import A4
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, PageBreak
from pathlib import Path

font = next(Path("/usr/share/fonts").rglob("DejaVuSans.ttf"))
pdfmetrics.registerFont(TTFont("Packing", str(font)))
def paragraph(value, size=11):
    return Paragraph(escape(str(value or "")), ParagraphStyle("text", fontName="Packing", fontSize=size, leading=size+4, splitLongWords=True))

document = SimpleDocTemplate(sys.stdout.buffer, pagesize=A4, title="Packing slips", leftMargin=42, rightMargin=42)
story = []
for order in json.load(sys.stdin):
    if story:
        story.append(PageBreak())
    story.extend([paragraph("MINE PERFUME LAB", 14), paragraph("Packing slip · "+order["name"], 23), Spacer(1, 18)])
    address = order.get("shippingAddress") or {}
    for key in ("name","company","address1","address2","zip","city","country"):
        if address.get(key):
            story.append(paragraph(address[key]))
    story.append(Spacer(1, 22))
    rows = [[paragraph("Item"), paragraph("SKU"), paragraph("Qty")]]
    for item in order["items"]:
        if item["currentQuantity"]:
            rows.append([paragraph(item["name"]), paragraph(item.get("sku")), paragraph(item["currentQuantity"])])
    table = Table(rows, colWidths=[300,140,60], repeatRows=1)
    table.setStyle(TableStyle([("VALIGN",(0,0),(-1,-1),"TOP"),("LINEBELOW",(0,0),(-1,0),1,colors.black),("BOTTOMPADDING",(0,0),(-1,-1),7)]))
    story.append(table)
document.build(story)
