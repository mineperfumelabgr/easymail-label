import { render } from "preact";
import { useMemo, useState } from "preact/hooks";

export default async () => {
  render(<Extension />, document.body);
};

function todayLocalYMD() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function Extension() {
  const { data } = shopify;
  const selectedIds = Array.isArray(data?.selected) ? data.selected.map((x) => x.id).filter(Boolean) : [];
  const [pickupDate, setPickupDate] = useState(todayLocalYMD());

  const pdfHref = useMemo(() => {
    const ids = encodeURIComponent(JSON.stringify(selectedIds));
    const date = encodeURIComponent(pickupDate);
    return `/api/acs-batch-merge-pdf?orderIds=${ids}&pickupDate=${date}`;
  }, [selectedIds, pickupDate]);

  return (
    <s-admin-print-action heading="Print ACS Labels">
      <s-box paddingBlockStart="small">
        <s-banner tone="info">
          <s-text>Selected orders: {selectedIds.length}</s-text>

          <s-box paddingBlockStart="small">
            <s-text>Pickup date (YYYY-MM-DD):</s-text>
          </s-box>

          <s-box paddingBlockStart="small">
            <s-text-field
              value={pickupDate}
              onInput={(e) => setPickupDate(e.target.value)}
              placeholder="YYYY-MM-DD"
            />
          </s-box>

          <s-box paddingBlockStart="xsmall">
            <s-text tone="subdued">
              The batch uses ACS logic already in production, with pieces = 1 and thermal labels.
            </s-text>
          </s-box>
        </s-banner>
      </s-box>

      <s-box paddingBlockStart="large">
        <s-button href={pdfHref} target="_blank" rel="noopener" disabled={!selectedIds.length}>
          Generate and print ACS labels
        </s-button>
      </s-box>
    </s-admin-print-action>
  );
}
