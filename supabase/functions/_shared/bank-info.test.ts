import { assertEquals } from "jsr:@std/assert@1.0.19";
import { bankLogo, consentEnd, consentValidUntil, fetchAspsps } from "./bank-info.ts";

const aspsps = [
  { name: "Fineco", logo: "https://enablebanking.com/brands/IT/Fineco/" },
  { name: "Revolut", logo: null },
];

Deno.test("bankLogo returns the logo of the exact name match", () => {
  assertEquals(bankLogo(aspsps, "Fineco"), "https://enablebanking.com/brands/IT/Fineco/");
});
Deno.test("bankLogo returns null when no bank has that name", () => {
  assertEquals(bankLogo(aspsps, "fineco"), null);
});
Deno.test("bankLogo returns null for a null list", () => {
  assertEquals(bankLogo(null, "Fineco"), null);
});
Deno.test("bankLogo returns null when the match has no logo", () => {
  assertEquals(bankLogo(aspsps, "Revolut"), null);
});

const NOW = Date.parse("2026-11-17T00:00:00Z");
const DAY = 24 * 3600 * 1000;

Deno.test("consentValidUntil: 180 days when the bank allows more, or says nothing", () => {
  for (const aspsps of [[{ name: "B", maximum_consent_validity: 400 * 86400 }], [{ name: "B" }], [], null]) {
    assertEquals(consentValidUntil(aspsps, "B", NOW), new Date(NOW + 180 * DAY).toISOString());
  }
});

Deno.test("consentValidUntil: the bank's own maximum when it is shorter, a minute early", () => {
  const until = consentValidUntil([{ name: "A", maximum_consent_validity: 1 }, { name: "B", maximum_consent_validity: 90 * 86400 }], "B", NOW);
  assertEquals(until, new Date(NOW + 90 * DAY - 60_000).toISOString());
});

Deno.test("consentValidUntil: a nonsense maximum falls back to 180 days", () => {
  for (const max of [0, -5, "90", 30]) {
    assertEquals(consentValidUntil([{ name: "B", maximum_consent_validity: max }], "B", NOW), new Date(NOW + 180 * DAY).toISOString());
  }
});

const respond = (status: number, body: unknown, seen: Array<[string, RequestInit | undefined]> = []) =>
  ((url: string, init?: RequestInit) => {
    seen.push([url, init]);
    return Promise.resolve(new Response(JSON.stringify(body), { status }));
  }) as unknown as typeof fetch;

Deno.test("fetchAspsps lists a country's banks with the app token", async () => {
  const seen: Array<[string, RequestInit | undefined]> = [];
  assertEquals(await fetchAspsps("tok", "IT", respond(200, { aspsps }, seen)), aspsps);
  assertEquals(seen[0][0], "https://api.enablebanking.com/aspsps?country=IT");
  assertEquals((seen[0][1]?.headers as Record<string, string>).Authorization, "Bearer tok");
});
Deno.test("fetchAspsps gives null on a refused call, a bad body or a network error", async () => {
  assertEquals(await fetchAspsps("tok", "IT", respond(500, {})), null);
  assertEquals(await fetchAspsps("tok", "IT", respond(200, {})), null);
  const down = (() => Promise.reject(new TypeError("down"))) as unknown as typeof fetch;
  assertEquals(await fetchAspsps("tok", "IT", down), null);
});

// Polish 5 F1: start-bank-consent asks for the bank's own maximum, looked up for its country.
Deno.test("consentEnd: looks the bank up in its country and asks for no more than its maximum", async () => {
  const urls: string[] = [];
  const fetchFn = ((url: string) => {
    urls.push(url);
    return Promise.resolve(Response.json({ aspsps: [{ name: "B", maximum_consent_validity: 90 * 86400 }] }));
  }) as unknown as typeof fetch;
  assertEquals(await consentEnd("tok", "IT", "B", NOW, fetchFn), new Date(NOW + 90 * DAY - 60_000).toISOString());
  assertEquals(urls, ["https://api.enablebanking.com/aspsps?country=IT"]);
});
Deno.test("consentEnd: a failed lookup asks for the usual 180 days", async () => {
  const fail = (() => Promise.resolve(new Response(null, { status: 500 }))) as unknown as typeof fetch;
  assertEquals(await consentEnd("tok", "IT", "B", NOW, fail), new Date(NOW + 180 * DAY).toISOString());
});
