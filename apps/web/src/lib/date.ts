// Server components render these with `Intl`/`Date#toLocaleString`, which follows the Node
// process's own timezone — not the business's. Pinning to Asia/Dhaka keeps displayed times
// correct regardless of what host/container the server happens to run on.
const TIME_ZONE = "Asia/Dhaka";

export function formatDateTime(date: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).format(date);
}

export function formatDate(date: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).format(date);
}

export function formatTime(date: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    hour: "numeric",
    minute: "numeric",
  }).format(date);
}
