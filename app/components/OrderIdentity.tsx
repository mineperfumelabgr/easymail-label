import {shopifyAdminLink} from "../services/order-display";

type IdentityRow = {
  id?: string;
  orderId?: string | null;
  sourceOrderId?: string | null;
  name?: string;
  orderName?: string | null;
  customerId?: string | null;
  customerName?: string | null;
  customerEmail?: string | null;
  email?: string | null;
  recipientName?: string | null;
  recipientPhone?: string | null;
  customer?: {id?: string; displayName?: string | null} | null;
  shippingAddress?: {name?: string | null; phone?: string | null} | null;
};

export function OrderIdentity({row,shop}: {row:IdentityRow; shop:string}) {
  const orderId=row.sourceOrderId || row.orderId || row.id;
  const orderUrl=shopifyAdminLink(shop,"orders",orderId);
  const customerUrl=shopifyAdminLink(shop,"customers",row.customerId || row.customer?.id);
  const recipient=row.shippingAddress?.name || row.recipientName;
  const customer=row.customerName || row.customer?.displayName || recipient;
  const email=row.customerEmail || row.email;
  const phone=row.shippingAddress?.phone || row.recipientPhone;
  const profile=(text:string,className:string)=>customerUrl
    ? <a className={className} href={customerUrl} target="_blank" rel="noopener noreferrer" title="Open Shopify customer profile">{text}</a>
    : <span className={className}>{text}</span>;
  return <div>
    <div className="order-identity">
      <strong>{orderUrl ? <a href={orderUrl} target="_blank" rel="noopener noreferrer" title="Open Shopify order">{row.name || row.orderName}</a> : row.name || row.orderName}</strong>
      {customer && profile(customer,"customer-name")}
    </div>
    {recipient && customer!==recipient && <small className="ship-to">Ship to: {recipient}</small>}
    {email && <div className="order-email">{profile(email,"customer-email")}</div>}
    {phone && <a className="order-phone" href={"tel:"+phone.replace(/[^+0-9]/g,"")}>{phone}</a>}
  </div>;
}
