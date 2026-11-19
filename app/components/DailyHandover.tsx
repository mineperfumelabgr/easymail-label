import {useState} from "react";
import {useFetcher} from "react-router";
import {PrintDocuments} from "./PrintDocuments";

type HandoverRecord={date:string;environment:string;finalizedAt:string|Date;confirmations:number};
type HandoverProps={date:string;carrier:string;sandbox:boolean;dailyTotals:Record<string,number>;pickupLists:{pickupListNo:string;listVouchersCount:number}[];pickupWarning:string;genikiHandovers?:HandoverRecord[]};
export function DailyHandover({date,carrier,sandbox,dailyTotals,pickupLists,pickupWarning,genikiHandovers=[]}:HandoverProps){
  const [panel,setPanel]=useState(carrier||"");
  const [closeDate,setCloseDate]=useState(date);
  const today=new Intl.DateTimeFormat("en-CA",{timeZone:"Europe/Athens",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
  const fetcher=useFetcher<{genikiHandover?:HandoverRecord;messages?:string[];pdf?:string;documentName?:string}>();
  const busy=fetcher.state!=="idle";
  const environment=sandbox?"test":"live";
  const [lastPanel,setLastPanel]=useState("");
  const latest=fetcher.data?.genikiHandover;
  const confirmed=latest?.date===closeDate&&latest.environment===environment?latest:genikiHandovers.find(h=>h.date===closeDate&&h.environment===environment);
  const confirmedTime=confirmed?new Intl.DateTimeFormat("en-GB",{timeZone:"Europe/Athens",dateStyle:"medium",timeStyle:"short"}).format(new Date(confirmed.finalizedAt)):null;
  return <aside className="handover" aria-label="Daily handover">
    <div className="handover-head"><h3>Daily handover</h3><div className="handover-actions">
    {["ACS","Geniki"].filter(c=>!carrier||c===carrier).map(c=><button key={c} type="button" aria-expanded={panel===c} aria-controls="daily-handover-panel" onClick={()=>setPanel(panel===c?"":c)}>{c==="ACS"?"ACS pickup lists":"Geniki handover"} <strong>{dailyTotals?.[c]||0}</strong></button>)}</div></div>
    {panel && <div id="daily-handover-panel" className="handover-body">
      <h3>{panel==="ACS"?"ACS pickup lists":"Geniki handover"} · {date}</h3>
      <p>{dailyTotals?.[panel]||0} active shipments in Courier Label · all destinations</p>
      <fetcher.Form method="post" onSubmit={()=>setLastPanel(panel)}><input type="hidden" name="dailyDate" value={date}/>
      {panel==="ACS"?<>
        <button name="intent" value="acsPickup" disabled={busy||sandbox} onClick={e=>{if(!window.confirm("Issue the ACS pickup list for "+date+"?"))e.preventDefault()}}>Generate ACS pickup list</button>
        {sandbox && <p>Official pickup lists are available in the live ACS account.</p>}
      </>:<button name="intent" value="manifest" disabled={busy||!dailyTotals.Geniki}>Generate and print handover list</button>}
      </fetcher.Form>
      {panel==="ACS" && <>{pickupWarning && <p role="alert">{pickupWarning}</p>}{pickupLists.map(l=><fetcher.Form key={l.pickupListNo} method="post" onSubmit={()=>setLastPanel(panel)}><input type="hidden" name="dailyDate" value={date}/><input type="hidden" name="number" value={l.pickupListNo}/><button name="intent" value="printPickup" disabled={busy}>Print list {l.pickupListNo}</button> · {l.listVouchersCount} vouchers</fetcher.Form>)}</>}
      {panel==="Geniki" && <fetcher.Form method="post" className="close-day" onSubmit={()=>setLastPanel(panel)}><label>Handover date <input type="date" name="closeDate" value={closeDate} max={today} required onChange={event=>setCloseDate(event.target.value)}/></label><input type="hidden" name="environment" value={environment}/>
        <p>Finalization closes every pending voucher in the Geniki {environment} account for {closeDate}, including vouchers created outside Courier Label.</p>
        <button name="intent" value="close" disabled={busy}>{busy?"Finalizing…":confirmed?"Finalize again with Geniki":"Finalize day with Geniki"}</button>
        {confirmed&&<div className="handover-confirmation" role="status"><strong>Already finalized for {closeDate}</strong><span>Last confirmed: {confirmedTime} · Athens time.</span><span>Run again only if more vouchers were added. Geniki may confirm a repeated request even when there is nothing left to close.</span></div>}</fetcher.Form>}
      {lastPanel===panel && fetcher.data && <div role="status">{fetcher.data.messages?.map((m,i)=><p key={i}>{m}</p>)}{fetcher.data.pdf && <PrintDocuments result={fetcher.data}/>}</div>}
    </div>}
  </aside>
}
