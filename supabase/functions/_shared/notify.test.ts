import { assert, assertEquals } from "jsr:@std/assert@1.0.19";
import { buildConsentPayload, buildPayload, consentNotices, fetchEligibleTransactions, notifyUser, runConsent, userIdsWithSubscriptions } from "./notify.ts";
import { pushEndpointOk, sendToAllSubscriptions, type Subscription } from "./push.ts";

// Records every builder call as [method, ...args]; awaiting it resolves the given rows.
function recorder(rows: unknown[] = []) {
  const calls: unknown[][] = [];
  const builder: Record<string, unknown> = new Proxy({}, {
    get: (_, method: string) => {
      if (method === "then") return (resolve: (v: unknown) => void) => resolve({ data: rows, error: null });
      return (...args: unknown[]) => (calls.push([method, ...args]), builder);
    },
  });
  return { db: { from: () => builder }, calls };
}

const NOW = new Date("2026-10-27T12:00:00Z");

Deno.test("worth-it window: created 3-24 h ago, booked within 7 days (UTC), one user", async () => {
  const { db, calls } = recorder();
  await fetchEligibleTransactions(db, "user", NOW);
  const find = (m: string, c: string) => calls.find((x) => x[0] === m && x[1] === c);
  assertEquals(find("lte", "created_at"), ["lte", "created_at", "2026-10-27T09:00:00.000Z"]);
  assertEquals(find("gte", "created_at"), ["gte", "created_at", "2026-10-26T12:00:00.000Z"]);
  assertEquals(find("eq", "user_id"), ["eq", "user_id", "user"]);
  assertEquals(calls.find((x) => x[0] === "or"), ["or", "booking_date.gte.2026-10-20,booking_date.is.null"]);
  const late = recorder();
  await fetchEligibleTransactions(late.db, "user", new Date("2026-10-27T23:30:00-05:00"));
  assertEquals(late.calls.find((x) => x[0] === "or"), ["or", "booking_date.gte.2026-10-21,booking_date.is.null"]);
});

Deno.test("refunded, deleted, transfer and pending rows are not prompted", async () => {
  const { db } = recorder([
    { entry_reference: "ok", amount: 20, flow_type: "spend", deleted_at: null },
    { entry_reference: "new", amount: 20, flow_type: null, deleted_at: null },
    { entry_reference: "refunded", flow_type: "refunded", deleted_at: null },
    { entry_reference: "deleted", flow_type: "spend", deleted_at: "2026-10-27T10:00:00Z" },
    { entry_reference: "transfer", flow_type: "transfer", deleted_at: null },
    // Pending: asked about once the bank books it (its booked row is new), not twice.
    { entry_reference: "pending", amount: 20, flow_type: "spend", deleted_at: null, pending: true },
  ]);
  assertEquals((await fetchEligibleTransactions(db, "user", NOW)).map((t) => t.entry_reference), ["ok", "new"]);
});

// protects=Worth it? weighs only my share; fails_when=a charge paid for others (or mostly) is prompted, or the push shows the whole charge
Deno.test("a split charge is prompted on my share only", async () => {
  const { db } = recorder([
    { entry_reference: "mine", amount: 40, personal_amount: null, flow_type: "spend", deleted_at: null },
    { entry_reference: "half", amount: 40, personal_amount: 20, flow_type: "spend", deleted_at: null },
    { entry_reference: "small", amount: 40, personal_amount: 10, flow_type: "spend", deleted_at: null },
    { entry_reference: "others", amount: 40, personal_amount: 0, flow_type: "spend", deleted_at: null },
  ]);
  assertEquals((await fetchEligibleTransactions(db, "user", NOW)).map((t) => t.entry_reference), ["mine", "half"]);
  const body = buildPayload([{ entry_reference: "half", creditor_name: "Pizza", amount: 40, personal_amount: 20, currency: "EUR", category: "Dine Out" }]).body;
  assertEquals(body, "€20.00 at Pizza — Dine Out");
  // Polish 1 #10: a code Intl doesn't know keeps the plain form.
  const odd = buildPayload([{ entry_reference: "x", creditor_name: "Shop", amount: 12.5, personal_amount: null, currency: "XX1", category: "Shopping" }]).body;
  assertEquals(odd, "12.5 XX1 at Shop — Shopping");
  // Polish 5 #6: the app formats in en-GB by default, where dollars read "US$".
  const usd = buildPayload([{ entry_reference: "u", creditor_name: "Shop", amount: 50, personal_amount: null, currency: "USD", category: "Shopping" }]).body;
  assertEquals(usd, "US$50.00 at Shop — Shopping");
});

// Polish 1 #11: the €15 line itself, and numeric values arriving as strings.
Deno.test("a share of exactly the minimum is prompted, also when values come as strings", async () => {
  const { db } = recorder([
    { entry_reference: "edge", amount: "40.00", personal_amount: "15.00", flow_type: "spend", deleted_at: null },
    { entry_reference: "under", amount: "40.00", personal_amount: "14.99", flow_type: "spend", deleted_at: null },
  ]);
  assertEquals((await fetchEligibleTransactions(db, "user", NOW)).map((t) => t.entry_reference), ["edge"]);
});

Deno.test("every user with a push subscription is prompted, each once", async () => {
  const { db } = recorder([{ user_id: "a" }, { user_id: "b" }, { user_id: "a" }]);
  assertEquals(await userIdsWithSubscriptions(db), ["a", "b"]);
});

// protects=a purchase is asked about once, only after a push really went out; fails_when=rows are
// marked prompted when every push failed, or a second run asks again
Deno.test("rows are marked prompted only after a push is delivered", async () => {
  const marked: unknown[] = [];
  const tx = { entry_reference: "r1", account_uid: "a1", creditor_name: "Shop", amount: 20, currency: "EUR", category: "Shopping", flow_type: "spend", deleted_at: null };
  const sub = { id: "s1", endpoint: "https://push.example.com/s1", p256dh: "k", auth: "a" };
  const db = {
    from: (table: string) => {
      const q: Record<string, unknown> = {};
      for (const m of ["select", "eq", "in", "is", "gte", "lte"]) q[m] = () => q;
      q.or = async () => ({ data: [tx], error: null });
      q.update = (u: unknown) => (marked.push(u), q);
      if (table === "push_subscriptions") q.eq = async () => ({ data: [sub], error: null });
      q.then = (resolve: (v: unknown) => void) => resolve({ error: null });
      return q;
    },
  };
  const quiet = console.error;
  console.error = () => {};
  try {
    assertEquals(await notifyUser(db, "u1", async () => {
      throw Object.assign(new Error("boom"), { statusCode: 500 });
    }, NOW), 0);
    assertEquals(marked, []);
    assertEquals(await notifyUser(db, "u1", async () => {}, NOW), 1);
    assertEquals(marked, [{ worth_it_prompted_at: NOW.toISOString() }]);
  } finally {
    console.error = quiet;
  }
});

// H247: one update per account, not per row; a failed update counts all of its rows.
Deno.test("prompted rows are marked with one update per account", async () => {
  const row = (ref: string, account_uid: string) =>
    ({ entry_reference: ref, account_uid, creditor_name: "Shop", amount: 20, currency: "EUR", category: "Shopping", flow_type: "spend", deleted_at: null });
  const calls: unknown[] = [];
  const errors: string[] = [];
  const db = {
    from: (table: string) => {
      const q: Record<string, unknown> = {};
      let call: unknown[] | null = null;
      for (const m of ["select", "is", "gte", "lte"]) q[m] = () => q;
      q.or = async () => ({ data: [row("r1", "a1"), row("r2", "a2"), row("r3", "a1")], error: null });
      q.update = (u: unknown) => (call = [u], calls.push(call), q);
      q.eq = (...args: unknown[]) => (call?.push(args), q);
      q.in = (...args: unknown[]) => (call?.push(args), q);
      if (table === "push_subscriptions") q.eq = async () => ({ data: [{ id: "s1", endpoint: "https://push.example.com/s1", p256dh: "k", auth: "a" }], error: null });
      q.then = (resolve: (v: unknown) => void) => resolve({ error: call && (call[1] as unknown[])[1] === "a2" ? { message: "x" } : null });
      return q;
    },
  };
  const quiet = console.error;
  console.error = (m: string) => errors.push(m);
  try {
    assertEquals(await notifyUser(db, "u1", async () => {}, NOW), 3);
  } finally {
    console.error = quiet;
  }
  const at = { worth_it_prompted_at: NOW.toISOString() };
  assertEquals(calls, [
    [at, ["account_uid", "a1"], ["entry_reference", ["r1", "r3"]]],
    [at, ["account_uid", "a2"], ["entry_reference", ["r2"]]],
  ]);
  assertEquals(errors, ["Failed to mark 1 transaction(s) prompted."]);
});

Deno.test("a dead subscription is removed; without push keys nothing is sent", async () => {
  const deleted: string[] = [];
  const db = { from: () => ({ delete: () => ({ eq: async (_: string, id: string) => (deleted.push(id), { error: null }) }) }) };
  const subs: Subscription[] = [{ id: "dead", endpoint: "https://push.example.com/e", p256dh: "k", auth: "a" }, { id: "live", endpoint: "https://push.example.com/e2", p256dh: "k", auth: "a" }];
  const delivered = await sendToAllSubscriptions(db, subs, {}, async (sub) => {
    if (sub.id === "dead") throw Object.assign(new Error("gone"), { statusCode: 410 });
  });
  assertEquals([delivered, deleted], [true, ["dead"]]);
  const log = console.log;
  console.log = () => {};
  try {
    assertEquals(await sendToAllSubscriptions(db, subs, {}, null), false);
  } finally {
    console.log = log;
  }
});

// H237: a stored endpoint (rows from before the table check, or a check rolled back) is sent to only
// when its host could be a push service: never an IP literal, localhost or a name without a dot.
// A DNS name that resolves to a private address still passes. fails_when=send runs for such a host
Deno.test("pushes go only to endpoints whose host could be a push service", async () => {
  for (const ep of [
    "http://push.example.com/x", "https://192.168.1.1/x", "https://10.0.0.1:443/x", "https://127.1/x", "https://0x7f.0.0.1/x",
    "https://2130706433/x", "https://10.0.0.1./x", "https://[::1]/x", "https://[fd00::1]:8443/x", "https://localhost/x",
    "https://LOCALHOST./x", "https://api.localhost/x", "https://router/x", "https://user@push.example.com/x",
    "https://push.example.com@10.0.0.1/x", "https://%31%30.0.0.1/x", "https://push.example.com\\@10.0.0.1/x", "not a url",
    `https://push.example.com/${"a".repeat(2048)}`,
  ]) assertEquals(pushEndpointOk(ep), false, ep);
  for (const ep of [
    "https://fcm.googleapis.com/fcm/send/a1", "https://updates.push.services.mozilla.com/wpush/v2/gAAA",
    "https://web.push.apple.com/QH9x", "https://wns2-par02p.notify.windows.com/w/?token=AwY", "https://push.example.com:8443/k",
  ]) assertEquals(pushEndpointOk(ep), true, ep);

  const sent: string[] = [];
  const db = { from: () => ({ delete: () => ({ eq: async () => ({ error: null }) }) }) };
  const subs: Subscription[] = [
    { id: "lan", endpoint: "https://192.168.1.1/x", p256dh: "k", auth: "a" },
    { id: "ok", endpoint: "https://fcm.googleapis.com/fcm/send/a1", p256dh: "k", auth: "a" },
  ];
  const quiet = console.error;
  console.error = () => {};
  try {
    assertEquals(await sendToAllSubscriptions(db, subs, {}, async (sub) => void sent.push(sub.id)), true);
    assertEquals(sent, ["ok"]);
    assertEquals(await sendToAllSubscriptions(db, [subs[0]], {}, async (sub) => void sent.push(sub.id)), false);
    assertEquals(sent, ["ok"]);
  } finally {
    console.error = quiet;
  }
});

const TODAY = new Date("2026-10-23T09:00:00Z");
const acc = (user_id: string, label: string | null, consent_valid_until: string | null, bank_name?: string) => ({ user_id, label, consent_valid_until, bank_name });

Deno.test("a bank is announced on 14, 7, 1 and 0 days left; its accounts share one consent", () => {
  assertEquals(consentNotices([
    acc("u1", "Revolut EUR", "2026-10-30T00:00:00Z"),
    acc("u1", "Revolut GBP", "2026-11-05T00:00:00Z"),
    acc("u1", "Fineco", "2026-10-24T00:00:00Z"),
    acc("u2", "Wise EUR", "2026-10-23T12:00:00Z"),
    acc("u2", "N26", "2026-10-27T00:00:00Z"),
    acc("u3", "N26 EUR", "2026-11-06T00:00:00Z"),
    acc("u4", "Cash", null),
  ], TODAY), [
    { user_id: "u1", banks: [{ bank: "Fineco", daysLeft: 1 }, { bank: "Revolut", daysLeft: 7 }] },
    { user_id: "u2", banks: [{ bank: "Wise", daysLeft: 0 }] },
    { user_id: "u3", banks: [{ bank: "N26", daysLeft: 14 }] },
  ]);
});

Deno.test("the stored bank name groups accounts whose holder labels differ", () => {
  assertEquals(consentNotices([
    acc("u1", "Marco D'Onghia", "2026-10-30T00:00:00Z", "Revolut"),
    acc("u1", "D'ONGHIA MARCO", "2026-10-24T00:00:00Z", "Revolut"),
  ], TODAY), [{ user_id: "u1", banks: [{ bank: "Revolut", daysLeft: 1 }] }]);
});

Deno.test("the consent push names the bank and opens the Accounts page", () => {
  assertEquals(buildConsentPayload([{ bank: "Revolut", daysLeft: 7 }]), { title: "Renew bank access", body: "Revolut stops syncing in 7 days. Tap to renew.", url: "/accounts" });
  assertEquals(buildConsentPayload([{ bank: "Wise", daysLeft: 0 }, { bank: "Fineco", daysLeft: 1 }]).body, "Wise stops syncing today, Fineco tomorrow. Tap to renew.");
});

Deno.test("runConsent reminds only users with a subscription, and counts deliveries", async () => {
  const db = {
    from: (table: string) => {
      if (table === "accounts") return { select: () => ({ not: async () => ({ data: [acc("u1", "Revolut EUR", "2026-10-30T00:00:00Z"), acc("u2", "Wise EUR", "2026-10-23T00:00:00Z")], error: null }) }) };
      return { select: () => ({ eq: async (_: string, id: string) => ({ data: id === "u1" ? [{ id: "s", endpoint: "https://push.example.com/e", p256dh: "k", auth: "a" }] : [], error: null }) }) };
    },
  };
  const sent: string[] = [];
  assertEquals(await runConsent(db, async (_s, payload) => void sent.push(JSON.parse(payload).body), TODAY), { reminded: 1, failedUsers: 0 });
  assert(sent[0].startsWith("Revolut stops syncing in 7 days"));
});

// protects=the push names the shop like the app does; fails_when=the bank's raw text with codes
// ("Amazon Mark* E46na7fw3") reaches the lock screen, or the user's own name for it is ignored
Deno.test("the push shows the clean merchant name, or the name the user gave it", () => {
  const tx = (creditor_name: string | null, custom_name: string | null = null) => ({ entry_reference: "r1", creditor_name, custom_name, amount: 43.03, currency: "USD", category: "Shopping" });
  assertEquals(buildPayload([tx("Amazon Mark* E46na7fw3")]).body, "US$43.03 at Amazon — Shopping");
  assertEquals(buildPayload([tx("Amazon Mark* E46na7fw3", "Birthday gift")]).body, "US$43.03 at Birthday gift — Shopping");
  assertEquals(buildPayload([tx("netflix", "birthday gift")]).body, "US$43.03 at Birthday gift — Shopping");
  assertEquals(buildPayload([tx("netflix")]).body, "US$43.03 at Netflix — Shopping");
  assertEquals(buildPayload([tx(null)]).body, "US$43.03 at a merchant — Shopping");
  assertEquals(buildPayload([tx("   ", "  ")]).body, "US$43.03 at a merchant — Shopping");
  assertEquals(
    buildPayload([tx("Tst*zuckers Bagels & S"), tx("PAYPAL *SPOTIFY"), tx(""), tx("X")]).body,
    "4 purchases today: Zuckers Bagels, SPOTIFY, a merchant +1 more",
  );
});

// H063: one user's failed subscription read stopped the whole run, and the reminder day is missed for good.
Deno.test("runConsent: one user's failure doesn't stop the reminders for the others", async () => {
  const db = {
    from: (table: string) => {
      if (table === "accounts") return { select: () => ({ not: async () => ({ data: [acc("u1", "Revolut EUR", "2026-10-30T00:00:00Z"), acc("u2", "Wise EUR", "2026-10-30T00:00:00Z")], error: null }) }) };
      return { select: () => ({ eq: async (_: string, id: string) => (id === "u1" ? { data: null, error: { code: "57014" } } : { data: [{ id: "s", endpoint: "https://push.example.com/e", p256dh: "k", auth: "a" }], error: null }) }) };
    },
  };
  const sent: string[] = [];
  const log = console.error;
  console.error = () => {};
  try {
    assertEquals(await runConsent(db, async (_s, payload) => void sent.push(JSON.parse(payload).body), TODAY), { reminded: 1, failedUsers: 1 });
  } finally {
    console.error = log;
  }
  assert(sent[0].startsWith("Wise stops syncing in 7 days"));
});

// H064: the €15 line was compared in each charge's own currency, so 20 HUF (about €0.05) was prompted.
Deno.test("the minimum is in euros: a small charge in another currency isn't prompted", async () => {
  const txs = [
    { entry_reference: "huf-small", amount: 2000, currency: "HUF", flow_type: "spend", deleted_at: null },
    { entry_reference: "huf-big", amount: 8000, currency: "HUF", flow_type: "spend", deleted_at: null },
    { entry_reference: "eur", amount: 20, currency: "EUR", flow_type: "spend", deleted_at: null },
    { entry_reference: "no-rate", amount: 20, currency: "XXX", flow_type: "spend", deleted_at: null },
  ];
  const answer = (rows: unknown[]) => {
    const b: Record<string, unknown> = new Proxy({}, {
      get: (_, m: string) => (m === "then" ? (r: (v: unknown) => void) => r({ data: rows, error: null }) : () => b),
    });
    return b;
  };
  const db = { from: (t: string) => answer(t === "fx_rates" ? [{ currency: "HUF", rate_to_eur: 0.0025, date: "2026-10-27" }] : txs) };
  assertEquals((await fetchEligibleTransactions(db, "user", NOW)).map((t) => t.entry_reference), ["huf-big", "eur", "no-rate"]);
});

// H233 (review): a 403 is the push service refusing this server's VAPID signature (keys that
// don't match the ones the device subscribed with, a bad private key or subject; Apple's
// BadJwtToken), not a gone subscription (404/410). Deleting on 403 let one misconfigured key wipe
// every user's devices for good, so the row stays and the log says what to check.
Deno.test("a subscription refused with 403 (this server's push keys) is kept and logged; 404/410 are removed", async () => {
  const deleted: string[] = [];
  const db = { from: () => ({ delete: () => ({ eq: async (_: string, id: string) => (deleted.push(id), { error: null }) }) }) };
  const sub = (id: string): Subscription => ({ id, endpoint: `https://push.example.com/${id}`, p256dh: "k", auth: "a" });
  const status: Record<string, number> = { other_keys: 403, busy: 503, bad: 400, gone: 410, missing: 404 };
  const logs: string[] = [];
  const error = console.error;
  console.error = (m: string) => logs.push(m);
  try {
    const delivered = await sendToAllSubscriptions(db, ["other_keys", "busy", "bad", "gone", "missing"].map(sub), {}, async (s) => {
      throw Object.assign(new Error("refused"), { statusCode: status[s.id] });
    });
    assertEquals([delivered, deleted], [false, ["gone", "missing"]]);
    assertEquals(logs.filter((l) => l.includes("HTTP 403")).length, 1);
    assertEquals(logs.some((l) => l.includes("HTTP 403") && l.includes("VAPID")), true);
  } finally {
    console.error = error;
  }
});
