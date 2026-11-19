import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {PDFDocument} from 'pdf-lib';
import {packingContext,packingHtml,packingTemplate} from '../app/services/packing-slip-template.server.js';
import {renderPackingPdfs} from '../app/services/packing-slip-renderer.server.js';
const template={body:await readFile(new URL('../app/templates/packing-slip.liquid',import.meta.url),'utf8'),locale:'el'};
const shop={name:'Mine Perfume Lab GR',email:'info@example.com',primaryDomain:{host:'example.com'},shopAddress:{address1:'Shop street 1',city:'Thessaloniki',zip:'54622',countryCodeV2:'GR'}};
function order(patch={}){
 const item={id:'item1',title:'SAMPLE SET - TEST',variantTitle:'Default Title',sku:'SKU1',currentQuantity:2,quantity:2,unfulfilledQuantity:2,image:null,customAttributes:[{key:'Preorder',value:'Ships by 27/11/2026'}],lineItemGroup:null};
 return {name:'#TEST-1',createdAt:'2026-11-18T12:00:00Z',tags:['COD'],displayFinancialStatus:'PAID',customer:{numberOfOrders:'1'},shippingAddress:{name:'Test recipient',address1:'Test street 1',city:'Athens',zip:'12345',countryCodeV2:'GR'},billingAddress:null,lineItems:{nodes:[item]},...patch};
}
test('Original template retains paid-over-COD precedence, localized date, preorder, sample code and QR',async()=>{
 const html=await packingHtml(template,packingContext(order(),shop));
 assert.match(html,/>PAID</);assert.doesNotMatch(html,/>COD</);assert.match(html,/18 Νοέμβριος 2026/);assert.match(html,/Ships by 27\/11\/2026/);assert.match(html,/SAMPLE20%/);assert.match(html,/instagram_qr/);assert.match(html,/Ελλάδα/);
 assert.match(html,/1\/2/);assert.match(html,/2\/2/);
});
test('Pending quantities and fulfilled/refunded reprints select shipment quantities',()=>{
 const o=order();o.lineItems.nodes[0].unfulfilledQuantity=1;
 assert.equal(packingContext(o,shop).line_items_in_shipment[0].shipping_quantity,1);
 o.lineItems.nodes[0].unfulfilledQuantity=0;o.lineItems.nodes[0].currentQuantity=0;o.fulfilledQuantities={item1:2};
 assert.equal(packingContext(o,shop).line_items_in_shipment[0].shipping_quantity,2);
 delete o.fulfilledQuantities;assert.throws(()=>packingContext(o,shop),/no shipment items/);
});
test('Recipient text and item properties remain text, including malicious HTML',async()=>{
 const o=order();o.shippingAddress.name='<img src="https://internal/">';o.lineItems.nodes[0].customAttributes=[{key:'Gift',value:'<script>bad()</script>'}];
 const html=await packingHtml(template,packingContext(o,shop));assert.match(html,/&lt;img/);assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/<script>/);
});
test('Cyprus and Bulgaria use native template translations; customer history is included',async()=>{
 const o=order({displayFinancialStatus:'PENDING',customer:{numberOfOrders:'4'}});
 o.shippingAddress.countryCodeV2='BG';
 const history=[{name:'#EARLIER',lineItems:{nodes:[{title:'Earlier perfume'}]}}];
 const html=await packingHtml(template,packingContext(o,shop,history));assert.match(html,/Поръчка/);assert.match(html,/#EARLIER/);assert.match(html,/Earlier perfume/);assert.match(html,/>COD</);
 o.shippingAddress.countryCodeV2='CY';assert.match(await packingHtml(template,packingContext(o,shop)),/Παραγγελία/);
});
test('Live Shopify template wins; access denial uses owner snapshot and other errors remain visible',async()=>{
 let calls=0;
 const live=await packingTemplate({},'custom.myshopify.com',async()=>{calls++;return {data:{translatableResources:{nodes:[{resourceId:'gid://shopify/PackingSlipTemplate/1',translatableContent:[{key:'body',value:'CUSTOM',locale:'en'}]}],pageInfo:{hasNextPage:false}}}};});
 assert.equal(live.body,'CUSTOM');await packingTemplate({},'custom.myshopify.com',()=>{throw new Error('unexpected');});assert.equal(calls,1);
 const fallback=await packingTemplate({},'7gidg0-ut.myshopify.com',()=>{throw new Error('Access denied: read_translations');});assert.equal(fallback.body.trim(),template.body.trim());
 await assert.rejects(packingTemplate({},'another.myshopify.com',()=>{throw new Error('Access denied: read_translations');}));
 await assert.rejects(packingTemplate({},'mine-perfume-lab-gr-dev.myshopify.com',()=>{throw new Error('Network unavailable');}),/Network unavailable/);
});
test('A merged print PDF preserves separate orders, multilingual text and long-order pagination',async()=>{
 const first=order(),second=order({name:'#TEST-BG'});second.shippingAddress.countryCodeV2='BG';
 second.lineItems.nodes=Array.from({length:20},(_,i)=>({...first.lineItems.nodes[0],id:'item'+i,title:'BULGARIA ITEM '+i,quantity:1,currentQuantity:1,unfulfilledQuantity:1}));
 const htmls=await Promise.all([first,second].map(o=>packingHtml(template,packingContext(o,shop))));
 const bytes=await renderPackingPdfs(htmls),doc=await PDFDocument.load(bytes);assert.ok(doc.getPageCount()>=3);
 const dir=await mkdtemp(join(tmpdir(),'courier-packing-'));
 try{
  const file=join(dir,'batch.pdf');await writeFile(file,bytes);
  const text=execFileSync('pdftotext',[file,'-'],{encoding:'utf8'});
  assert.match(text,/#TEST-1/);assert.match(text,/#TEST-BG/);assert.match(text,/BULGARIA ITEM 19/);assert.match(text,/SAMPLE20%/);assert.match(text,/18 Νοέμβριος 2026/);
 }finally{await rm(dir,{recursive:true,force:true});}
});
