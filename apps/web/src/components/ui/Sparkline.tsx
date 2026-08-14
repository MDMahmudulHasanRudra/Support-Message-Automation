export function Sparkline({
  data,
  height = 32,
  strokeColor = "var(--color-primary)",
  fillColor = "var(--color-primary-soft)",
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

  return (
    <svg
      width="100%"
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={ariaLabel}
    >
      <path d={areaPath} fill={fillColor} stroke="none" />
      <polyline points={polylinePoints} fill="none" stroke={strokeColor} strokeWidth={2} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
