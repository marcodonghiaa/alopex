// The cron syncs banks every 6 hours, so a bank linked just after a run showed no transactions
// for hours. Right after a link, ask sync-bank (the same function the cron calls, with the same
// secret key) to sync each new account once. Best effort: a failure waits for the next cron run.
import { errorTag } from "./log-safe.ts";

export async function startFirstSync(
  baseUrl: string,
  secretKey: string | undefined,
  accountUids: string[],
  fetchFn: typeof fetch = fetch,
  // Then sort what came in: categories, transfers, subscriptions (e2e #7). Best effort.
  catchUp?: () => PromiseLike<unknown>,
): Promise<number> {
  if (!secretKey) return 0;
  const results = await Promise.all(accountUids.map(async (uid) => {
    try {
      const res = await fetchFn(`${baseUrl.replace(/\/+$/, "")}/functions/v1/sync-bank`, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: secretKey },
        body: JSON.stringify({ account_uid: uid }),
      });
      if (res.ok) {
        await res.body?.cancel();
        return { ok: true, saved: true };
      }
      console.error(`first sync failed: ${errorTag({ status: res.status })}`);
      // A run that hit the deadline still saved the pages it read (H164): sort those now too.
      const body = await res.json().catch(() => null);
      return { ok: false, saved: typeof body?.upserted === "number" && body.upserted > 0 };
    } catch (err) {
      console.error(`first sync failed: ${errorTag(err)}`);
      return { ok: false, saved: false };
    }
  }));
  const synced = results.filter((r) => r.ok).length;
  if (results.some((r) => r.saved) && catchUp) {
    try {
      await catchUp();
    } catch (err) {
      console.error(`catch-up start failed: ${errorTag(err)}`);
    }
  }
  return synced;
}
