import {trackingStatusChips,trackingStatusFilters} from "../services/shipment-status";

export function TrackingStatusChips({selected="",disabled=false}: {selected?:string;disabled?:boolean}) {
  const legacyLabel=(trackingStatusFilters as Record<string,string>)[selected];
  const legacyFilter=legacyLabel && !trackingStatusChips.some(([key])=>key===selected);
  return <><div className="status-filters" role="group" aria-label="Filter shipments by status" aria-busy={disabled}>
    {trackingStatusChips.map(([key,label,tone])=><button key={key} type="submit" form="courier-tracking-filters" name="status" value={key} className="shipment-state" data-tone={tone} aria-pressed={selected===key} disabled={disabled}>{label}</button>)}
  </div>{legacyFilter && <p className="result-count">Active filter: {legacyLabel}</p>}</>;
}
