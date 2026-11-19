import { assertEquals } from "jsr:@std/assert@1.0.19";
import { cleanMerchantName } from "./merchant-name.ts";
import cases from "./merchant-name.cases.json" with { type: "json" };

// Same cases as alopex-web's copy and the Node copy (merchant-name.js): the three must agree.
Deno.test("cleans raw bank merchant text", () => {
  for (const [raw, clean] of cases.clean) assertEquals(cleanMerchantName(raw), clean, raw);
});

Deno.test("leaves plain names alone and never returns an empty one", () => {
  for (const name of cases.keep) assertEquals(cleanMerchantName(name), name);
  assertEquals(cleanMerchantName("SQ *"), "SQ");
  assertEquals(cleanMerchantName(null), null);
});
