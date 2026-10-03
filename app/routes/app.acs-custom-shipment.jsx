import { useFetcher, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { createAcsVoucher, extractAcsMultipartNumbers, extractAcsVoucherNo, getAcsMultipartVouchers, makeAcsLabelUrl } from "../services/acs.server";

const ymd = () => new Date().toISOString().slice(0, 10);
const str = (value) => String(value ?? "").trim();

export async function loader({ request }) {
  const { session } = await authenticate.admin(request);
  const shipments = await prisma.acsManualShipment.findMany({ where: { shop: session.shop }, orderBy: { createdAt: "desc" }, take: 50 });
  return { shipments: shipments.map((item) => ({ ...item, shipmentNumbers: JSON.parse(item.shipmentNumbers) })) };
}

export async function action({ request }) {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const recipientName = str(form.get("recipientName"));
  const phone = str(form.get("phone"));
  const address = str(form.get("address"));
  const streetNumber = str(form.get("streetNumber"));
  const city = str(form.get("city"));
  const region = str(form.get("region")) || city;
  const zip = str(form.get("zip"));
  const countryCode = str(form.get("countryCode"));
  const pickupDate = str(form.get("pickupDate")) || ymd();
  const pieces = Number(form.get("pieces"));
  const codAmount = str(form.get("codAmount")) ? Number(String(form.get("codAmount")).replace(",", ".")) : null;
  const reference = str(form.get("reference"));
  const errors = [];
  if (!recipientName || phone.replace(/\D/g, "").length < 7 || !address || !streetNumber || !city || !region || !/^\d+$/.test(zip) || !["GR", "CY", "BG"].includes(countryCode)) errors.push("Enter recipient, a valid phone number, full address, numeric postal code and a supported country (GR, CY or BG).");
  if (!Number.isInteger(pieces) || pieces < 1 || pieces > 5) errors.push("Packages must be between 1 and 5.");
  if (codAmount !== null && (!Number.isFinite(codAmount) || codAmount <= 0)) errors.push("COD amount must be a positive number.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(pickupDate)) errors.push("Choose a valid pickup date.");
  if (errors.length) return Response.json({ success: false, errors }, { status: 400 });
  try {
    const phoneNumber = Number(phone.replace(/\D/g, ""));
    const contentTypeId = str(form.get("contentTypeId")) ? Number(form.get("contentTypeId")) : null;
    const payload = {
      Pickup_Date: pickupDate,
      Sender: process.env.ACS_SENDER_NAME || "MINE PERFUME LAB GR",
      Recipient_Name: recipientName,
      Recipient_Address: address,
      Recipient_Address_Number: countryCode === "BG" ? `${streetNumber} (${zip})` : Number(streetNumber),
      Recipient_Zipcode: countryCode === "BG" ? 10001 : Number(zip), Recipient_Region: region,
      Recipient_Phone: phoneNumber, Recipient_Cell_Phone: phoneNumber,
      Recipient_Floor: str(form.get("floor")) || null,
      Recipient_Company_Name: str(form.get("company")) || null,
      Recipient_Country: countryCode,
      Acs_Station_Destination: null, Acs_Station_Branch_Destination: null,
      Billing_Code: process.env.ACS_BILLING_CODE, Charge_Type: 2,
      Cost_Center_Code: null, Item_Quantity: pieces, Weight: 0.5,
      Dimension_X_In_Cm: null, Dimension_Y_in_Cm: null, Dimension_Z_in_Cm: null,
      Cod_Ammount: codAmount, Cod_Payment_Way: codAmount ? 0 : null,
      Acs_Delivery_Products: codAmount ? "COD" : null,
      Insurance_Ammount: null, Delivery_Notes: reference || "Custom ACS shipment",
      Appointment_Until_Time: null, Recipient_Email: str(form.get("email")) || null,
      Reference_Key1: reference || null, Reference_Key2: reference || null,
      With_Return_Voucher: null, Content_Type_ID: ["CY", "BG"].includes(countryCode) ? contentTypeId : null, Language: "GR",
    };
    const created = await createAcsVoucher(payload);
    const voucherNo = extractAcsVoucherNo(created);
    if (!voucherNo) throw new Error(`ACS did not return a voucher number. ${JSON.stringify(created).slice(0, 400)}`);
    let children = [];
    if (pieces > 1) children = extractAcsMultipartNumbers(await getAcsMultipartVouchers(voucherNo));
    const numbers = [...new Set([String(voucherNo), ...children.map(String)])];
    const saved = await prisma.acsManualShipment.create({ data: {
      shop: session.shop, recipientName, phone, email: str(form.get("email")) || null,
      company: str(form.get("company")) || null, address, floor: str(form.get("floor")) || null,
      city, region, zip, countryCode, pieces, codAmount, pickupDate, reference: reference || null,
      voucherNo: String(voucherNo), shipmentNumbers: JSON.stringify(numbers),
    } });
    return Response.json({ success: true, shipment: { ...saved, shipmentNumbers: numbers, labels: numbers.map((number) => makeAcsLabelUrl(number)) } });
  } catch (error) {
    console.error("ACS MANUAL LABEL ERROR", error);
    return Response.json({ success: false, errors: [error?.message || "Could not create ACS label."] }, { status: 502 });
  }
}

export default function CustomAcsShipmentPage() {
  const { shipments } = useLoaderData();
  const fetcher = useFetcher();
  const busy = fetcher.state !== "idle";
  const result = fetcher.data;
  return <s-page heading="Custom ACS Shipment"><s-section>
    <p>Create an ACS shipment directly, without a Shopify order. These labels are stored here and do not change Shopify order status or tags.</p>
    {result?.success ? <s-banner tone="success">Voucher {result.shipment.voucherNo} created. <a href={`/api/acs-label-pdf?number=${encodeURIComponent(result.shipment.voucherNo)}`} target="_blank" rel="noreferrer">Print label</a></s-banner> : null}
    {result?.errors?.length ? <s-banner tone="critical">{result.errors.join(" ")}</s-banner> : null}
    <fetcher.Form method="post" className="custom-form">
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
      <div className="form-actions"><s-button variant="primary" type="submit" disabled={busy}>{busy ? "Creating label…" : "Create ACS shipment"}</s-button></div>
    </fetcher.Form>
    <style>{`.custom-form{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:14px;margin-top:20px}.custom-form label{display:grid;gap:6px;font-size:13px;font-weight:600;color:#303030}.custom-form input,.custom-form select{font:inherit;font-weight:400;padding:10px;border:1px solid #8c9196;border-radius:7px;background:#fff}.form-actions{grid-column:1/-1;margin-top:5px}`}</style>
  </s-section><s-section heading="Recent custom shipments">{shipments.length ? <div style={{ overflowX: "auto" }}><table style={{ width: "100%", textAlign: "left", borderCollapse: "collapse" }}><thead><tr><th>Created</th><th>Recipient</th><th>Voucher</th><th>Packages</th><th>Pickup date</th><th>Labels</th></tr></thead><tbody>{shipments.map((shipment) => <tr key={shipment.id}><td>{new Date(shipment.createdAt).toLocaleString()}</td><td>{shipment.recipientName}<small style={{ display: "block" }}>{shipment.city}, {shipment.countryCode}</small></td><td><a href={`https://webapp.acscourier.net/track-shipment/${encodeURIComponent(shipment.voucherNo)}`} target="_blank" rel="noreferrer">{shipment.voucherNo}</a></td><td>{shipment.pieces}</td><td>{shipment.pickupDate}</td><td>{shipment.shipmentNumbers.map((number) => <a key={number} style={{ marginRight: 8 }} href={`/api/acs-label-pdf?number=${encodeURIComponent(number)}`} target="_blank" rel="noreferrer">Print {number}</a>)}</td></tr>)}</tbody></table></div> : <p>No custom shipments yet.</p>}</s-section></s-page>;
}
