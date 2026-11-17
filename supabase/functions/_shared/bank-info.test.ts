import { assertEquals } from "jsr:@std/assert@1.0.19";
import { bankLogo, consentValidUntil } from "./bank-info.ts";

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
