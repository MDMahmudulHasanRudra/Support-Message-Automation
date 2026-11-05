import { Alert, SectionHeader, StatTile, Table, Td, Th } from "@/components/ui";
import {
  databaseWarnings,
  speedWarnings,
  type DatabaseFigures,
  type Percentiles,
  type ServerFigures,
  type SpeedFigures,
} from "@/server/platform/systemFigures";
import { formatBytes } from "./customers/[id]/CustomerHealthPanel";

/**
 * Server, speed and database figures on the platform overview (P1-08, docs/get-assist-ultimate/20 O5–O7).
 * Every warning threshold is a starting value (systemFigures.ts THRESHOLDS), not a measured capacity.
 */

const mb = (n: number | null | undefined) => (n == null ? "—" : n >= 1024 ? `${(n / 1024).toFixed(1)} GB` : `${Math.round(n)} MB`);
const seconds = (s: number | null | undefined) =>
  s == null ? "—" : s < 1 ? `${Math.round(s * 1000)} ms` : s < 120 ? `${s.toFixed(1)} s` : s < 7200 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`;
const trio = (p: Percentiles) => (p.count === 0 ? "no data" : `${seconds(p.p50)} / ${seconds(p.p95)}${p.p99 != null ? ` / ${seconds(p.p99)}` : ""}`);

function Findings({ items }: { items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div className="mb-3">
      <Alert tone="warning" title="Worth a look">
        <ul className="list-disc pl-5">
          {items.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      </Alert>
    </div>
  );
}

function Unreadable({ what }: { what: string }) {
  return (
    <div className="mb-8">
      <Alert tone="neutral" title={`Could not read the ${what} figures`}>
        The query did not answer in time or failed. The rest of the page is unaffected; reload to try again.
      </Alert>
    </div>
  );
}

function ServerSection({ server }: { server: ServerFigures }) {
  const s = server.stats;
  return (
    <>
      <Findings items={server.warnings} />
      {s ? (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatTile label="Server memory free" value={`${mb(s.host.freeMemMb)} of ${mb(s.host.totalMemMb)}`} hint={`${s.host.cpus} CPUs · load ${s.host.load1PerCpu ?? "—"} per CPU`} />
            <StatTile
              label="Worker container"
              value={s.container.memoryUsedMb == null ? "unavailable" : mb(s.container.memoryUsedMb)}
              hint={s.container.memoryLimitMb == null ? "no memory limit set" : `limit ${mb(s.container.memoryLimitMb)}`}
            />
            <StatTile
              label="Worker process"
              value={mb(s.worker.rssMb)}
              hint={`event-loop delay p99 ${s.worker.eventLoopP99Ms == null ? "—" : `${s.worker.eventLoopP99Ms} ms`} · up ${Math.round(s.worker.uptimeMinutes / 60)} h`}
            />
            <StatTile
              label="Disk free"
              value={s.disks.length === 0 ? "unavailable" : s.disks.map((d) => `${d.name} ${mb(d.freeMb)}`).join(" · ")}
              hint={s.disks.length ? `of ${mb(Math.max(...s.disks.map((d) => d.totalMb)))}` : undefined}
              tone={server.stale ? "warning" : "neutral"}
            />
          </div>
          <p className="mb-2 text-xs text-[color:var(--color-muted-foreground)]">
            Read {new Date(s.at).toLocaleString()}. WhatsApp browsers: {s.browsers.length}, {mb(s.browsers.reduce((sum, b) => sum + b.memoryMb, 0))} together.
          </p>
          {s.browsers.length > 0 ? (
            <div className="mb-8">
              <Table>
                <thead>
                  <tr>
                    <Th>WhatsApp account</Th>
                    <Th>Browser processes</Th>
                    <Th>Memory</Th>
                  </tr>
                </thead>
                <tbody>
                  {s.browsers.map((b, i) => (
                    <tr key={b.accountId ?? `orphan-${i}`}>
                      <Td>{b.accountId ? (server.accountLabels[b.accountId] ?? b.accountId) : <span className="font-medium">No account (orphaned browser)</span>}</Td>
                      <Td>{b.processes}</Td>
                      <Td>{mb(b.memoryMb)}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </div>
          ) : (
            <div className="mb-8" />
          )}
        </>
      ) : (
        <div className="mb-8" />
      )}
    </>
  );
}

function SpeedSection({ speed }: { speed: SpeedFigures }) {
  return (
    <>
      <Findings items={speedWarnings(speed)} />
      <div className="mb-4 grid grid-cols-1 gap-3 lg:grid-cols-2">
        <StatTile label="Incoming: sent → stored (p50 / p95 / p99)" value={trio(speed.inbound)} hint={`${speed.inbound.count.toLocaleString()} messages, live path`} />
        <StatTile label="WhatsApp sends: due → sent (p50 / p95)" value={trio(speed.outbound)} hint={`${speed.outbound.count.toLocaleString()} sends; includes the deliberate reply delay`} />
      </div>
      <div className="mb-4">
        <Table>
          <thead>
            <tr>
              <Th>Queue</Th>
              <Th>Due now</Th>
              <Th>Oldest due item waiting</Th>
              <Th>Failed (24 h)</Th>
            </tr>
          </thead>
          <tbody>
            {speed.queues.map((q) => (
              <tr key={q.name}>
                <Td>{q.name}</Td>
                <Td>{q.waiting.toLocaleString()}</Td>
                <Td>{seconds(q.oldestWaitingSeconds)}</Td>
                <Td>{q.failed24h.toLocaleString()}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </div>
      <p className="mb-8 text-xs text-[color:var(--color-muted-foreground)]">
        Slowest workspaces to store incoming messages (p95):{" "}
        {speed.slowestProjects.length === 0 ? "no data" : speed.slowestProjects.map((p) => `${p.name} ${seconds(p.p95)}`).join(" · ")}
      </p>
    </>
  );
}

function DatabaseSection({ database }: { database: DatabaseFigures }) {
  const c = database.connections;
  return (
    <>
      <Findings items={databaseWarnings(database)} />
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Connections" value={`${c.total} / ${c.max}`} hint={c.byState.map((s) => `${s.count} ${s.state}`).join(" · ")} />
        <StatTile label="Database size" value={formatBytes(database.sizeBytes)} />
        <StatTile label="Longest running query" value={seconds(database.oldestActiveQuerySeconds)} hint={`${database.idleInTransaction.count} idle in a transaction`} />
        <StatTile label="Cache hit ratio" value={database.cacheHitRatio == null ? "—" : `${(database.cacheHitRatio * 100).toFixed(1)}%`} />
      </div>
      <p className="mb-8 text-xs text-[color:var(--color-muted-foreground)]">
        Largest tables: {database.largestTables.map((t) => `${t.name} ${formatBytes(t.bytes)} (${t.rows.toLocaleString()} rows)`).join(" · ")}
      </p>
    </>
  );
}

export function SystemFigures({ server, speed, database }: { server: ServerFigures | null; speed: SpeedFigures | null; database: DatabaseFigures | null }) {
  return (
    <>
      <SectionHeader title="Server" description="The machine every customer shares, read by the worker once a minute." />
      {server ? <ServerSection server={server} /> : <Unreadable what="server" />}
      <SectionHeader title="Speed — last 24 hours" description="From messages and queues already stored; nothing extra is recorded." />
      {speed ? <SpeedSection speed={speed} /> : <Unreadable what="speed" />}
      <SectionHeader title="Database" description="Postgres's own statistics, read-only." />
      {database ? <DatabaseSection database={database} /> : <Unreadable what="database" />}
    </>
  );
}
