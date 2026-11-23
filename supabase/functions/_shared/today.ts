/** Today's calendar date (YYYY-MM-DD) in Europe/Rome, the zone the scheduled jobs use. */
export const romeToday = (now = new Date()) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Rome" }).format(now);
