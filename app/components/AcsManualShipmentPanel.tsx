import {useFetcher} from "react-router";
import {PrintDocuments} from "./PrintDocuments";
const ymd=()=>new Intl.DateTimeFormat("en-CA",{timeZone:"Europe/Athens",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
type ManualShipment={id:string;createdAt:string|Date;recipientName:string;city:string;countryCode:string;voucherNo:string;pieces:number;pickupDate:string};
type ManualResult={pdf?:string;success?:boolean;message?:string;errors?:string[];shipment?:ManualShipment};
export function AcsManualShipmentPanel({shipments,action}:{shipments:ManualShipment[];action?:string}) {
  const fetcher = useFetcher<ManualResult>();
  const busy = fetcher.state !== "idle";
  const result = fetcher.data;
  return <><section><h2>Manual shipment</h2>
    <p>Create an ACS shipment directly, without a Shopify order. These labels are stored here and do not change Shopify order status or tags.</p>
    {result?.pdf && <PrintDocuments result={result}/>}
    {result?.success && result.shipment ? <s-banner tone="success">Voucher {result.shipment.voucherNo} created. <fetcher.Form method="post" action={action}><input type="hidden" name="id" value={result.shipment!.id}/><button name="op" value="print">Print labels</button></fetcher.Form></s-banner> : null}
    {result?.message && <p role="alert">{result.message}</p>}
    {result?.errors?.length ? <s-banner tone="critical">{result.errors.join(" ")}</s-banner> : null}
    <fetcher.Form method="post" action={action} className="custom-form">
      <label>Recipient name<input name="recipientName" required /></label><label>Phone<input name="phone" required inputMode="tel" /></label>
      <label>Email<input name="email" type="email" /></label><label>Company<input name="company" /></label>
      <label>Street<input name="address" required /></label><label>Street number<input name="streetNumber" required /></label>
      <label>Apartment / floor<input name="floor" /></label><label>City<input name="city" required /></label>
      <label>Region<input name="region" required /></label><label>Postal code<input name="zip" required inputMode="numeric" /></label>
      <label>Country<select name="countryCode" defaultValue="GR"><option value="GR">Greece</option><option value="CY">Cyprus</option><option value="BG">Bulgaria</option></select></label>
      <label>Pickup date<input name="pickupDate" type="date" defaultValue={ymd()} required /></label>
      <label>Packages (1–5)<input name="pieces" type="number" min="1" max="5" defaultValue="1" required /></label>
      <label>COD amount (optional)<input name="codAmount" type="number" min="0.01" step="0.01" /></label>
      <label>ACS content type ID (CY/BG)<input name="contentTypeId" type="number" /></label><label>Reference / delivery notes<input name="reference" /></label>
      <div className="form-actions"><button name="op" value="manual" type="submit" disabled={busy}>{busy ? "Creating label…" : "Create ACS shipment"}</button></div>
    </fetcher.Form>
    <style>{`.custom-form{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:14px;margin-top:20px}.custom-form label{display:grid;gap:6px;font-size:13px;font-weight:600;color:#303030}.custom-form input,.custom-form select{font:inherit;font-weight:400;padding:10px;border:1px solid #8c9196;border-radius:7px;background:#fff}.form-actions{grid-column:1/-1;margin-top:5px}`}</style>
  </section><section><h2>Recent manual shipments</h2>{shipments.length ? <div style={{ overflowX: "auto" }}><table style={{ width: "100%", textAlign: "left", borderCollapse: "collapse" }}><thead><tr><th>Created</th><th>Recipient</th><th>Voucher</th><th>Packages</th><th>Pickup date</th><th>Labels</th></tr></thead><tbody>{shipments.map((shipment) => <tr key={shipment.id}><td>{new Date(shipment.createdAt).toLocaleString()}</td><td>{shipment.recipientName}<small style={{ display: "block" }}>{shipment.city}, {shipment.countryCode}</small></td><td><a href={`https://webapp.acscourier.net/track-shipment/${encodeURIComponent(shipment.voucherNo)}`} target="_blank" rel="noreferrer">{shipment.voucherNo}</a></td><td>{shipment.pieces}</td><td>{shipment.pickupDate}</td><td><fetcher.Form method="post" action={action}><input type="hidden" name="id" value={shipment.id}/><button name="op" value="print">Print labels</button></fetcher.Form></td></tr>)}</tbody></table></div> : <p>No custom shipments yet.</p>}</section></>;
}
