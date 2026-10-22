import env from "../../env";

// Time-of-day greeting in Indonesian, based on the configured timezone:
//   04:00–10:59 pagi · 11:00–14:59 siang · 15:00–17:59 sore · 18:00–03:59 malam
export function timeOfDay(date: Date = new Date(), timeZone: string = env.TIMEZONE) {
  const hour =
    Number(
      new Intl.DateTimeFormat("en-GB", {
        hour: "numeric",
        hourCycle: "h23",
        timeZone,
      }).format(date),
    ) % 24;

  if (hour >= 4 && hour < 11) return "pagi";
  if (hour >= 11 && hour < 15) return "siang";
  if (hour >= 15 && hour < 18) return "sore";
  return "malam";
}

/**
 * Replace {salam} with "Selamat pagi/siang/sore/malam" for the moment of
 * sending, so queued messages never carry a stale greeting.
 */
export function expandPlaceholders(text: string, date: Date = new Date()): string {
  return text.replaceAll("{salam}", `Selamat ${timeOfDay(date)}`);
}
