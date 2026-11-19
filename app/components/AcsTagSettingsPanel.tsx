import {useEffect,useState} from "react";
import {useFetcher} from "react-router";
type TagRule={status:string;label:string;enabled:boolean;tag:string};
export function AcsTagSettingsPanel({initialRules,shop,action}:{initialRules:TagRule[];shop:string;action?:string}) {
  const fetcher = useFetcher<{success?:boolean;message?:string}>();
  const [rules, setRules] = useState(initialRules);
  const busy = fetcher.state !== "idle";
  useEffect(() => setRules(initialRules), [initialRules]);

  function update(index:number, patch:Partial<TagRule>) {
    setRules((current) => current.map((rule, i) => i === index ? { ...rule, ...patch } : rule));
  }

  return (
    <section className="acs-tag-settings"><h2>Order tag settings</h2>
        <p>Choose which ACS shipment statuses add tags to Shopify orders in <strong>{shop}</strong>. Tags are applied by the next tracking synchronization.</p>
        <p>Use a unique tag for each active status, such as <code>ACS_DELIVERED</code>, <code>ACS_RETURNING</code> or <code>ACS_RETURNED</code>. Shopify Flow can use <strong>Order tags added</strong> to react to these changes. Tags are not removed automatically.</p>
        <p>For multi-parcel orders, a problem or return tag applies when any active parcel reaches that state. Delivery tags apply once all active ACS parcels are delivered. Return-to-sender tag rules also apply to Geniki shipments within Greece.</p>
        <fetcher.Form method="post" action={action} onSubmit={(event) => {
          event.preventDefault();
          fetcher.submit({ rules: JSON.stringify(rules) }, { method: "post", action });
        }}>
          <input type="hidden" name="rules" value={JSON.stringify(rules)} readOnly />
          <div className="tag-rules">
            {rules.map((rule, index) => (
              <div className="tag-rule" key={rule.status}>
                <label className="tag-toggle"><input type="checkbox" checked={rule.enabled} onChange={(event) => update(index, { enabled: event.target.checked, ...(event.target.checked && !rule.tag ? { tag: `ACS_${rule.status}` } : {}) })} /><span>{rule.label}</span></label>
                <label className="tag-field"><span>Shopify tag</span><input value={rule.tag} maxLength={80} placeholder={`ACS_${rule.status}`} disabled={!rule.enabled} onChange={(event) => update(index, { tag: event.target.value })} /></label>
              </div>
            ))}
          </div>
          {fetcher.data?.message ? <p role={fetcher.data.success ? "status" : "alert"}>{fetcher.data.message}</p> : null}
          <button type="submit" disabled={busy}>{busy ? "Saving…" : "Save tag settings"}</button>
        </fetcher.Form>
      
      <style>{`
        .tag-rules{display:grid;gap:9px;margin:18px 0}.tag-rule{display:grid;grid-template-columns:minmax(220px,1fr) minmax(220px,1fr);align-items:center;gap:18px;border:1px solid #e5e1dc;border-radius:9px;padding:12px;background:#fff}.tag-toggle{display:flex;gap:10px;align-items:center}.tag-field{display:grid;gap:5px;color:#605b56;font-size:12px}.tag-field input{padding:9px 10px;border:1px solid #c8c5c1;border-radius:7px;font:inherit;color:#282522}.tag-field input:disabled{background:#f4f2f0;color:#8a8783}.tag-rules+ p{color:#315f35}.acs-tag-settings button[type=submit]{background:#59412f;color:#fff;border:0;border-radius:7px;padding:10px 16px;font:inherit;cursor:pointer}.acs-tag-settings button[type=submit]:disabled{opacity:.6}@media(max-width:650px){.tag-rule{grid-template-columns:1fr;gap:12px}}
      `}</style>
    </section>
  );
}
