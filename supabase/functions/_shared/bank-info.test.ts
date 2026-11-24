import { assertEquals } from "jsr:@std/assert@1.0.19";
import { bankChoices, bankLogo, consentValidUntil, fetchAspsps, requestConsentUrl } from "./bank-info.ts";

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

Deno.test("bankChoices keeps beta banks, flagged, A to Z (a bank linked in Enable Banking must show)", () => {
  assertEquals(bankChoices([
    { name: "Trade Republic", beta: true, logo: "https://x/tr.png" },
    { name: "Fineco" },
    { name: "bunq", beta: false, logo: null },
  ]), [
    { name: "bunq", logo: null, beta: false },
    { name: "Fineco", logo: null, beta: false },
    { name: "Trade Republic", logo: "https://x/tr.png", beta: true },
  ]);
});

// H037: a failed /auth call must not leave its pending row, or a few retries hit the 5-open cap.
const CONSENT = { token: "tok", bankName: "B", country: "IT", validUntil: "2027-01-01", state: "s1", redirectUrl: "https://x/cb" };
const answer = (status: number, body: unknown) =>
  (() => Promise.resolve(Response.json(body, { status }))) as unknown as typeof fetch;
for (const [name, fetchFn] of [
  ["a refused call", answer(500, {})],
  ["a reply with no url", answer(200, {})],
  ["a network failure", (() => Promise.reject(new TypeError("offline"))) as unknown as typeof fetch],
] as const) {
  Deno.test(`requestConsentUrl: ${name} discards the pending row and says why`, async () => {
    let discarded = 0;
    const result = await requestConsentUrl({ ...CONSENT, discard: async () => { discarded++; }, fetchFn });
    assertEquals(discarded, 1);
    assertEquals("error" in result && result.status >= 500, true);
  });
}
Deno.test("requestConsentUrl: a good reply keeps the row and returns the bank's url", async () => {
  let discarded = 0;
  const result = await requestConsentUrl({
    ...CONSENT, discard: async () => { discarded++; }, fetchFn: answer(200, { url: "https://bank/consent" }),
  });
  assertEquals(result, { url: "https://bank/consent" });
  assertEquals(discarded, 0);
});

// H169: a slow Enable Banking held the function until the platform killed it.
Deno.test("requestConsentUrl: the /auth call has a timeout", async () => {
  let signal: AbortSignal | null | undefined;
  const fetchFn = ((_url: string, init: RequestInit) => {
    signal = init.signal;
    return Promise.resolve(Response.json({ url: "https://bank/consent" }));
  }) as unknown as typeof fetch;
  await requestConsentUrl({ ...CONSENT, discard: async () => {}, fetchFn });
  assertEquals(signal instanceof AbortSignal, true);
});
