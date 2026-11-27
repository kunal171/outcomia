/** Server-side USD prices for every configured asset: fixed prices directly,
 * Pyth feeds from Hermes in one request. Hermes needs an API key (Bearer,
 * since August 2026) in `PYTH_API_KEY`; without one, Pyth-priced assets are
 * reported unavailable. Only feed ids and the key leave the server. */
import { priceSources } from "./sources.ts";
import { parseHermes, type Price } from "./usd.ts";

const HERMES = "https://hermes.pyth.network/v2/updates/price/latest";

export async function usdPrices(
  env: NodeJS.ProcessEnv,
  transport: typeof fetch = fetch,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<{ prices: Record<string, Price>; unavailable: string[] }> {
  const sources = priceSources(env.PRICE_SOURCES);
  const prices: Record<string, Price> = {};
  const feeds = new Map<string, string[]>();
  for (const [asset, source] of Object.entries(sources)) {
    if ("fixed" in source)
      prices[asset] = { usd: source.fixed, source: "fixed" };
    else feeds.set(source.pyth, [...(feeds.get(source.pyth) ?? []), asset]);
  }
  const unavailable: string[] = [];
  const key = env.PYTH_API_KEY?.trim();
  if (feeds.size && !key)
    for (const assets of feeds.values()) unavailable.push(...assets);
  else if (feeds.size) {
    const url = new URL(env.PYTH_HERMES_URL?.trim() || HERMES);
    for (const id of feeds.keys()) url.searchParams.append("ids[]", id);
    url.searchParams.set("parsed", "true");
    try {
      const response = await transport(url, {
        headers: { authorization: `Bearer ${key}` },
        redirect: "error",
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new Error("Hermes unavailable");
      const latest = parseHermes(await response.json(), nowSeconds);
      for (const [id, assets] of feeds)
        for (const asset of assets)
          if (latest[id]) prices[asset] = latest[id];
          else unavailable.push(asset);
    } catch {
      for (const assets of feeds.values()) unavailable.push(...assets);
    }
  }
  return { prices, unavailable };
}
