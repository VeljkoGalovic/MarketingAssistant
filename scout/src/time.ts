import { config } from "./config.ts";

/** Current hour in the configured timezone (e.g. Europe/Belgrade). */
export function hourInTimezone(date = new Date()): number {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: config.quiet.timezone,
    hour: "numeric",
    hour12: false,
  });
  return Number.parseInt(fmt.format(date), 10);
}

/** True between [start, end) — wraps midnight. 23:00–07:00 by default. */
export function isQuietHour(date = new Date()): boolean {
  const h = hourInTimezone(date);
  const { startHour, endHour } = config.quiet;
  if (startHour === endHour) return false;
  return startHour > endHour ? h >= startHour || h < endHour : h >= startHour && h < endHour;
}
