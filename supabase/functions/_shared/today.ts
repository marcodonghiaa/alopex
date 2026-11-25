/** The UTC calendar date (YYYY-MM-DD) n days before now. */
export const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

/** Today's calendar date (YYYY-MM-DD) in Europe/Rome, the zone the scheduled jobs use. */
export const romeToday = (now = new Date()) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Rome" }).format(now);
