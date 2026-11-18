import {useEffect,useRef,useState} from "react";

export function PrintDocuments({result}){
  const frame=useRef(null);
  const [documents,setDocuments]=useState([]);
  const [active,setActive]=useState(null);
  useEffect(()=>{
    const docs=[];
    for(const [name,data] of [["Packing slips",result.packing],[result.documentName || "Voucher labels",result.pdf]]){
      if(!data)continue;
      const bytes=Uint8Array.from(atob(data),c=>c.charCodeAt(0));
      docs.push({name,url:URL.createObjectURL(new Blob([bytes],{type:"application/pdf"}))});
    }
    setDocuments(docs);setActive(docs[0]||null);
    return ()=>docs.forEach(d=>URL.revokeObjectURL(d.url));
  },[result]);
  useEffect(()=>{
    const win=frame.current?.contentWindow;
    if(!win || active!==documents[0] || !documents[1])return;
    const advance=()=>setActive(documents[1]);win.addEventListener("afterprint",advance,{once:true});return ()=>win.removeEventListener("afterprint",advance);
  },[active,documents]);
  function print(){
    try{const win=frame.current.contentWindow;win.focus();win.print()}catch{/* The inline viewer remains available below. */}
  }
  if(!documents.length)return null;
  return <section aria-label="Print documents">{documents.map(doc=><span key={doc.url}>
    <button type="button" onClick={()=>active===doc?print():setActive(doc)}>Print {doc.name}</button>
    <a href={doc.url} target="_blank" rel="noreferrer">Open {doc.name} PDF</a>{" "}
  </span>)}{active && <iframe key={active.url} ref={frame} title={active.name} src={active.url} onLoad={print} style={{width:"100%",height:"55vh",border:0}}/>}</section>
}
