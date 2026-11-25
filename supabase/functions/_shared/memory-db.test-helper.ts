// In-memory stand-in for the supabase query builder, for tests: honors the filters the
// post-sync steps use (is/eq/in/not/gte, filter match, order, limit, range) and applies updates and deletes to the
// matching rows, so tests check data, not call shapes. insert and upsert append rows.
// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

// failWrite: make every delete or update return a DB error without applying it.
// maxRows: answer at most this many rows per read, like PostgREST's max-rows (1000 by default).
export function memoryDb(tables: Record<string, Row[]>, failWrite?: "delete" | "update", maxRows = Infinity) {
  return {
    tables,
    from(table: string) {
      const filters: Array<(r: Row) => boolean> = [];
      const orders: Array<[string, boolean]> = [];
      let patch: Row | null = null;
      let remove = false;
      let added: Row[] | null = null;
      let window: [number, number] = [0, Infinity];
      let single = false;
      const q = {
        select: () => q,
        update: (u: Row) => ((patch = u), q),
        delete: () => ((remove = true), q),
        insert: (rows: Row | Row[]) => ((added = [rows].flat()), q),
        upsert: (rows: Row | Row[]) => ((added = [rows].flat()), q), // appends; tests need no conflict merge
        is: (c: string, v: unknown) => (filters.push((r) => (r[c] ?? null) === v), q),
        eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), q),
        in: (c: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[c])), q),
        filter: (c: string, op: "match", v: string) => (filters.push((r) => r[c] != null && new RegExp(v).test(r[c])), q),
        gte: (c: string, v: string) => (filters.push((r) => r[c] >= v), q),
        not: (c: string, op: string, v: unknown) => {
          if (op === "is") filters.push((r) => (r[c] ?? null) !== v);
          else filters.push((r) => !String(v).slice(1, -1).split(",").includes(r[c]));
          return q;
        },
        // PostgREST or(): only the "col.is.null" and "col.in.(a,b)" terms the steps use.
        or: (expr: string) => {
          const terms = expr.split(/,(?![^(]*\))/).map((t) => {
            const [c, op, ...rest] = t.split(".");
            const v = rest.join(".");
            return op === "is" ? (r: Row) => (r[c] ?? null) === null : (r: Row) => v.slice(1, -1).split(",").includes(r[c]);
          });
          filters.push((r) => terms.some((f) => f(r)));
          return q;
        },
        order: (c: string, o?: { ascending?: boolean }) => (orders.push([c, o?.ascending !== false]), q),
        limit: (n: number) => ((window = [0, n - 1]), q),
        range: (a: number, b: number) => ((window = [a, b]), q),
        maybeSingle: () => ((single = true), q),
        then(resolve: (v: unknown) => void) {
          if (added) {
            (tables[table] ??= []).push(...added.map((r) => ({ ...r })));
            return resolve({ data: null, error: null });
          }
          const rows = (tables[table] ??= []).filter((r) => filters.every((f) => f(r)));
          if ((remove && failWrite === "delete") || (patch && failWrite === "update")) {
            return resolve({ data: null, error: { code: "XX000", message: "private name" } });
          }
          if (remove) {
            tables[table] = tables[table].filter((r) => !rows.includes(r));
            return resolve({ data: null, error: null });
          }
          if (patch) {
            for (const r of rows) Object.assign(r, patch);
            return resolve({ data: null, error: null });
          }
          rows.sort((a, b) => {
            for (const [c, asc] of orders) if (a[c] !== b[c]) return (a[c] < b[c] ? -1 : 1) * (asc ? 1 : -1);
            return 0;
          });
          const data = rows.slice(window[0], Math.min(window[1] + 1, window[0] + maxRows)).map((r) => ({ ...r }));
          resolve({ data: single ? data[0] ?? null : data, error: null });
        },
      };
      return q;
    },
  };
}
