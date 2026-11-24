// Parsing and input checks for add-holding. Kept free of Deno APIs so the tests run anywhere.

export type HoldingKind = "stock" | "crypto";

export interface Candidate {
  id: string; // Yahoo symbol for a stock or ETF, CoinGecko id for a coin
  symbol: string;
  name: string;
  detail: string;
}

export interface Quote {
  price: number;
  currency: string;
  assetType: string;
}

export type HoldingRequest =
  | { action: "search"; kind: HoldingKind; query: string }
  | {
    action: "add";
    kind: HoldingKind;
    id: string;
    symbol: string;
    name: string;
    quantity: number;
    isin: string | undefined;
    broker: string | undefined;
  };

export const MAX_QUERY_LENGTH = 50;
const MAX_RESULTS = 8;

export const isIsin = (value: string): boolean => /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/.test(value);

// Same labels the price sync stores in portfolio_holdings.asset_type
const ASSET_TYPE: Record<string, string> = { EQUITY: "Stock", ETF: "ETF", MUTUALFUND: "Fund", BOND: "Bond" };

type Json = Record<string, unknown>;

// Throws AlreadyHeld when the user holds this Yahoo symbol under a key other than `key`. A stock
// added by name or ticker is keyed by its symbol, one added by ISIN by the ISIN: the same security
// added both ways was held, priced and counted in net worth twice. The same key is left to the
// insert's unique key.
export async function refuseHeldElsewhere(
  // deno-lint-ignore no-explicit-any
  db: { from(table: string): any },
  userId: string,
  yahooSymbol: string,
  key: string,
): Promise<void> {
  const { data, error } = await db.from("portfolio_holdings").select("isin")
    .eq("user_id", userId).eq("yahoo_symbol", yahooSymbol).neq("isin", key).limit(1);
  if (error) throw error;
  if (data?.[0]) throw new AlreadyHeld(data[0].isin);
}

// You hold this security already, under `key` (add-holding answers 409 already_held).
export class AlreadyHeld extends Error {
  constructor(readonly key: string) {
    super("already_held");
  }
}

// A failure whose message says what went wrong: shown to the user as is, and never holds an upstream body.
export class HoldingError extends Error {}

export function upstreamMessage(host: string, status: number): string {
  const provider = host.includes("coingecko") ? "CoinGecko" : "Yahoo Finance";
  if (status === 429 || status === 403) {
    return `${provider} is limiting requests from this server (error ${status}), try again in a minute`;
  }
  if (status === 404) return `${provider} has no price for this (error 404)`;
  return `${provider} is unavailable right now${status ? ` (error ${status})` : ""}, try again`;
}
const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

const isPrice = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;

export function parseYahooSearch(data: Json): Array<Candidate> {
  if (!Array.isArray(data.quotes)) throw new HoldingError("Yahoo Finance sent an unexpected reply, try again");
  return (data.quotes as Array<Json>)
    .filter((q) => text(q.quoteType) in ASSET_TYPE)
    .map((q) => ({
      id: text(q.symbol),
      symbol: text(q.symbol),
      name: text(q.longname) || text(q.shortname),
      detail: [ASSET_TYPE[text(q.quoteType)], text(q.exchDisp)].filter(Boolean).join(" · "),
    }))
    .filter((c) => c.id !== "" && c.name !== "")
    .slice(0, MAX_RESULTS);
}

// Rejects a missing or zero price so a holding is never stored without a value. London quotes come in pence (GBp).
// Yahoo's daily chart (latest quote) and CoinGecko's USD price for comma-separated ids, used by
// add-holding and sync-prices.
export const yahooChartUrl = (symbol: string) =>
  `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`;
export const coingeckoPriceUrl = (ids: string) =>
  `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(ids)}&vs_currencies=usd`;

export function parseYahooChart(data: Json, symbol: string): Quote {
  const result = ((data.chart as Json | undefined)?.result as Array<Json> | undefined)?.[0];
  if (!result) throw new HoldingError(`No quote for ${symbol}`);
  const meta = (result.meta ?? {}) as Json;
  const price = meta.regularMarketPrice;
  if (!isPrice(price)) throw new HoldingError(`No valid price for ${symbol}`);
  const assetType = ASSET_TYPE[text(meta.instrumentType)] ?? "Other";
  if (meta.currency === "GBp") return { price: price / 100, currency: "GBP", assetType };
  return { price, currency: text(meta.currency), assetType };
}

export function parseCoinGeckoSearch(data: Json): Array<Candidate> {
  if (!Array.isArray(data.coins)) throw new HoldingError("CoinGecko sent an unexpected reply, try again");
  return (data.coins as Array<Json>)
    .map((c) => ({
      id: text(c.id),
      symbol: text(c.symbol).toUpperCase(),
      name: text(c.name),
      detail: typeof c.market_cap_rank === "number" ? `Rank #${c.market_cap_rank}` : "Crypto",
    }))
    .filter((c) => c.id !== "" && c.symbol !== "" && c.name !== "")
    .slice(0, MAX_RESULTS);
}

export function parseCoinGeckoPrice(data: Json, id: string): number {
  const price = (data[id] as { usd?: unknown } | undefined)?.usd;
  if (!isPrice(price)) throw new HoldingError(`CoinGecko has no price for ${id}`);
  return price;
}

const isKind = (v: unknown): v is HoldingKind => v === "stock" || v === "crypto";
const ID_PATTERN: Record<HoldingKind, RegExp> = {
  stock: /^[A-Za-z0-9.\-=^]{1,20}$/,
  crypto: /^[a-z0-9-]{1,80}$/,
};

// Returns the checked request, or a message for a 400.
export function parseHoldingRequest(body: unknown): HoldingRequest | string {
  if (!body || typeof body !== "object") return "Invalid request";
  const b = body as Json;
  if (!isKind(b.kind)) return "kind must be stock or crypto";

  if (b.action === "search") {
    const query = text(b.query);
    if (query === "" || query.length > MAX_QUERY_LENGTH) return `query must be 1-${MAX_QUERY_LENGTH} characters`;
    return { action: "search", kind: b.kind, query };
  }
  if (b.action !== "add") return "action must be search or add";

  const id = text(b.id);
  const symbol = text(b.symbol);
  const name = text(b.name);
  const isin = b.isin === undefined ? undefined : text(b.isin);
  const broker = b.broker === undefined ? undefined : text(b.broker);
  if (!ID_PATTERN[b.kind].test(id)) return "Invalid id";
  if (symbol === "" || symbol.length > 20) return "Invalid symbol";
  if (name === "" || name.length > 120) return "Invalid name";
  if (typeof b.quantity !== "number" || !Number.isFinite(b.quantity) || b.quantity <= 0 || b.quantity > 1e12) {
    return "quantity must be a positive number";
  }
  if (isin !== undefined && !isIsin(isin)) return "Invalid ISIN";
  if (broker !== undefined && broker.length > 40) return "broker must be at most 40 characters";
  return { action: "add", kind: b.kind, id, symbol, name, quantity: b.quantity, isin, broker };
}
