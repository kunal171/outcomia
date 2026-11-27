import { usdPrices } from "../../../lib/prices/server";
export const runtime = "nodejs";
/** USD prices for P&L totals. Cached briefly; a Hermes outage only drops the
 * Pyth-priced assets, which the page then lists as unpriced. */
export async function GET() {
  const result = await usdPrices(process.env);
  return Response.json(result, {
    headers: { "cache-control": "public, max-age=30, s-maxage=30" },
  });
}
