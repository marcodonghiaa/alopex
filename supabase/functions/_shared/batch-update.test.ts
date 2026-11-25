import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1.0.19";
import { applyGroupedUpdates, fetchByRefs, readPages, type RowUpdate } from "./batch-update.ts";

type Call = {
  table: string;
  update: Record<string, unknown> | null;
  eq: Record<string, unknown>;
  in: { col: string; vals: string[] } | null;
  guardIn?: { col: string; vals: string[] };
  is: { col: string; val: unknown } | null;
};

// Records each UPDATE the way PostgREST would see it: one call per statement.
function fakeDb({ failWhen }: { failWhen?: (c: Call) => boolean } = {}) {
  const calls: Call[] = [];
  return {
    calls,
    from(table: string) {
      const call: Call = { table, update: null, eq: {}, in: null, is: null };
      const q = {
        update(u: Record<string, unknown>) { call.update = u; return q; },
        eq(col: string, val: unknown) { call.eq[col] = val; return q; },
        in(col: string, vals: string[]) {
          if (col === "entry_reference") call.in = { col, vals };
          else call.guardIn = { col, vals };
          return q;
        },
        is(col: string, val: unknown) { call.is = { col, val }; return q; },
        then(resolve: (v: unknown) => void) {
          calls.push(call);
          resolve({ error: failWhen?.(call) ? { code: "42501", message: "boom" } : null });
        },
      };
      return q;
    },
  };
}

const item = (ref: string, over: Partial<RowUpdate> = {}): RowUpdate => ({
  account_uid: "acc1",
  entry_reference: ref,
  update: { category: "Groceries" },
  guardColumn: "category",
  ...over,
});

Deno.test("rows with the same account and update become one statement", async () => {
  const db = fakeDb();
  await applyGroupedUpdates(db, [item("1"), item("2"), item("3")]);
  assertEquals(db.calls.length, 1);
  assertEquals(db.calls[0].in, { col: "entry_reference", vals: ["1", "2", "3"] });
  assertEquals(db.calls[0].update, { category: "Groceries" });
  assertEquals(db.calls[0].eq.account_uid, "acc1");
});

Deno.test("only fills empty values: every statement carries the is-null guard", async () => {
  const db = fakeDb();
  await applyGroupedUpdates(db, [item("1")]);
  assertEquals(db.calls[0].is, { col: "category", val: null });
});

Deno.test("different values or accounts are separate statements", async () => {
  const db = fakeDb();
  await applyGroupedUpdates(db, [item("1"), item("2", { update: { category: "Health" } }), item("3", { account_uid: "acc2" })]);
  assertEquals(db.calls.length, 3);
});

Deno.test("large groups are chunked so the request URL stays short", async () => {
  const db = fakeDb();
  await applyGroupedUpdates(db, Array.from({ length: 120 }, (_, i) => item(String(i))));
  assertEquals(db.calls.map((c) => c.in!.vals.length), [50, 50, 20]);
});

Deno.test("a failed statement is logged by code, never by message, and the others still run", async () => {
  const db = fakeDb({ failWhen: (c) => c.update?.category === "Health" });
  const logged: string[] = [];
  const original = console.error;
  console.error = (...a: unknown[]) => logged.push(a.join(" "));
  try {
    assertEquals(await applyGroupedUpdates(db, [item("1", { update: { category: "Health" } }), item("2")]), 1);
  } finally {
    console.error = original;
  }
  assertEquals(db.calls.length, 2);
  assert(logged.some((l) => l.includes("42501")));
  assert(!logged.some((l) => l.includes("boom")));
});

Deno.test("does nothing for an empty list", async () => {
  const db = fakeDb();
  await applyGroupedUpdates(db, []);
  assertEquals(db.calls.length, 0);
});

Deno.test("guardIn items are guarded by an in-list instead of is-null", async () => {
  const db = fakeDb();
  await applyGroupedUpdates(db, [
    item("1", { update: { category: "Health", category_source: "rule" }, guardColumn: "category_source", guardIn: ["ai", "rule"] }),
  ]);
  assertEquals(db.calls[0].is, null);
  assertEquals(db.calls[0].guardIn, { col: "category_source", vals: ["ai", "rule"] });
});

Deno.test("userId scopes every statement to that user and failures are counted", async () => {
  const db = fakeDb({ failWhen: (c) => c.in?.vals.includes("2") ?? false });
  const failed = await applyGroupedUpdates(db, [item("1"), item("2", { account_uid: "acc2" })], "u1");
  assertEquals(db.calls.map((c) => c.eq.user_id), ["u1", "u1"]);
  assertEquals(failed, 1);
});

Deno.test("readPages reads 1000-row pages until a short one, and throws on an error", async () => {
  const pageOf = (total: number) => {
    const asked: number[][] = [];
    const page = (from: number, to: number) => {
      asked.push([from, to]);
      const data = Array.from({ length: Math.max(0, Math.min(to + 1, total) - from) }, (_, i) => from + i);
      return Promise.resolve({ data, error: null });
    };
    return { asked, page };
  };
  const two = pageOf(1500);
  assertEquals((await readPages(two.page)).length, 1500);
  assertEquals(two.asked, [[0, 999], [1000, 1999]]);
  // Exactly a page: one more read finds nothing.
  const exact = pageOf(1000);
  assertEquals((await readPages(exact.page)).length, 1000);
  assertEquals(exact.asked.length, 2);
  assertEquals(await readPages(() => Promise.resolve({ data: null, error: null })), []);
  await assertRejects(() => readPages(() => Promise.resolve({ data: null, error: new Error("boom") })), Error, "boom");
});

// H258: the refund repair and the stale-pair check read rows by ref through this.
Deno.test("fetchByRefs reads one account's rows 50 refs per request and throws on a failed read", async () => {
  const seen: unknown[] = [];
  const db = (failOn?: number) => ({
    from: (table: string) => {
      const q = {
        select: (cols: string) => (seen.push([table, cols]), q),
        eq: (c: string, v: string) => (seen.push([c, v]), q),
        in: (_c: string, refs: string[]) => {
          seen.push(refs.length);
          return Promise.resolve(refs.length === failOn ? { data: null, error: new Error("x") } : { data: refs.map((r) => ({ r })), error: null });
        },
      };
      return q;
    },
  });
  const refs = Array.from({ length: 120 }, (_, i) => `e${i}`);
  assertEquals((await fetchByRefs(db(), "a, b", "acc", refs)).length, 120);
  assertEquals(seen.filter((x) => typeof x === "number"), [50, 50, 20]);
  assertEquals(seen.slice(0, 2), [["transactions", "a, b"], ["account_uid", "acc"]]);
  await assertRejects(() => fetchByRefs(db(20), "a", "acc", refs));
});
