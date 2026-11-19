import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdir,mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {createStaticHandler,createStaticRouter,StaticRouterProvider,StaticRouter} from 'react-router';
await mkdir('node_modules/.cache',{recursive:true});
const dir=await mkdtemp('node_modules/.cache/operations-');
const boundary={name:'readonly-boundaries',setup(b){
 b.onResolve({filter:/\/(db\.server|shopify\.server|geniki\.server)(\.js)?$/},a=>({path:a.path.split('/').at(-1).replace(/\.js$/,''),namespace:'boundary'}));
 b.onLoad({filter:/.*/,namespace:'boundary'},a=>({contents:a.path==='db.server'?'export default new Proxy({},{get:(_,key)=>globalThis.__ops.db[key]});':a.path==='shopify.server'?'export const authenticate={admin:async()=>({admin:{},session:{shop:"mine.myshopify.com"}})};':'export const isCourierTestShop=shop=>shop.startsWith("dev-");export const genikiLive={authenticate:async()=>"key",closeBetween:(...args)=>globalThis.__ops.close(...args)};export const genikiSandbox=genikiLive;export const genikiParcelNumbers=()=>{throw new Error("Unexpected voucher issuance")};export const genikiJobFromLookup=()=>null;'}));
}};
const options={bundle:true,platform:'node',format:'esm',packages:'external',jsx:'automatic',plugins:[boundary],logLevel:'silent'};
for(const [name,file] of [['handover','app/services/geniki-handover.server.js'],['actions','app/components/VoucherActions.tsx'],['daily','app/components/DailyHandover.tsx'],['acs','app/routes/app.acs-operations.jsx'],['geniki','app/routes/app.geniki-operations.jsx']])await build({...options,entryPoints:[file],outfile:join(dir,name+'.mjs')});
// Absolute file URLs keep the test independent of the temporary directory name.
const {pathToFileURL}=await import('node:url');
const load=async name=>import(pathToFileURL(join(process.cwd(),dir,name+'.mjs')).href);
const handover=await load('handover'),actions=await load('actions'),acs=await load('acs'),geniki=await load('geniki'),daily=await load('daily');
const row={id:'shipment1',carrier:'Geniki',voucher:'5200000001',orderName:'#WB-1',orderId:'gid://shopify/Order/1',status:'DELIVERED'};
const request=(url,values)=>new Request('https://example.test'+url,values?{method:'POST',body:new URLSearchParams(values)}:{});
function fixture(){
 const records=new Map(),calls=[],writes=[];
 globalThis.__ops={calls,writes,close:async(...args)=>{calls.push(args);},db:{
  genikiDailyHandover:{upsert:async({where,create,update})=>{const key=JSON.stringify(where),old=records.get(key);const value=old?{...old,finalizedAt:update.finalizedAt,confirmations:old.confirmations+1}:{...create,confirmations:1};records.set(key,value);return value;}},
  acsManualShipment:{findMany:async()=>[]},acsTrackingTagRule:{findMany:async()=>[],upsert:async arg=>{writes.push(arg);return arg;}},
  courierShipment:{findMany:async arg=>{calls.push(arg);return [row];},findFirst:async()=>null},genikiTagRule:{findMany:async()=>[]},$transaction:async values=>Promise.all(values),
 }};
 return globalThis.__ops;
}
async function markup(module,path){
 const handler=createStaticHandler([{path:'/app/*',loader:module.loader,Component:module.default}]);
 const context=await handler.query(request(path));
 assert.equal(context.errors,null);
 return renderToStaticMarkup(createElement(StaticRouterProvider,{router:createStaticRouter(handler.dataRoutes,context),context,hydrate:false}));
}
test('Geniki closure persists date, environment, confirmation time and repeated submissions',async()=>{
 const f=fixture();let r=await handover.finalizeGenikiDay('mine.myshopify.com','2026-11-19','live','2026-11-19');
 assert.equal(r.record.confirmations,1);assert.ok(r.record.finalizedAt instanceof Date);assert.deepEqual(f.calls[0],['key','2026-11-19T00:00:00','2026-11-19T23:59:59.999']);
 r=await handover.finalizeGenikiDay('mine.myshopify.com','2026-11-19','live','2026-11-19');assert.equal(r.record.confirmations,2);assert.match(r.messages[0],/does not count newly closed vouchers/);
});
test('Invalid dates, future dates and environment mismatches never call the courier',async()=>{
 const f=fixture();
 for(const [date,env,shop] of [['2026-02-30','live','mine'],['2026-11-20','live','mine'],['2026-11-19','test','mine'],['2026-11-19','live','dev-mine']])await assert.rejects(handover.finalizeGenikiDay(shop,date,env,'2026-11-19'));
 assert.equal(f.calls.length,0);
});
test('Carrier failures do not record a closure; history failure does not disguise a successful carrier operation',async()=>{
 const f=fixture();f.close=async()=>{throw new Error('Carrier failed');};let writes=0;f.db.genikiDailyHandover.upsert=async()=>{writes++;throw new Error('DB unavailable');};
 await assert.rejects(handover.finalizeGenikiDay('mine','2026-11-19','live','2026-11-19'),/Carrier failed/);assert.equal(writes,0);
 f.close=async()=>{};const result=await handover.finalizeGenikiDay('mine','2026-11-19','live','2026-11-19');assert.match(result.messages[0],/Geniki confirmed/);assert.match(result.messages[0],/Do not repeat/);
});
test('Daily actions expose aligned replace/cancel controls and never a return action',()=>{
 const html=renderToStaticMarkup(createElement(StaticRouter,{location:"/app"},createElement(actions.DailyVoucherActions,{row,params:new URLSearchParams(),sandbox:false})));
 assert.match(html,/daily-voucher-actions/);assert.match(html,/mode=replace/);assert.match(html,/Cancel voucher/);assert.doesNotMatch(html,/customer return|section=return/);
 const cancelled=renderToStaticMarkup(createElement(StaticRouter,{location:"/app"},createElement(actions.DailyVoucherActions,{row:{...row,status:'Cancelled'},params:new URLSearchParams(),sandbox:false})));assert.equal(cancelled,'');
});
test('Return controls are restricted to active Shopify shipments originally sent with Geniki',()=>{
 for(const invalid of [{...row,carrier:'ACS'},{...row,status:'Cancelled'},{...row,orderId:'manual:1'},null])assert.equal(actions.canCreateGenikiReturn(invalid),false);
 const html=renderToStaticMarkup(createElement(StaticRouter,{location:"/app"},createElement(actions.CustomerReturnLink,{row,params:new URLSearchParams('shop=mine.myshopify.com&view=tracking')})));
 assert.match(html,/section=return/);assert.match(html,/shipment=shipment1/);assert.match(html,/Create customer return/);assert.doesNotMatch(html,/view=tracking/);
});
test('ACS Operations embeds manual creation and saved tag settings in their own working forms',async()=>{
 fixture();let html=await markup(acs,'/app/acs-operations');assert.match(html,/name="recipientName"/);assert.match(html,/action="\/app\/acs-operations\?section=manual"/);assert.doesNotMatch(html,/Shipment tracking|Pickup lists and labels/);
 html=await markup(acs,'/app/acs-operations?section=tags');assert.match(html,/ACS_RETURNED/);assert.match(html,/Save tag settings/);assert.match(html,/action="\/app\/acs-operations\?section=tags"/);assert.doesNotMatch(html,/name="recipientName"/);
});
test('Saving ACS tags through Operations preserves existing status keys and validation',async()=>{
 const f=fixture(),data=await acs.loader({request:request('/app/acs-operations?section=tags')});
 const rules=data.rules.map(r=>({...r,enabled:r.status==='RETURNED',tag:r.status==='RETURNED'?'ACS RETURNED':''}));
 const result=await acs.action({request:request('/app/acs-operations?section=tags',{rules:JSON.stringify(rules)})});
 assert.equal((await result.json()).success,true);assert.equal(f.writes.length,10);assert.equal(f.writes.find(r=>r.create.status==='RETURNED').update.tag,'ACS RETURNED');
});
test('Geniki return hub is visible without choosing a voucher and searches eligible shipments',async()=>{
 const f=fixture(),html=await markup(geniki,'/app/geniki-operations?section=return&q=WB-1');
 assert.match(html,/Customer returns/);assert.match(html,/Create customer return/);assert.match(html,/shipment=shipment1/);assert.doesNotMatch(html,/name="weight"/);assert.equal(f.calls[0].where.environment,'live');assert.equal(f.calls[0].where.AND[1].OR[0].orderName.contains,'WB-1');
});
test('Geniki close panel has one submit button and displays a persisted confirmation after reloading',async()=>{
 const data={date:'2026-11-19',carrier:'Geniki',sandbox:false,dailyTotals:{ACS:0,Geniki:1},pickupLists:[],pickupWarning:'',genikiHandovers:[{date:'2026-11-19',environment:'live',finalizedAt:'2026-11-19T12:45:00Z',confirmations:1}]};
 const page={loader:async()=>({}),default:()=>createElement(daily.DailyHandover,data)};
 const html=await markup(page,'/app');
 assert.match(html,/Already finalized for 2026-11-19/);assert.match(html,/Athens time/);assert.match(html,/Finalize again with Geniki/);assert.doesNotMatch(html,/name="confirmClose"|type="checkbox"/);assert.equal((html.match(/value="close"/g)||[]).length,1);
});
test.after(async()=>{await rm(dir,{recursive:true,force:true});});
