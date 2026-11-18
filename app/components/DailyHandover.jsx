import {useState} from "react";
import {useFetcher} from "react-router";
import {PrintDocuments} from "./PrintDocuments";

export function DailyHandover({date,carrier,sandbox,dailyTotals,pickupLists,pickupWarning}){
  const [panel,setPanel]=useState("");
  const fetcher=useFetcher();
  const busy=fetcher.state!=="idle";
  const environment=sandbox?"test":"live";
  const [lastPanel,setLastPanel]=useState("");
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
      {panel==="Geniki" && <fetcher.Form method="post" className="close-day" onSubmit={()=>setLastPanel(panel)}><input type="hidden" name="closeDate" value={date}/><input type="hidden" name="environment" value={environment}/>
        <p>Finalization closes every pending voucher in the Geniki {environment} account for this date, including vouchers created outside Courier Label.</p>
        <label>Type {date} to confirm <input name="confirm" required autoComplete="off"/></label> <button name="intent" value="close" disabled={busy}>Finalize with Geniki</button></fetcher.Form>}
      {lastPanel===panel && fetcher.data && <div role="status">{fetcher.data.messages?.map((m,i)=><p key={i}>{m}</p>)}{fetcher.data.pdf && <PrintDocuments result={fetcher.data}/>}</div>}
    </div>}
  </aside>
}
