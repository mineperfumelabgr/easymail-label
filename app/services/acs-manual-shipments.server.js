import {isCourierTestShop} from "./geniki.server";
import {authenticate} from "../shopify.server";
import prisma from "../db.server";
import {printAcsVoucher,extractPdfBytesFromAcsResponse,createAcsVoucher,extractAcsMultipartNumbers,extractAcsVoucherNo,getAcsMultipartVouchers,makeAcsLabelUrl} from "./acs.server";
const ymd=()=>new Intl.DateTimeFormat("en-CA",{timeZone:"Europe/Athens",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
const str=value=>String(value??"").trim();
export async function loadAcsManualShipments({ request }) {
  const { session } = await authenticate.admin(request);
  const shipments = await prisma.acsManualShipment.findMany({ where: { shop: session.shop }, orderBy: { createdAt: "desc" }, take: 50 });
  return { shipments: shipments.map((item) => ({ ...item, shipmentNumbers: JSON.parse(item.shipmentNumbers) })) };
}

export async function handleAcsManualShipment({ request }) {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  if(isCourierTestShop(session.shop))return Response.json({success:false,message:"ACS uses the live account. Manual ACS actions are disabled in the test store."});
  if(form.get("op")==="print"){
    try {
      const shipment=await prisma.acsManualShipment.findFirstOrThrow({where:{shop:session.shop,id:str(form.get("id"))}});
      const bytes=extractPdfBytesFromAcsResponse(await printAcsVoucher(shipment.voucherNo,{printType:1,startPosition:1}));
      if(!bytes?.length)throw new Error("No printable label returned.");
      return {pdf:Buffer.from(bytes).toString("base64"),documentName:"ACS voucher labels"};
    } catch(error){return {success:false,message:error.message}}
  }
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

