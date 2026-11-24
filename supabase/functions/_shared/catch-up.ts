// Right after a bank's first sync, post-sync runs back to back instead of once per 6 hours: a
// 90-day first sync has more rows than one run sorts (~400 in its AI budget), and subscriptions
// need the categories first (e2e #7, #9, #13). Each round is queued through the database
// (queue_edge_job, pg_net), so no function waits for another. Round 0 is the cron run: it queues nothing.
export const MAX_ROUNDS = 10;

interface RoundResult {
  categorized: number;
  typed: number;
  splitwise: number;
  flows: number;
  transferPairs: number;
}

export function nextCatchUp(round: number, r: RoundResult): { job: "post-sync" | "detect-recurring"; round: number } | null {
  if (!(round >= 1)) return null;
  const didWork = r.categorized + r.typed + r.splitwise + r.flows + r.transferPairs > 0;
  if (didWork && round < MAX_ROUNDS) return { job: "post-sync", round: round + 1 };
  return { job: "detect-recurring", round: 0 };
}
