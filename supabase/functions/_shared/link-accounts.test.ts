// Polish 5 F1: the renewal wiring in linkAccounts (new session recorded, last sync error cleared,
// replaced session closed at Enable Banking). The helpers have their own tests; this runs the glue.
import { assertEquals } from "jsr:@std/assert@1.0.19";
import { memoryDb } from "./memory-db.test-helper.ts";

// enable-banking.ts reads the key at module load: a real throwaway RSA key, so the JWT signs.
const pair = await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true,
  ["sign", "verify"],
);
const der = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
Deno.env.set("ENABLE_BANKING_APP_ID", "test-app");
Deno.env.set("ENABLE_BANKING_PRIVATE_KEY", `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...der))}\n-----END PRIVATE KEY-----`);
const { linkAccounts } = await import("./link-accounts.ts");

const IBAN = "IT60X0542811101000000123456";
const stored = () => ({
  accounts: [{
    uid: "acc1",
    user_id: "u",
    iban: IBAN,
    currency: "EUR",
    identification_hash: "h1",
    account_type: null,
    bank_session_id: "old",
    sync_error: "HTTP_401",
    sync_error_at: "2026-11-15T06:17:00Z",
  }],
  bank_sessions: [{ session_id: "old", user_id: "u" }],
});

// Enable Banking: POST /sessions returns `session`; every other call (DELETE, balances) 204/404.
function fakeEb(session: Record<string, unknown>) {
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${url}`);
    if (url === "https://api.enablebanking.com/sessions") return Promise.resolve(Response.json(session));
    if (init?.method === "DELETE") return Promise.resolve(new Response(null, { status: 204 }));
    return Promise.resolve(new Response(null, { status: 404 }));
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}
const ebAccount = { uid: "eb-new", currency: "EUR", identification_hash: "h1", account_id: { iban: IBAN } };

Deno.test("linkAccounts: a renewal records the new session, clears the sync error and closes the old session", async () => {
  const db = memoryDb(stored());
  const eb = fakeEb({ session_id: "new", accounts: [ebAccount], access: { valid_until: "2027-05-01T00:00:00Z" } });
  try {
    const result = await linkAccounts(db, "u", "code");
    assertEquals("error" in result, false);
  } finally {
    eb.restore();
  }
  const [row] = db.tables.accounts;
  assertEquals([row.uid, row.eb_account_uid, row.bank_session_id, row.sync_error, row.sync_error_at], ["acc1", "eb-new", "new", null, null]);
  assertEquals(eb.calls.includes("DELETE https://api.enablebanking.com/sessions/old"), true, eb.calls.join("\n"));
  assertEquals(db.tables.bank_sessions.map((s) => s.session_id), ["new"]);
});

Deno.test("linkAccounts: no session id from Enable Banking keeps the session and the error, closes nothing", async () => {
  const db = memoryDb(stored());
  const eb = fakeEb({ accounts: [ebAccount], access: { valid_until: "2027-05-01T00:00:00Z" } });
  try {
    await linkAccounts(db, "u", "code");
  } finally {
    eb.restore();
  }
  const [row] = db.tables.accounts;
  assertEquals([row.bank_session_id, row.sync_error], ["old", "HTTP_401"]);
  assertEquals(eb.calls.some((c) => c.startsWith("DELETE")), false, eb.calls.join("\n"));
});
