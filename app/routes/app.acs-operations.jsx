import {Link,useSearchParams} from "react-router";
import "../styles/courier.css";
export default function AcsOperations(){
  const [params]=useSearchParams();
  function target(path,view){
    const p=new URLSearchParams(params);
    for(const key of ["view","country","carrier","after","shipment"])p.delete(key);
    if(view){p.set("view",view);p.set("carrier","ACS")}
    return path+"?"+p;
  }
  return <main className="courier operations"><header><h1>ACS Operations</h1></header>
    <section className="operation-grid">{[
      ["Manual shipment","Create an ACS shipment without a Shopify order.","/app/acs-custom-shipment"],
      ["Pickup lists and labels","Review daily shipments, issue a pickup list or print labels.","/app","daily"],
      ["Shipment tracking","Review delivery progress and refresh selected shipments.","/app","tracking"],
      ["Order tag settings","Manage the Shopify order tags applied to ACS shipment statuses.","/app/acs-tracking-settings"]
    ].map(([name,description,path,view])=><Link key={name} to={target(path,view)}><strong>{name}</strong><span>{description}</span></Link>)}</section></main>
}
