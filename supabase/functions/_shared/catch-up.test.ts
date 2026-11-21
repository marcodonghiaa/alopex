import { assertEquals } from "jsr:@std/assert@1.0.19";
import { MAX_ROUNDS, nextCatchUp } from "./catch-up.ts";

const idle = { categorized: 0, typed: 0, splitwise: 0, flows: 0, transferPairs: 0 };

Deno.test("catch-up: a round that still did work runs post-sync again (e2e #9)", () => {
  assertEquals(nextCatchUp(1, { ...idle, categorized: 400 }), { job: "post-sync", round: 2 });
  assertEquals(nextCatchUp(3, { ...idle, typed: 40 }), { job: "post-sync", round: 4 });
});

Deno.test("catch-up: a round with nothing left finds subscriptions next (e2e #13)", () => {
  assertEquals(nextCatchUp(2, idle), { job: "detect-recurring", round: 0 });
});

Deno.test("catch-up: never more than MAX_ROUNDS, then subscriptions anyway", () => {
  assertEquals(nextCatchUp(MAX_ROUNDS, { ...idle, categorized: 400 }), { job: "detect-recurring", round: 0 });
});

Deno.test("catch-up: the 6-hour cron run (no round) queues nothing", () => {
  assertEquals(nextCatchUp(0, { ...idle, categorized: 400 }), null);
});
