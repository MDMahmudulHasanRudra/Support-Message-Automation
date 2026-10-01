import { formatDurationShort } from "@/lib/duration";

/** Display formatting shared by every report, so a duration or a percentage reads the same everywhere. */

export const count = (n: number) => n.toLocaleString("en-US");

export const duration = (seconds: number | null) => (seconds === null ? "—" : seconds > 0 ? formatDurationShort(seconds) : "0m");

/** 0.8734 → "87.3%"; null (nothing to divide) → "—", never a made-up 0% or 100%. */
export const percent = (ratio: number | null) => (ratio === null ? "—" : `${(Math.round(ratio * 1000) / 10).toFixed(1)}%`);

export const when = (ms: number | null) =>
  ms === null
    ? "—"
    : new Intl.DateTimeFormat("en-GB", {
        timeZone: "Asia/Dhaka",
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(new Date(ms));

export const dateOnly = (ms: number | null) =>
  ms === null
    ? "—"
    : new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Dhaka", day: "numeric", month: "short", year: "numeric" }).format(new Date(ms));

/** A YYYY-MM-DD key as "Thu 10 Sep 2026". */
export const dayLabel = (key: string) => {
  const [y, m, d] = key.split("-").map(Number) as [number, number, number];
  return new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short", year: "numeric" }).format(
    new Date(Date.UTC(y, m - 1, d)),
  );
};

/** Minutes after midnight → "22:00". */
export const clock = (minute: number) => `${String(Math.floor(minute / 60) % 24).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;

export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

export const hourLabel = (hour: number) => `${String(hour).padStart(2, "0")}:00`;
