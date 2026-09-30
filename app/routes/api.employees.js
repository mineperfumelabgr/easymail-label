import prisma from "../db.server";
import { authenticate } from "../shopify.server";

function corsHeaders(extra = {}) {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    ...extra,
  };
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: corsHeaders({ "Content-Type": "application/json; charset=utf-8" }),
  });
}

export async function loader({ request }) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  try {
    const { session } = await authenticate.admin(request);
    const employees = await prisma.employee.findMany({
      where: { shop: session.shop },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    });

    return jsonResponse({ success: true, employees });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("LOAD EMPLOYEES ERROR:", error);
    return jsonResponse(
      { success: false, message: "Could not load employees." },
      500,
    );
  }
}
