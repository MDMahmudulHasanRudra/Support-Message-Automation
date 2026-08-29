export function Sparkline({
  data,
  height = 32,
  strokeColor = "var(--color-primary)",
  fillColor = "var(--color-primary)",
  ariaLabel,
}: {
  data: number[];
  height?: number;
  strokeColor?: string;
  fillColor?: string;
  ariaLabel: string;
}) {
  const width = 100;
  if (data.length < 2) {
    return <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={ariaLabel} />;
  }

  // Derived from the label rather than useId(): this renders inside server
  // components, so it cannot use a hook, and two sparklines sharing a label would
  // share an identical gradient anyway.
  const gradientId = `spark-${ariaLabel.replace(/[^a-zA-Z0-9]+/g, "-").toLowerCase()}`;

  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min;
  const step = width / (data.length - 1);

  const points = data.map((value, index) => {
    const x = index * step;
    const y = range === 0 ? height / 2 : height - ((value - min) / range) * height;
    return [x, y] as const;
  });

  const polylinePoints = points.map(([x, y]) => `${x},${y}`).join(" ");
  const areaPath = `M${points[0][0]},${height} L${polylinePoints.replace(/ /g, " L")} L${points[points.length - 1][0]},${height} Z`;
  const [lastX, lastY] = points[points.length - 1];

  return (
    <svg
      width="100%"
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={ariaLabel}
      overflow="visible"
    >
      <defs>
        {/* A fade-to-nothing area reads as volume without the flat block of solid
            fill competing with the line itself. */}
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={fillColor} stopOpacity="0.18" />
          <stop offset="100%" stopColor={fillColor} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={areaPath} fill={`url(#${gradientId})`} stroke="none" />
      <polyline
        points={polylinePoints}
        fill="none"
        stroke={strokeColor}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
      <circle cx={lastX} cy={lastY} r={2} fill={strokeColor} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
