import { createHash } from "node:crypto";
import { Resolver } from "node:dns/promises";
import { validateCustomerHostname, type DomainCheckStep, type DomainSettingsView } from "@support-automation/shared";

/**
 * The checks behind a domain's "Check now" button (SAAS_PLATFORM_PLAN.md §3.5), each with a plain
 * explanation the admin can act on. Network access is injected so the tests never touch the
 * internet; production uses real DNS (public resolvers, not the server's own cache) and real HTTP.
 */

/** What `/api/platform/domain-check` answers for a domain: a hash of its own token, never the token. */
export function domainCheckAnswer(token: string): string {
  return createHash("sha256").update(`nexora-domain-check:${token}`).digest("hex");
}

export interface DomainNetwork {
  /** Every A and AAAA address the hostname resolves to (empty when none). */
  resolveAddresses(hostname: string): Promise<string[]>;
  /** GET `url`, following redirects; the body as text, or an error. Must validate TLS normally. */
  get(url: string, timeoutMs: number): Promise<{ status: number; body: string } | { error: string }>;
}

export const realNetwork: DomainNetwork = {
  async resolveAddresses(hostname) {
    const resolver = new Resolver({ timeout: 5_000, tries: 2 });
    resolver.setServers(["1.1.1.1", "8.8.8.8"]);
    const settle = async (fn: () => Promise<string[]>) => {
      try {
        return await fn();
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === "ENODATA" || code === "ENOTFOUND" || code === "ESERVFAIL" || code === "ENONAME") return [];
        throw err;
      }
    };
    const [v4, v6] = await Promise.all([settle(() => resolver.resolve4(hostname)), settle(() => resolver.resolve6(hostname))]);
    return [...v4, ...v6];
  },
  async get(url, timeoutMs) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), cache: "no-store", redirect: "follow" });
      return { status: res.status, body: (await res.text()).slice(0, 2_000) };
    } catch (err) {
      const cause = (err as { cause?: { code?: string; message?: string } }).cause;
      return { error: cause?.code ?? cause?.message ?? (err as Error).message };
    }
  },
};

export interface DomainToCheck {
  hostname: string;
  verificationToken: string;
}

export interface CheckSettings extends DomainSettingsView {
  publicIps: readonly string[];
}

/** Steps 1–3: format, DNS, reaches this app. Stops at the first failure (later steps would only repeat it). */
export async function checkDomainBase(domain: DomainToCheck, settings: CheckSettings, net: DomainNetwork): Promise<DomainCheckStep[]> {
  const steps: DomainCheckStep[] = [];

  const format = validateCustomerHostname(domain.hostname, { ...settings, adminHostnames: [] });
  if ("error" in format) return [{ key: "FORMAT", ok: false, detail: format.error }];
  if (settings.publicIps.length === 0) {
    return [{ key: "FORMAT", ok: false, detail: "The server's public IP is not set. Add it under Domains → Platform settings, then check again." }];
  }
  steps.push({ key: "FORMAT", ok: true, detail: "The hostname is valid and allowed." });

  let addresses: string[];
  try {
    addresses = await net.resolveAddresses(domain.hostname);
  } catch (err) {
    steps.push({ key: "DNS", ok: false, detail: `DNS could not be looked up right now (${(err as Error).message}). Try again in a minute.` });
    return steps;
  }
  const expected = settings.publicIps.join(", ");
  if (addresses.length === 0) {
    steps.push({ key: "DNS", ok: false, detail: `No DNS record found yet. Create an A record for ${domain.hostname} pointing to ${expected}. New records can take a few minutes (sometimes longer) to appear.` });
    return steps;
  }
  const foreign = addresses.filter((a) => !settings.publicIps.includes(a));
  if (foreign.length > 0) {
    steps.push({
      key: "DNS",
      ok: false,
      detail: `${domain.hostname} points to ${foreign.join(", ")}, not to this server (${expected}). Change the record at your domain provider${addresses.length > foreign.length ? " and remove the extra one" : ""}. If the domain is behind a CDN proxy (an orange cloud), switch it to DNS only.`,
    });
    return steps;
  }
  steps.push({ key: "DNS", ok: true, detail: `Points to ${addresses.join(", ")} — this server.` });

  const reach = await net.get(`http://${domain.hostname}/api/platform/domain-check`, 10_000);
  if ("error" in reach) {
    steps.push({ key: "REACHES_APP", ok: false, detail: `The server did not answer on http://${domain.hostname} (${reach.error}). Check that the reverse proxy forwards every hostname to the app (see the setup notes on this page).` });
    return steps;
  }
  if (reach.status !== 200 || reach.body.trim() !== domainCheckAnswer(domain.verificationToken)) {
    steps.push({
      key: "REACHES_APP",
      ok: false,
      detail: reach.status === 404
        ? `The request reached a server that does not know this domain (HTTP 404). The reverse proxy may be sending ${domain.hostname} to another application.`
        : `Something answered, but not this application (HTTP ${reach.status}). The reverse proxy may be sending ${domain.hostname} elsewhere.`,
    });
    return steps;
  }
  steps.push({ key: "REACHES_APP", ok: true, detail: "Requests to this address reach this application." });
  return steps;
}

/** Step 4: HTTPS with a valid certificate. The first request is what makes the proxy obtain one. */
export async function checkDomainHttps(domain: DomainToCheck, net: DomainNetwork): Promise<DomainCheckStep> {
  const res = await net.get(`https://${domain.hostname}/api/platform/domain-check`, 25_000);
  if ("error" in res) {
    const cert = /CERT|SSL|TLS|self.signed|UNABLE_TO_VERIFY/i.test(res.error);
    return {
      key: "HTTPS",
      ok: false,
      detail: cert
        ? `HTTPS is not ready: the certificate is not valid yet (${res.error}). The first certificate can take a minute — check again shortly. If it keeps failing, confirm the reverse proxy's on-demand TLS setting.`
        : `HTTPS did not answer (${res.error}). Check that port 443 is open and the reverse proxy is running.`,
    };
  }
  if (res.status !== 200 || res.body.trim() !== domainCheckAnswer(domain.verificationToken)) {
    return { key: "HTTPS", ok: false, detail: `HTTPS answered with HTTP ${res.status}, but not as this application. Check the reverse proxy configuration.` };
  }
  return { key: "HTTPS", ok: true, detail: "HTTPS works with a valid certificate." };
}

let activeNetwork: DomainNetwork = realNetwork;
/** The network the domain actions use. */
export function domainNetwork(): DomainNetwork {
  return activeNetwork;
}
/** Tests only: answer DNS and HTTP from a script instead of the internet. */
export function setDomainNetworkForTests(net: DomainNetwork | null): void {
  activeNetwork = net ?? realNetwork;
}
