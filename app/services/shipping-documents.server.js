import {readFile} from "node:fs/promises";
import {createRequire} from "node:module";
import {PDFDocument, rgb} from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";

const require = createRequire(import.meta.url);
const fontBytes = readFile(require.resolve("dejavu-fonts-ttf/ttf/DejaVuSans.ttf"));
const margin = 42;
const width = 595.28;
const height = 841.89;

export async function shippingDocument(kind, payload) {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const font = await pdf.embedFont(await fontBytes, {subset:true});
  const characters = new Set(font.getCharacterSet());
  let page, y;

  function newPage() {
    page = pdf.addPage([width,height]);
    y = height-margin;
  }

  function lines(value, maxWidth, size) {
    const result=[];
    const clean=Array.from(String(value ?? "")).map(c=> c==="\n" || characters.has(c.codePointAt(0)) ? c : "?").join("");
    for (const paragraph of clean.split(/\r?\n/)) {
      let line="";
      for (const word of paragraph.split(/\s+/)) {
        const candidate=line?line+" "+word:word;
        if (font.widthOfTextAtSize(candidate,size)<=maxWidth) {line=candidate;continue}
        if(line)result.push(line);
        line="";
        for(const letter of word){
          if(line && font.widthOfTextAtSize(line+letter,size)>maxWidth){result.push(line);line=""}
          line+=letter;
        }
      }
      result.push(line);
    }
    return result;
  }

  function text(value,size=11){
    for(const line of lines(value,width-2*margin,size)){
      if(y-size-4<margin)newPage();
      page.drawText(line,{x:margin,y:y-size,font,size,color:rgb(.1,.16,.22)});
      y-=size+5;
    }
  }

  function table(headers, rows, columns){
    const size=10, leading=14;
    function header(){
      let x=margin;
      page.drawRectangle({x,y:y-25,width:width-2*margin,height:25,color:rgb(.92,.95,.97)});
      headers.forEach((label,i)=>{
        page.drawText(label,{x:x+5,y:y-17,font,size});x+=columns[i];
      });
      y-=30;
    }
    header();
    for(const row of rows){
      const cells=row.map((value,i)=>lines(value,columns[i]-10,size));
      let offset=0;
      const count=Math.max(...cells.map(cell=>cell.length));
      const rowHeight=count*leading+8;
      if(rowHeight<height-2*margin-30 && y-rowHeight<margin){newPage();header()}
      while(offset<count){
        let available=Math.floor((y-margin-8)/leading);
        if(available<1){newPage();header();available=Math.floor((y-margin-8)/leading)}
        const take=Math.min(available,count-offset);
        let x=margin;
        cells.forEach((cell,i)=>{
          cell.slice(offset,offset+take).forEach((line,j)=>page.drawText(line,{x:x+5,y:y-size-j*leading,font,size}));
          x+=columns[i];
        });
        y-=take*leading+8;
        offset+=take;
        page.drawLine({start:{x:margin,y},end:{x:width-margin,y},thickness:.5,color:rgb(.8,.85,.88)});
      }
    }
  }

  if(kind==="packing"){
    pdf.setTitle("Packing slips");
    for(const order of payload){
      newPage();
      text("MINE PERFUME LAB",14);
      text("Packing slip · "+order.name,23);
      y-=18;
      const address=order.shippingAddress||{};
      for(const key of ["name","company","address1","address2","zip","city","country"])if(address[key])text(address[key]);
      y-=22;
      table(["Item","SKU","Qty"],order.items.filter(item=>item.currentQuantity>0).map(item=>[item.name,item.sku,item.currentQuantity]),[301,150,60]);
    }
  }else if(kind==="handover"){
    pdf.setTitle("Geniki daily handover");
    newPage();
    text("Geniki · Daily handover",20);
    text("Courier Label / "+payload.environment+" / "+payload.date);
    y-=12;
    text(payload.rows.length+" shipments · "+payload.rows.reduce((n,row)=>n+Number(row[4]),0)+" parcels");
    y-=16;
    table(["Order","Voucher","Recipient","Country","Parcels"],payload.rows,[82,118,180,65,66]);
  }else throw new Error("Unknown shipping document");
  return Buffer.from(await pdf.save()).toString("base64");
}
