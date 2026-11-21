import { assertEquals } from "jsr:@std/assert@1.0.19";
import { romeToday } from "./today.ts";

// Polish 1 #10: detect-recurring and refresh-recurring must agree on "today".
Deno.test("today is the calendar date in Europe/Rome, not UTC", () => {
  assertEquals(romeToday(new Date("2026-11-20T23:30:00Z")), "2026-11-21");
  assertEquals(romeToday(new Date("2026-07-01T21:59:00Z")), "2026-07-01");
});
