import { useEffect, useState } from "react";
import { useFetcher, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

const STATES = [
  ["IN_TRANSIT", "Spedito / in transito"],
  ["OUT_FOR_DELIVERY", "In consegna"],
  ["READY_FOR_PICKUP", "Da ritirare presso ACS"],
  ["DELIVERY_ATTEMPTED", "Tentativo di consegna non riuscito"],
  ["DELIVERY_DELAYED", "Consegna riprogrammata"],
  ["DELIVERY_PROBLEM", "Problema di consegna"],
  ["RETURNING", "In restituzione al mittente"],
  ["RETURNED", "Restituito al mittente"],
  ["DELIVERED", "Consegnato al destinatario"],
  ["UNKNOWN", "Stato ACS da verificare"],
];
const STATE_KEYS = new Set(STATES.map(([key]) => key));

export async function loader({ request }) {
  const { session } = await authenticate.admin(request);
  const saved = await prisma.acsTrackingTagRule.findMany({ where: { shop: session.shop } });
  const savedByState = new Map(saved.map((rule) => [rule.status, rule]));
  return {
    shop: session.shop,
    rules: STATES.map(([status, label]) => {
      const rule = savedByState.get(status);
      return { status, label, enabled: Boolean(rule?.enabled), tag: rule?.tag || "" };
    }),
  };
}

export async function action({ request }) {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  let submitted;
  try {
    submitted = JSON.parse(String(form.get("rules") || "[]"));
  } catch {
    return Response.json({ success: false, message: "Impostazioni non valide." }, { status: 400 });
  }
  if (!Array.isArray(submitted) || submitted.length !== STATES.length) {
    return Response.json({ success: false, message: "Manca uno o più stati ACS." }, { status: 400 });
  }
  const rules = [];
  const seenStates = new Set();
  const seenTags = new Set();
  for (const item of submitted) {
    const status = String(item?.status || "");
    if (!STATE_KEYS.has(status) || seenStates.has(status)) {
      return Response.json({ success: false, message: "Stato ACS non valido o ripetuto." }, { status: 400 });
    }
    seenStates.add(status);
    const enabled = item.enabled === true;
    const tag = String(item.tag || "").trim();
    if (enabled && (!tag || tag.length > 80 || /[,\r\n]/.test(tag))) {
      return Response.json({ success: false, message: "Ogni regola attiva richiede un tag Shopify valido (massimo 80 caratteri)." }, { status: 400 });
    }
    if (enabled) {
      const normalizedTag = tag.toLocaleLowerCase();
      if (seenTags.has(normalizedTag)) {
        return Response.json({ success: false, message: "Usa un tag diverso per ogni stato attivo: Shopify Flow deve poter distinguere le transizioni." }, { status: 400 });
      }
      seenTags.add(normalizedTag);
    }
    rules.push({ status, enabled, tag: tag || null });
  }

  await prisma.$transaction(rules.map((rule) => prisma.acsTrackingTagRule.upsert({
    where: { shop_status: { shop: session.shop, status: rule.status } },
    create: { shop: session.shop, ...rule },
    update: { enabled: rule.enabled, tag: rule.tag },
  })));
  return Response.json({ success: true, message: "Configurazione dei tag salvata." });
}

export default function AcsTrackingSettings() {
  const { rules: initialRules, shop } = useLoaderData();
  const fetcher = useFetcher();
  const [rules, setRules] = useState(initialRules);
  const busy = fetcher.state !== "idle";
  useEffect(() => setRules(initialRules), [initialRules]);

  function update(index, patch) {
    setRules((current) => current.map((rule, i) => i === index ? { ...rule, ...patch } : rule));
  }

  return (
    <s-page heading="Tag ACS per Shopify Flow">
      <s-section>
        <p>Seleziona gli stati ACS per cui aggiungere un tag all’ordine del negozio <strong>{shop}</strong>. Al prossimo aggiornamento tracking, l’app aggiunge il tag configurato.</p>
        <p>Usa un tag univoco per ogni stato attivo, ad esempio <code>ACS_DELIVERED</code>, <code>ACS_RETURNING</code> e <code>ACS_RETURNED</code>. In Shopify Flow scegli il trigger <strong>Order tags added</strong> e crea un flusso per ciascun tag. I tag non vengono rimossi automaticamente quando lo stato cambia.</p>
        <p><strong>Ordini con più pacchi ACS:</strong> i tag di problemi o restituzione vengono applicati se lo stato riguarda almeno un pacco. Il tag di consegna viene applicato solo quando tutti i pacchi ACS attivi dell’ordine risultano consegnati.</p>
        <fetcher.Form method="post" onSubmit={(event) => {
          event.preventDefault();
          fetcher.submit({ rules: JSON.stringify(rules) }, { method: "post" });
        }}>
          <input type="hidden" name="rules" value={JSON.stringify(rules)} readOnly />
          <div className="tag-rules">
            {rules.map((rule, index) => (
              <div className="tag-rule" key={rule.status}>
                <label className="tag-toggle"><input type="checkbox" checked={rule.enabled} onChange={(event) => update(index, { enabled: event.target.checked, ...(event.target.checked && !rule.tag ? { tag: `ACS_${rule.status}` } : {}) })} /><span>{rule.label}</span></label>
                <label className="tag-field"><span>Tag Shopify</span><input value={rule.tag} maxLength={80} placeholder={`ACS_${rule.status}`} disabled={!rule.enabled} onChange={(event) => update(index, { tag: event.target.value })} /></label>
              </div>
            ))}
          </div>
          {fetcher.data?.message ? <p role={fetcher.data.success ? "status" : "alert"}>{fetcher.data.message}</p> : null}
          <button type="submit" disabled={busy}>{busy ? "Salvataggio…" : "Salva configurazione"}</button>
        </fetcher.Form>
      </s-section>
      <style>{`
        .tag-rules{display:grid;gap:9px;margin:18px 0}.tag-rule{display:grid;grid-template-columns:minmax(220px,1fr) minmax(220px,1fr);align-items:center;gap:18px;border:1px solid #e5e1dc;border-radius:9px;padding:12px;background:#fff}.tag-toggle{display:flex;gap:10px;align-items:center}.tag-field{display:grid;gap:5px;color:#605b56;font-size:12px}.tag-field input{padding:9px 10px;border:1px solid #c8c5c1;border-radius:7px;font:inherit;color:#282522}.tag-field input:disabled{background:#f4f2f0;color:#8a8783}.tag-rules+ p{color:#315f35}button[type=submit]{background:#59412f;color:#fff;border:0;border-radius:7px;padding:10px 16px;font:inherit;cursor:pointer}button[type=submit]:disabled{opacity:.6}@media(max-width:650px){.tag-rule{grid-template-columns:1fr;gap:12px}}
      `}</style>
    </s-page>
  );
}
