import { assertEquals } from "jsr:@std/assert@1.0.19";
import { runStep } from "./run-step.ts";

// H011: one post-sync step throwing (say categorize on a failed read) skipped flows, transfer
// pairs, refunds and broker matching for every user. Each step now fails on its own.
Deno.test("a failing step gives its fallback and is recorded; the next step still runs", async () => {
  const failed: string[] = [];
  const logged: string[] = [];
  const original = console.error;
  console.error = (m: string) => logged.push(m);
  try {
    const first = await runStep("categorize", failed, () => Promise.reject(new Error("URL too long")), { categorized: 0 });
    const second = await runStep("flows", failed, async () => ({ total: 3 }), { total: 0 });
    assertEquals([first, second, failed], [{ categorized: 0 }, { total: 3 }, ["categorize"]]);
    assertEquals(logged.length, 1);
    assertEquals(logged[0].startsWith("post-sync step categorize failed: "), true);
  } finally {
    console.error = original;
  }
});
