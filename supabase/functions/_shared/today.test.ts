import { assertEquals } from "jsr:@std/assert@1.0.19";
import { daysAgo, romeToday } from "./today.ts";

// Polish 1 #10: detect-recurring and refresh-recurring must agree on "today".
Deno.test("today is the calendar date in Europe/Rome, not UTC", () => {
  assertEquals(romeToday(new Date("2026-11-20T23:30:00Z")), "2026-11-21");
  assertEquals(romeToday(new Date("2026-07-01T21:59:00Z")), "2026-07-01");
});

Deno.test("daysAgo is the UTC date n days back", () => {
  const realNow = Date.now;
  Date.now = () => Date.parse("2026-03-01T00:30:00Z");
  try {
    assertEquals([daysAgo(0), daysAgo(1), daysAgo(90)], ["2026-03-01", "2026-02-28", "2025-12-01"]);
  } finally {
    Date.now = realNow;
  }
});
