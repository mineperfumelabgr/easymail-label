import { authenticate } from "../shopify.server";

export const loader = async ({ request }) => {
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

