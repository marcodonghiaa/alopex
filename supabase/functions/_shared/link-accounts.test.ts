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

Deno.test("linkAccounts: a new account shared by the renewal reads from the new session", async () => {
  const db = memoryDb(stored());
  const added = { uid: "eb-usd", currency: "USD", identification_hash: "h2", account_id: { iban: IBAN } };
  const eb = fakeEb({ session_id: "new", accounts: [ebAccount, added], access: { valid_until: "2027-05-01T00:00:00Z" } });
  try {
    await linkAccounts(db, "u", "code");
  } finally {
    eb.restore();
  }
  assertEquals(db.tables.accounts.find((a) => a.uid === "eb-usd")?.bank_session_id, "new");
});

// H038: a renewed account was left for the next cron (up to 6 h), missing the first hour after
// consent when banks still allow a long history read. Now every linked account syncs right away,
// and no separate balance call is spent (sync-bank reads the balance first).
Deno.test("linkAccounts: renewed and new accounts are all synced right away, with no extra balance call", async () => {
  const db = memoryDb(stored());
  const added = { uid: "eb-usd", currency: "USD", identification_hash: "h2", account_id: { iban: IBAN } };
  const eb = fakeEb({ session_id: "new", accounts: [ebAccount, added], access: { valid_until: "2027-05-01T00:00:00Z" } });
  let result;
  try {
    result = await linkAccounts(db, "u", "code");
  } finally {
    eb.restore();
  }
  assertEquals("syncUids" in result! ? [...result.syncUids].sort() : result, ["acc1", "eb-usd"]);
  assertEquals(eb.calls.some((c) => c.includes("/balances")), false, eb.calls.join("\n"));
});

// Review of H038: two shared accounts that match one stored account must not start two
// concurrent syncs of it (each costs the bank's few daily calls).
Deno.test("linkAccounts: an account matched twice in one consent is synced once", async () => {
  const db = memoryDb(stored());
  const twin = (uid: string) => ({ uid, currency: "EUR", account_id: { iban: IBAN } });
  const eb = fakeEb({ session_id: "new", accounts: [twin("eb-a"), twin("eb-b")], access: { valid_until: "2027-05-01T00:00:00Z" } });
  let result;
  try {
    result = await linkAccounts(db, "u", "code");
  } finally {
    eb.restore();
  }
  assertEquals("syncUids" in result! ? result.syncUids : result, ["acc1"]);
});


// accounts inserts of the uids in `failing` get a database error; everything else is memoryDb.
function failingInserts(db: ReturnType<typeof memoryDb>, failing: (uid: string) => boolean) {
  const from = db.from.bind(db);
  return {
    ...db,
    from(table: string) {
      const q = from(table);
      if (table !== "accounts") return q;
      const insert = q.insert;
      return {
        ...q,
        insert: (row: { uid: string }) =>
          failing(row.uid) ? { then: (resolve: (v: unknown) => void) => resolve({ error: { code: "XX000" } }) } : insert(row),
      };
    },
  };
}

async function quietLink(db: unknown, session: Record<string, unknown>) {
  const eb = fakeEb(session);
  const silence = console.error;
  console.error = () => {};
  try {
    return await linkAccounts(db, "u", "code");
  } finally {
    console.error = silence;
    eb.restore();
  }
}

// H160: one account's failed write aborted the loop. The accounts saved before it stayed linked
// but got no first sync (the bank's long-history hour lost) and the user was told the link failed.
Deno.test("linkAccounts: one account's failed write skips only that account; the rest are saved and synced", async () => {
  const db = memoryDb({ accounts: [], bank_sessions: [] });
  const acc = (uid: string, hash: string) => ({ uid, currency: "EUR", identification_hash: hash, account_id: { iban: `IT${hash}` } });
  const result = await quietLink(failingInserts(db, (uid) => uid === "eb-2"), {
    session_id: "s",
    accounts: [acc("eb-1", "h1"), acc("eb-2", "h2"), acc("eb-3", "h3")],
  });
  assertEquals("syncUids" in result ? result.syncUids : result, ["eb-1", "eb-3"]);
  assertEquals(db.tables.accounts.map((a) => a.uid), ["eb-1", "eb-3"]);
});

Deno.test("linkAccounts: when no account could be saved, the link fails", async () => {
  const db = memoryDb({ accounts: [], bank_sessions: [] });
  const result = await quietLink(failingInserts(db, () => true), {
    session_id: "s",
    accounts: [{ uid: "eb-1", currency: "EUR", identification_hash: "h1" }],
  });
  assertEquals("error" in result, true);
});

// A concurrent callback inserted the same pocket first: this link updates that row and leaves its
// first sync to the callback that inserted it.
Deno.test("linkAccounts: an account a concurrent link inserted first is updated, not synced twice", async () => {
  const db = memoryDb({ accounts: [], bank_sessions: [] });
  const from = db.from.bind(db);
  const racing = {
    ...db,
    from(table: string) {
      const q = from(table);
      if (table !== "accounts") return q;
      return {
        ...q,
        insert: () => {
          db.tables.accounts.push({ uid: "other", user_id: "u", currency: "EUR", identification_hash: "h1" });
          return { then: (resolve: (v: unknown) => void) => resolve({ error: { code: "23505" } }) };
        },
      };
    },
  };
  const result = await quietLink(racing, { session_id: "s", accounts: [{ uid: "eb-1", currency: "EUR", identification_hash: "h1" }] });
  assertEquals("syncUids" in result ? result.syncUids : result, []);
  assertEquals(db.tables.accounts.map((a) => [a.uid, a.eb_account_uid, a.bank_session_id]), [["other", "eb-1", "s"]]);
});

// H167: a consent that shares no account returned before its session was stored anywhere, so the
// session stayed open at Enable Banking with nothing on this instance to close it.
Deno.test("linkAccounts: a consent that shares no account closes its session", async () => {
  const db = memoryDb({ accounts: [], bank_sessions: [] });
  const eb = fakeEb({ session_id: "empty", accounts: [] });
  let result;
  try {
    result = await linkAccounts(db, "u", "code");
  } finally {
    eb.restore();
  }
  assertEquals("error" in result!, true);
  assertEquals(eb.calls.includes("DELETE https://api.enablebanking.com/sessions/empty"), true, eb.calls.join("\n"));
});

// H169: the code exchange (POST /sessions) had no timeout, so a slow Enable Banking held the
// function after the pending consent was already used up.
Deno.test("linkAccounts: the session call to Enable Banking has a timeout", async () => {
  const original = globalThis.fetch;
  let signal: AbortSignal | null | undefined;
  globalThis.fetch = ((_url: string, init?: RequestInit) => {
    signal = init?.signal;
    return Promise.resolve(Response.json({}, { status: 500 }));
  }) as typeof fetch;
  const silence = console.error;
  console.error = () => {};
  try {
    await linkAccounts(memoryDb({ accounts: [] }), "u", "code");
  } finally {
    console.error = silence;
    globalThis.fetch = original;
  }
  assertEquals(signal instanceof AbortSignal, true);
});
