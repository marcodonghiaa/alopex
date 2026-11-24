// Web Push shared by the notifications. The send function comes in from
// the caller (web-push in notify/index.ts), so this stays testable without npm.
import { errorTag } from "./log-safe.ts";

// deno-lint-ignore no-explicit-any
type Db = { from(table: string): any };
export type Subscription = { id: string; endpoint: string; p256dh: string; auth: string };
/** Sends one push; throws an error with statusCode on a refused subscription. */
export type SendPush = (sub: Subscription, payload: string) => Promise<unknown>;

/**
 * The table check push_subscriptions_valid (migration 20270118000000), here too because a row may
 * predate it: an https endpoint of at most 2048 characters whose host is a DNS name (letters,
 * digits, hyphens, at least one dot), never an IP literal, localhost or *.localhost, nor with user
 * info. A DNS name that resolves to a private address still passes.
 */
export function pushEndpointOk(endpoint: string): boolean {
  if (typeof endpoint !== "string" || endpoint.length > 2048) return false;
  const authority = endpoint.match(/^https:\/\/([^/?#]*)/)?.[1];
  if (authority === undefined) return false;
  const host = authority.replace(/:[0-9]{1,5}$/, "");
  if (!/^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+\.?$/.test(host)) return false;
  const name = host.toLowerCase().replace(/\.+$/, "");
  // A numeric (or 0x) last label makes the whole host an IPv4 address to URL parsers.
  return !/(^|\.)localhost$/.test(name) && !/^([0-9]+|0x[0-9a-f]*)$/.test(name.slice(name.lastIndexOf(".") + 1));
}

export async function fetchSubscriptions(db: Db, userId: string): Promise<Subscription[]> {
  const { data, error } = await db.from("push_subscriptions").select("id, endpoint, p256dh, auth").eq("user_id", userId);
  if (error) throw error;
  return data;
}

// True if at least one subscription received the push: callers mark work done only then, so a
// failure on every subscription retries next run. send is null when the VAPID keys aren't set.
export async function sendToAllSubscriptions(db: Db, subscriptions: Subscription[], payload: unknown, send: SendPush | null) {
  if (!send) {
    console.log("Push keys (VAPID_*) are not set, so no notification was sent.");
    return false;
  }
  let delivered = false;
  for (const [i, sub] of subscriptions.entries()) {
    if (!pushEndpointOk(sub.endpoint)) {
      console.error(`Push skipped for subscription ${i + 1}/${subscriptions.length}: endpoint is no push service`);
      continue;
    }
    try {
      await send(sub, JSON.stringify(payload));
      delivered = true;
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) {
        // subscription dead (uninstalled, permission revoked): stop trying it
        await db.from("push_subscriptions").delete().eq("id", sub.id);
      } else if (status === 403) {
        // The push service refused this server's VAPID signature, not the subscription (H233
        // review): keys other than the ones the device subscribed with, a bad private key or
        // subject (Apple: BadJwtToken). Kept, so fixing the keys brings every device back; a
        // delete here would let one bad key wipe every user's devices.
        console.error(`Push refused for subscription ${i + 1}/${subscriptions.length}: HTTP 403, check that VAPID_* are the keys the devices subscribed with`);
      } else {
        console.error(`Push failed for subscription ${i + 1}/${subscriptions.length}: ${status ? `HTTP ${status}` : errorTag(err)}`);
      }
    }
  }
  return delivered;
}
