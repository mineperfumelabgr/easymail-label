import {Link} from 'react-router';
export type VoucherRow={id:string;carrier:string;voucher?:string|null;status?:string;orderId?:string;sourceOrderId?:string|null;orderName?:string;returnSerial?:string|null};
export function canCreateGenikiReturn(row?:VoucherRow|null){
  return row?.carrier==='Geniki'&&Boolean(row.voucher)&&Boolean(row.id)&&!['Cancelled','Superseded'].includes(row.status||'')&&/^gid:\/\/shopify\/Order\/\d+$/.test(row.sourceOrderId||row.orderId||'');
}
export function CustomerReturnLink({row,params}:{row?:VoucherRow|null;params:URLSearchParams}){
  if(!row||!canCreateGenikiReturn(row))return null;
  const p=new URLSearchParams([...params].filter(([key])=>['shop','host','embedded'].includes(key)));
  p.set('shipment',row.id);p.set('section','return');
  return <Link className="voucher-action return-voucher-button" to={'/app/geniki-operations?'+p+'#customer-return'}>{row.returnSerial?'Print customer return':'Create customer return'}</Link>;
}
export function DailyVoucherActions({row,params,sandbox}:{row:VoucherRow;params:URLSearchParams;sandbox:boolean}){
  if(!row.voucher||['Cancelled','Superseded'].includes(row.status||''))return null;
  const p=new URLSearchParams([...params].filter(([key])=>['shop','host','embedded'].includes(key)));
  p.set('mode','replace');
  if(row.id.startsWith('legacy:')){p.set('order',row.orderId||'');p.set('voucher',row.voucher);p.set('carrier',row.carrier);}else p.set('shipment',row.id);
  const replace=/^gid:\/\/shopify\/Order\/\d+$/.test(row.sourceOrderId||row.orderId||'');
  return <div className="daily-voucher-actions" aria-label={'Actions for voucher '+row.voucher}>
    {replace&&<Link className="voucher-action replace-voucher-button" to={'/app/shipment-operation?'+p}>Replace voucher</Link>}
    <button className="voucher-action cancel-voucher-button" type="submit" name="intent" value={'cancel-row:'+row.id} disabled={sandbox&&row.carrier==='ACS'} onClick={e=>{if(!window.confirm('Cancel '+row.carrier+' voucher '+row.voucher+' for '+row.orderName+'? Review its Shopify fulfillment separately.'))e.preventDefault();}}>Cancel voucher</button>
  </div>;
}
