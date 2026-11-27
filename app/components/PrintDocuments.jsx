import {useEffect,useRef,useState} from "react";

export function PrintDocuments({result}){
  const frame=useRef(null);
  const panel=useRef(null);
  const printCleanup=useRef(()=>{});
  const autoPrinted=useRef(null);
  const [documents,setDocuments]=useState([]);
  const [active,setActive]=useState(null);

  useEffect(()=>{
    const docs=[];
    for(const [name,data] of [["Packing slips",result.packing],[result.documentName || "Voucher labels",result.pdf]]){
      if(!data)continue;
      const bytes=Uint8Array.from(atob(data),c=>c.charCodeAt(0));
      docs.push({name,url:URL.createObjectURL(new Blob([bytes],{type:"application/pdf"}))});
    }
    setDocuments(docs);
    setActive(docs[0]||null);
    autoPrinted.current=null;
    return ()=>{
      printCleanup.current();
      docs.forEach(doc=>URL.revokeObjectURL(doc.url));
    };
  },[result]);

  useEffect(()=>{
    panel.current?.scrollIntoView({block:"start",behavior:"smooth"});
  },[active]);

  function print(){
    printCleanup.current();
    const win=frame.current?.contentWindow;
    if(!win || !active)return;
    const next=documents[documents.indexOf(active)+1];
    let finished=false;
    let lostFocus=false;
    let enteredPrint=false;
    let advanceTimer;
    const media=win.matchMedia("print");
    function cleanup(){
      win.removeEventListener("afterprint",finish);
      window.removeEventListener("afterprint",finish);
      window.removeEventListener("blur",blur);
      window.removeEventListener("focus",focus);
      media.removeEventListener("change",mediaChange);
      clearTimeout(advanceTimer);
    }
    function finish(){
      if(finished)return;
      finished=true;
      cleanup();
      // Wait until the first native dialog has closed before opening the next.
      if(next)advanceTimer=setTimeout(()=>setActive(next),150);
    }
    function blur(){lostFocus=true}
    function focus(){if(lostFocus)finish()}
    function mediaChange(event){
      if(event.matches)enteredPrint=true;
      else if(enteredPrint)finish();
    }
    // Install listeners after the PDF iframe has loaded. Navigation replaces its document.
    win.addEventListener("afterprint",finish);
    window.addEventListener("afterprint",finish);
    media.addEventListener("change",mediaChange);
    printCleanup.current=cleanup;
    try{
      win.focus();
      window.addEventListener("blur",blur);
      window.addEventListener("focus",focus);
      win.print();
    }catch{
      cleanup();
    }
  }

  function loaded(){
    if(autoPrinted.current===active?.url)return;
    autoPrinted.current=active?.url;
    print();
  }

  if(!documents.length)return null;
  return <section ref={panel} className="print-documents" aria-label="Print documents">
    <h3>{active?.name} · Print preview</h3>
    {result.packingWarnings?.length > 0 && <ul role="status">
      {result.packingWarnings.map(warning => <li key={warning}>{warning}</li>)}
    </ul>}
    <div className="controls">{documents.map(doc=><span key={doc.url}>
      <button type="button" onClick={()=>active===doc?print():setActive(doc)}>Print {doc.name}</button>
      <a href={doc.url} target="_blank" rel="noreferrer">Open {doc.name} PDF</a>{" "}
    </span>)}</div>
    {active && <iframe key={active.url} ref={frame} title={active.name} src={active.url} onLoad={loaded} style={{width:"100%",height:"55vh",border:0}}/>}
  </section>;
}
