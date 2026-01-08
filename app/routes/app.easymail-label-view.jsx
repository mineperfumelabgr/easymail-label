import { authenticate } from "../shopify.server";

export const loader = async ({ request }) => {
  // Assicura che la pagina sia accessibile solo con sessione admin valida
  await authenticate.admin(request);
  return null;
};

export default function EasymailLabelView() {
  const params = new URLSearchParams(window.location.search);
  const number = params.get("number");

  if (!number) {
    return (
      <div style={{ padding: 16, fontFamily: "system-ui" }}>
        Missing number
      </div>
    );
  }

  // Questa route deve esistere: api.easymail-label-pdf.js
  const pdfUrl = `/api/easymail-label-pdf?number=${encodeURIComponent(number)}`;

  return (
    <div style={{ height: "100vh", margin: 0 }}>
      <iframe
        title="Easymail Label"
        src={pdfUrl}
        style={{ width: "100%", height: "100%", border: "none" }}
      />
    </div>
  );
}

