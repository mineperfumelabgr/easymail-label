import {adminGraphql} from "./acs-create-label.server";
import {deleteAcsVoucher} from "./acs.server";
const NS = "acs";

const KEYS_TO_DELETE = [
  "voucher_number",
  "label_url",
  "created_at",
  "pieces",
  "voucher_history",
  "current_numbers",
  "content_type_id",
  "pickup_date",
];

async function deleteMetafields(admin, orderId) {
  const m = `#graphql
    mutation DeleteMetafields($metafields: [MetafieldIdentifierInput!]!) {
      metafieldsDelete(metafields: $metafields) {
        deletedMetafields {
          key
          namespace
          ownerId
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const variables = {
    metafields: KEYS_TO_DELETE.map((key) => ({
      ownerId: orderId,
      namespace: NS,
      key,
    })),
  };

  const j = await adminGraphql(admin, m, variables);
  return j?.data?.metafieldsDelete?.userErrors || [];
}

function extractDeleteBusinessMessage(data) {
  const env = data?.ACSOutputResponce || data?.ACSOutputResponse || {};
  const rows = Array.isArray(env?.ACSValueOutput) ? env.ACSValueOutput : [];
  const first = rows[0] || {};

  const msg =
    first?.Error_Message ??
    first?.error_message ??
    first?.ErrorMessage ??
    first?.message ??
    "";

  return String(msg || "").trim();
}

export async function cancelAcsLabel(admin, number, orderId) {
 const response=await deleteAcsVoucher(number);
 const message=extractDeleteBusinessMessage(response);
 if(message) throw new Error(message);
 if(orderId){
 const {data}=await adminGraphql(admin,'query($id:ID!){order(id:$id){metafield(namespace:"acs",key:"voucher_number"){value}}}',{id:orderId});
 if(data.order?.metafield?.value===number){
 const errors=await deleteMetafields(admin,orderId);
 if(errors.length)return "ACS cancelled the voucher. Shopify: "+errors.map(e=>e.message).join(", ");
 }}
 return "Voucher cancelled";
}