import { unauthenticated } from "../shopify.server";

const SHOP = "7gidg0-ut.myshopify.com";
const SEGMENT = "gid://shopify/Segment/1191500185948";
const BASELINE = 212;
const CAPACITY = 20;
const END = Date.parse("2026-11-27T00:00:00+02:00");
const ORIGINS = new Set(["https://mineperfumelab.gr", "https://www.mineperfumelab.gr", "https://7gidg0-ut.myshopify.com"]);
let cached = null;
let pending = null;

export function remainingPlaces(total) {
  if (!Number.isSafeInteger(total) || total < 0) throw new Error("Invalid segment count");
  return Math.max(0, CAPACITY - Math.max(0, total - BASELINE));
}

async function readRemaining() {
  if (cached && Date.now() - cached.at < 15000) return cached.remaining;
  if (!pending) {
    pending = (async () => {
      const { admin } = await unauthenticated.admin(SHOP);
      const response = await admin.graphql(
        "query Capacity($id: ID!) { customerSegmentMembers(first: 1, segmentId: $id) { totalCount } }",
        { variables: { id: SEGMENT } },
      );
      const result = await response.json();
      if (result.errors?.length) throw new Error("Segment read failed");
      const remaining = remainingPlaces(result.data?.customerSegmentMembers?.totalCount);
      cached = { remaining, at: Date.now() };
      return remaining;
    })().finally(() => { pending = null; });
  }
  return pending;
}

export async function loader({ request }) {
  const origin = request.headers.get("Origin");
  const headers = {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "Vary": "Origin",
  };
  if (origin && !ORIGINS.has(origin)) return new Response(null, { status: 403, headers });
  if (origin) headers["Access-Control-Allow-Origin"] = origin;
  if (Date.now() >= END) return new Response(JSON.stringify({ remaining: 0 }), { headers });
  try {
    const remaining = await readRemaining();
    return new Response(JSON.stringify({ remaining }), { headers });
  } catch {
    return new Response(JSON.stringify({ remaining: null }), { status: 503, headers });
  }
}
