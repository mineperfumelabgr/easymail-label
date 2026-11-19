import {randomUUID} from "node:crypto";
import {Form,Link,useActionData,useLoaderData,useNavigation} from "react-router";
import {PDFDocument} from "pdf-lib";
import {authenticate} from "../shopify.server";
import db from "../db.server";
import {operationContext,issueOrderVoucher,finishVoucherTracking} from "../services/voucher-operations.server";
import {todayYMD} from "../services/acs-create-label.server";
import {genikiLive,genikiSandbox} from "../services/geniki.server";
import {printAcsVoucher,extractPdfBytesFromAcsResponse} from "../services/acs.server";
import {PrintDocuments} from "../components/PrintDocuments";
import {OrderIdentity} from "../components/OrderIdentity";
import {TrackingNumber} from "../components/TrackingNumber";
import "../styles/courier.css";

function selection(params){return {mode:params.get("mode")==="replace"?"replace":"new",orderId:params.get("order"),shipmentId:params.get("shipment"),voucher:params.get("voucher"),carrier:params.get("carrier")};}
export async function loader({request}){
  const {admin,session:{shop}}=await authenticate.admin(request);
  const input=selection(new URL(request.url).searchParams);
  try{return {...await operationContext(admin,shop,input),input,shop,token:randomUUID(),employees:await db.employee.findMany({where:{shop},orderBy:{name:"asc"}}),date:todayYMD()};}
  catch(error){return {error:error.message,input};}
}
async function labelPdf(row){
  const pdf=await PDFDocument.create(),api=row.environment==="test"?genikiSandbox:genikiLive;
  const key=row.carrier==="Geniki"?await api.authenticate():null;
  for(const number of row.carrier==="ACS"?[row.voucher]:(row.labels||[row.voucher])){
    const bytes=row.carrier==="Geniki"?await api.pdf(key,number):extractPdfBytesFromAcsResponse(await printAcsVoucher(number,{printType:1,startPosition:1}));
    const source=await PDFDocument.load(bytes);
    for(const page of await pdf.copyPages(source,source.getPageIndices()))pdf.addPage(page);
  }
  if(!pdf.getPageCount())throw new Error("The carrier returned no label pages.");
  return Buffer.from(await pdf.save()).toString("base64");
}
export async function action({request}){
  const {admin,session:{shop}}=await authenticate.admin(request),form=await request.formData();
  let row;
  try{
    if(form.get("op")==="sync")row=await finishVoucherTracking(admin,shop,String(form.get("operationId")));
    else{
      const employee=await db.employee.findFirst({where:{shop,id:String(form.get("employee")||"")}});
      if(!employee)throw new Error("Select the employee preparing this shipment.");
      row=await issueOrderVoucher(admin,shop,{...selection(new URL(request.url).searchParams),...Object.fromEntries(form),employee:employee.name});
    }
    const replaced=row.fulfillmentPlan.operation==="replace";
    const message=replaced?`Replacement completed. Previous voucher cancelled; ${row.carrier} voucher ${row.voucher} now replaces its tracking. Shopify fulfillment status was preserved.`:`New voucher ${row.voucher} created. Tracking added to Shopify; previous vouchers and fulfillment status were preserved.`;
    try{return {ok:true,message,row,pdf:await labelPdf(row)};}
    catch(error){return {ok:true,message,row,warning:"Voucher and tracking are saved. Label PDF unavailable: "+error.message+". Reprint it from Daily Labels."};}
  }catch(error){
    if(form.get("op")==="sync")error.operationId=String(form.get("operationId")||"");
    if(error.operationId){
      const issued=await db.courierShipment.findFirst({where:{id:error.operationId,shop}});
      return {ok:false,message:error.message,operationId:error.operationId,row:issued,pdf:issued?await labelPdf(issued).catch(()=>null):null};
    }
    return {ok:false,message:error.message};
  }
}

export default function ShipmentOperation(){
  const data=useLoaderData(),result=useActionData(),busy=useNavigation().state!=="idle";
  const {order,prior,input,employees,date,token,fulfillments,defaultCod,shop}=data;
  const replace=input.mode==="replace";
  return <main className="courier operations shipment-operation">
    <header><h1>{replace?"Replace voucher":"New voucher for an existing order"}</h1><Link to="/app">← Prepare orders</Link> · <Link to="/app?view=daily">Daily Labels</Link></header>
    {result&&<section className="operation-notice" data-tone={result.ok?"success":"error"} role={result.ok?"status":"alert"}>
      <h2>{result.ok?"Voucher ready":"Action not completed"}</h2><p>{result.message}</p>
      {result.warning&&<p role="alert">{result.warning}</p>}
      {result.operationId&&<Form method="post"><input type="hidden" name="operationId" value={result.operationId}/><button name="op" value="sync" disabled={busy}>Retry tracking sync · use the existing new voucher</button></Form>}
      {result.row&&<p><TrackingNumber carrier={result.row.carrier} number={result.row.voucher}/> · <Link to="/app?view=daily">Open Daily Labels</Link></p>}
      {result.pdf&&<PrintDocuments result={result}/>}
    </section>}
    {data.error?<section role="alert"><h2>Review this shipment</h2><p>{data.error}</p><p>For delivered or returned shipments, use New voucher in Prepare orders.</p></section>:!result?.ok&&<section>
      <OrderIdentity row={order} shop={shop}/>
      <p>{replace?"Cancels the selected carrier voucher first, then creates a replacement and substitutes only that voucher’s tracking on the same Shopify fulfillment. If cancellation is refused, no new voucher is issued.":"Creates an additional shipment. Previous vouchers stay active and remain in the tracking history. The new tracking is added to the selected existing Shopify fulfillment."}</p>
      {prior&&<p>Selected voucher: <TrackingNumber carrier={prior.carrier} number={prior.voucher}/> · {prior.status}</p>}
      <Form method="post" className="voucher-operation-form">
        <input type="hidden" name="token" value={token}/>
        <div className="controls">
          <label>Courier <select name="carrier" defaultValue={replace?prior.carrier:input.carrier||prior?.carrier||(order.shippingAddress.countryCodeV2==="GR"?"ACS":"Geniki")} disabled={replace}><option>ACS</option><option>Geniki</option></select></label>
          <label>Parcels <input type="number" name="pieces" min="1" max="5" defaultValue={prior?.pieces||1} required/></label>
          <label>Packed weight (kg) <input type="number" name="weight" min=".01" step=".01" defaultValue={prior?.weight||1} required/></label>
          <label>COD (€) <input type="number" name="cod" min="0" step=".01" defaultValue={order.shippingAddress.countryCodeV2==="GR"?defaultCod:0} readOnly={order.shippingAddress.countryCodeV2!=="GR"} required/><small>0 = no collection · Greece only</small></label>
          <label>Pickup date <input type="date" name="pickupDate" min={date} defaultValue={date} required/></label>
          <label>Prepared by <select name="employee" required defaultValue=""><option value="">Choose employee</option>{employees.map(e=><option value={e.id} key={e.id}>{e.name}</option>)}</select></label>
          <label>Shopify fulfillment <select name="fulfillmentId" defaultValue={replace?prior.fulfillmentId:fulfillments[0].id} disabled={replace}>{fulfillments.map(f=><option key={f.id} value={f.id}>{f.id.split("/").pop()} · {f.trackingInfo.map(t=>t.number).join(", ")||"No tracking"}</option>)}</select></label>
        </div>
        <label className="operation-confirm"><input type="checkbox" name="confirm" required/> {replace?"Cancel the selected voucher and issue a replacement":"Create a new voucher and keep all previous vouchers"}</label>
        <button className={replace?"replace-voucher-button":"new-voucher-button"} disabled={busy} name="op" value="issue">{busy?"Processing — do not submit again…":replace?"Cancel previous + create replacement":"Create new voucher + print"}</button>
      </Form>
    </section>}
  </main>;
}
