import {courierTrackingUrl} from "../services/courier-tracking";

export function TrackingNumber({carrier,number}: {carrier:string; number?:string|null}) {
  if (!number) return <span>—</span>;
  const url=courierTrackingUrl(carrier,number);
  return url ? <a className="tracking-number" href={url} target="_blank" rel="noopener noreferrer" title={`Track this shipment with ${carrier}`}>{number}<span aria-hidden="true" className="external-link-mark">↗</span></a> : <span>{number}</span>;
}
