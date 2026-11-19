import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {Liquid} from 'liquidjs';

const snapshots = new Set(['7gidg0-ut.myshopify.com','mine-perfume-lab-gr-dev.myshopify.com']);
const cache = new Map();
const templatePath = () => path.resolve('app/templates/packing-slip.liquid');
export const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const safeData = value => Array.isArray(value) ? value.map(safeData) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k,v])=>[k,safeData(v)])) : typeof value === 'string' ? escapeHtml(value) : value;

export async function packingTemplate(admin, shop, graphql) {
  const saved=cache.get(shop);
  if(saved && saved.expires>Date.now()) return saved.template;
  let template;
  try {
    let after=null, resources=[];
    do {
      const {data}=await graphql(admin,`query PackingTemplate($after:String){translatableResources(first:100,after:$after,resourceType:PACKING_SLIP_TEMPLATE){nodes{resourceId translatableContent{key value locale}} pageInfo{hasNextPage endCursor}}}`,{after});
      resources.push(...data.translatableResources.nodes);
      after=data.translatableResources.pageInfo.hasNextPage?data.translatableResources.pageInfo.endCursor:null;
    }while(after);
    const resource=resources.find(r=>r.resourceId==='gid://shopify/PackingSlipTemplate/5159682396') ?? (resources.length===1?resources[0]:null);
    const body=resource?.translatableContent.find(c=>c.key==='body');
    if(!body?.value) throw new Error('The Shopify packing slip template could not be identified.');
    template={body:body.value,locale:body.locale||'en',source:'shopify'};
  } catch(error) {
    if(!snapshots.has(shop) || !/access denied|access_denied|read_translations|not approved/i.test(error.message)) throw error;
    template={body:await readFile(templatePath(),'utf8'),locale:'el',source:'saved-shopify-template'};
  }
  cache.set(shop,{template,expires:Date.now()+120000});
  return template;
}

function address(a,locale) {
  if(!a) return null;
  return {...a,country:a.countryCodeV2?new Intl.DisplayNames([locale],{type:'region'}).of(a.countryCodeV2):a.country,country_code:a.countryCodeV2,city_province_zip:[a.zip,a.city,a.provinceCode].filter(Boolean).join(' ')};
}

export function packingContext(order,shop,history=[],locale='el') {
  const items=order.lineItems.nodes;
  const pending=items.some(i=>i.unfulfilledQuantity>0);
  const selected=items.map(i=>({...i,shipping_quantity:pending?i.unfulfilledQuantity:(order.fulfilledQuantities?.[i.id]??i.currentQuantity)})).filter(i=>i.shipping_quantity>0);
  if(!selected.length) throw new Error(`${order.name}: no shipment items are available for a packing slip.`);
  const ctx={
    shop:{name:shop.name,email:shop.email,domain:shop.primaryDomain.host},
    shop_address:{summary:[shop.shopAddress?.address1,shop.shopAddress?.address2,shop.shopAddress?.zip,shop.shopAddress?.city,new Intl.DisplayNames([locale],{type:'region'}).of(shop.shopAddress?.countryCodeV2||'GR')].filter(Boolean).join(', ')},
    shipping_address:address(order.shippingAddress,locale),billing_address:address(order.billingAddress,locale),
    order:{name:order.name,po_number:order.poNumber,created_at:order.createdAt,tags:order.tags.join(', '),note:order.note,
      financial_status:order.displayFinancialStatus.toLowerCase(),financial_status_label:order.displayFinancialStatus==='PAID'?'Paid':order.displayFinancialStatus,
      customer:order.customer?{orders_count:Number(order.customer.numberOfOrders),orders:history.map(o=>({name:o.name,line_items:o.lineItems.nodes.map(i=>({title:i.title}))}))}:null},
    line_items_in_shipment:selected.map(i=>({title:i.title,variant_title:i.variantTitle==='Default Title'?'':i.variantTitle,sku:i.sku,quantity:i.quantity,shipping_quantity:i.shipping_quantity,
      image:i.image?{url:i.image.url}:null,properties:Object.fromEntries(i.customAttributes.map(a=>[a.key,a.value])),groups:i.lineItemGroup?[{title:i.lineItemGroup.title}]:[]})),
    includes_all_line_items_in_order:items.every(i=>selected.some(s=>s.id===i.id&&s.shipping_quantity>=i.currentQuantity)),
    delivery_method:{instructions:order.deliveryInstructions||''},
  };
  const escaped=safeData(ctx);
  // Image URLs are validated by the renderer, separately from text inserted into HTML.
  escaped.line_items_in_shipment.forEach((i,index)=>{i.image=ctx.line_items_in_shipment[index].image;});
  return escaped;
}

export async function packingHtml(template,context) {
  const engine=new Liquid({strictFilters:true,jsTruthy:false,lenientIf:true});
  const nativeDate=engine.filters.date;
  engine.registerFilter('date',(value,...args)=>{
    if(args.some(a=>Array.isArray(a)&&a[0]==='format'&&a[1]==='date')) {
      const d=new Date(value),tz={timeZone:'Europe/Athens'};
      if(!Number.isFinite(d.getTime()))return '';
      return `${new Intl.DateTimeFormat(template.locale,{...tz,day:'numeric'}).format(d)} ${(template.locale.startsWith('el')?['Ιανουάριος','Φεβρουάριος','Μάρτιος','Απρίλιος','Μάιος','Ιούνιος','Ιούλιος','Αύγουστος','Σεπτέμβριος','Οκτώβριος','Νοέμβριος','Δεκέμβριος'][Number(new Intl.DateTimeFormat('en',{...tz,month:'numeric'}).format(d))-1]:new Intl.DateTimeFormat(template.locale,{...tz,month:'long'}).format(d))} ${new Intl.DateTimeFormat(template.locale,{...tz,year:'numeric'}).format(d)}`;
    }
    return nativeDate.call(engine,value,...args);
  });
  engine.registerFilter('img_url',(image,size)=>{
    if(!image?.url) return '';
    const url=new URL(image.url),[width,height]=String(size).trim().split('x').map(Number);
    if(url.protocol!=='https:'||url.hostname!=='cdn.shopify.com')return '';
    if(width>0)url.searchParams.set('width',String(Math.min(width,1000)));
    if(height>0)url.searchParams.set('height',String(Math.min(height,1000)));
    return url.toString();
  });
  engine.registerFilter('img_tag',(src,alt='',className='')=>src?`<img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" class="${escapeHtml(className)}">`:'');
  return engine.parseAndRender(template.body,context);
}
