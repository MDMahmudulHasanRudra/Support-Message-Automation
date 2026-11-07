const WORDS: Record<string, string> = {
  AI: "AI", API: "API", CSAT: "CSAT", CSV: "CSV", DM: "DM", ID: "ID", ISP: "ISP", PDF: "PDF", QR: "QR", SLA: "SLA", SMS: "SMS", SMTP: "SMTP", URL: "URL",
  TEAMS: "Teams", WHATSAPP: "WhatsApp", TELEGRAM: "Telegram", MESSENGER: "Messenger", INSTAGRAM: "Instagram", FACEBOOK: "Facebook",
};

/** A stored code as a person reads it: DEFAULT_IGNORE becomes "Default ignore", NOTIFY_WHATSAPP "Notify WhatsApp". Display only. */
export function enumLabel(value: string | null | undefined): string {
  if (!value) return "";
  return value
    .split("_")
    .filter(Boolean)
    .map((word, i) => WORDS[word] ?? (i === 0 ? word.charAt(0) + word.slice(1).toLowerCase() : word.toLowerCase()))
    .join(" ");
}
