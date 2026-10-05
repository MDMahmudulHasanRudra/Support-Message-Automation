import { MOOD_EMOJI, MOOD_LABELS, MOOD_LEVEL, MOOD_SIGNAL_LABELS, type Mood, type MoodSignal } from "@support-automation/shared";
import { Badge, type BadgeColor } from "@/components/ui";

/**
 * A customer's detected mood (Mood Detection). Always reads as an inference: the label says
 * "detected", and the reasons are the structured signals, never model reasoning.
 */
export function moodColor(mood: Mood): BadgeColor {
  const level = MOOD_LEVEL[mood];
  if (level >= 3) return "red";
  if (level >= 1) return "yellow";
  return mood === "POSITIVE" ? "green" : "gray";
}

export function MoodBadge({
  mood,
  confidence,
  signals,
  compact = false,
}: {
  mood: Mood;
  confidence?: number;
  signals?: MoodSignal[];
  compact?: boolean;
}) {
  const reasons = signals?.length ? signals.map((s) => MOOD_SIGNAL_LABELS[s]).join(", ") : null;
  const title = [`Detected mood: ${MOOD_LABELS[mood]}`, confidence !== undefined ? `${Math.round(confidence * 100)}% confidence` : null, reasons ? `Why: ${reasons}` : null]
    .filter(Boolean)
    .join(" · ");
  return (
    <span title={title} aria-label={title} className="inline-flex">
      <Badge color={moodColor(mood)}>
        <span aria-hidden>{MOOD_EMOJI[mood]}</span>
        {compact ? null : <span className="ml-1">{MOOD_LABELS[mood]}</span>}
      </Badge>
    </span>
  );
}
