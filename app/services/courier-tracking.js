export function courierTrackingUrl(carrier, number) {
  const value=String(number || "").trim();
  if (!value) return null;
  const base={ACS:"https://webapp.acscourier.net/track-shipment/",Geniki:"https://www.taxydromiki.com/en/track/"}[carrier];
  return base ? base+encodeURIComponent(value) : null;
}
