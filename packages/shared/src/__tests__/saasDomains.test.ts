import { describe, expect, it } from "vitest";
import {
  classifyHost,
  hostAllowsAdminPortal,
  hostAllowsProject,
  nextDomainStatus,
  normalizeHostname,
  requiredDnsRecords,
  validateCustomerHostname,
  type DomainCheckStep,
  type DomainSettingsView,
} from "../saasDomains.js";

const settings: DomainSettingsView = {
  hostRoutingEnabled: true,
  rootDomain: "udboy.com",
  adminHostnames: ["admin.udboy.com"],
  reservedLabels: ["sales"],
};
const domains = [
  { hostname: "zoventio.udboy.com", customerId: "c1", status: "ACTIVE" },
  { hostname: "customer2.udboy.com", customerId: "c2", status: "ACTIVE" },
  { hostname: "customer3.udboy.com", customerId: "c3", status: "VERIFIED" },
  { hostname: "pending.udboy.com", customerId: "c4", status: "PENDING" },
  { hostname: "off.udboy.com", customerId: "c5", status: "DISABLED" },
];

describe("normalizeHostname", () => {
  it("lower-cases and strips a port, a trailing dot and a pasted URL", () => {
    expect(normalizeHostname(" Customer2.UDBOY.com:443 ")).toBe("customer2.udboy.com");
    expect(normalizeHostname("customer2.udboy.com.")).toBe("customer2.udboy.com");
    expect(normalizeHostname("https://customer2.udboy.com/login")).toBe("customer2.udboy.com");
  });
  it("refuses what is not a hostname", () => {
    for (const bad of ["", "a b.com", "-x.com", "x-.com", "ex_ample.com", "[::1]", "a".repeat(64) + ".com", "ünicode.com", null, 42]) {
      expect(normalizeHostname(bad)).toBeNull();
    }
  });
});

describe("validateCustomerHostname", () => {
  it("Customer #1's address is an ordinary customer address; an admin address is never a customer's", () => {
    expect(validateCustomerHostname("zoventio.udboy.com", settings)).toEqual({ hostname: "zoventio.udboy.com" });
    expect(validateCustomerHostname("panel.other.com", { ...settings, adminHostnames: ["panel.other.com"] })).toHaveProperty("error");
  });
  it("accepts one label under the root domain, and another domain the customer owns", () => {
    expect(validateCustomerHostname("Customer2.udboy.com", settings)).toEqual({ hostname: "customer2.udboy.com" });
    expect(validateCustomerHostname("support.customer.com", settings)).toEqual({ hostname: "support.customer.com" });
  });
  it("refuses reserved labels (built-in and configured), deep subdomains, the root, admin hosts and infrastructure", () => {
    expect(validateCustomerHostname("admin.udboy.com", settings)).toHaveProperty("error");
    expect(validateCustomerHostname("www.udboy.com", settings)).toHaveProperty("error");
    expect(validateCustomerHostname("sales.udboy.com", settings)).toHaveProperty("error");
    expect(validateCustomerHostname("a.b.udboy.com", settings)).toHaveProperty("error");
    expect(validateCustomerHostname("udboy.com", settings)).toHaveProperty("error");
    expect(validateCustomerHostname("201.18.218.251", settings)).toHaveProperty("error");
    expect(validateCustomerHostname("localhost", settings)).toHaveProperty("error");
  });
});

describe("requiredDnsRecords", () => {
  it("names the record relative to the root domain, A for IPv4 and AAAA for IPv6", () => {
    expect(requiredDnsRecords("customer2.udboy.com", "udboy.com", ["201.18.218.251", "2001:db8::1"])).toEqual([
      { type: "A", name: "customer2", value: "201.18.218.251" },
      { type: "AAAA", name: "customer2", value: "2001:db8::1" },
    ]);
    expect(requiredDnsRecords("support.customer.com", "udboy.com", ["201.18.218.251"])[0]?.name).toBe("support.customer.com");
  });
});

describe("classifyHost", () => {
  it("with routing off, every hostname behaves as before", () => {
    expect(classifyHost("customer2.udboy.com", { ...settings, hostRoutingEnabled: false }, domains)).toEqual({ kind: "OPEN" });
    expect(classifyHost("anything.example", null, domains)).toEqual({ kind: "OPEN" });
  });
  it("infrastructure hosts stay open (health checks, Caddy's question)", () => {
    expect(classifyHost("127.0.0.1:8668", settings, domains)).toEqual({ kind: "OPEN" });
    expect(classifyHost("localhost:3000", settings, domains)).toEqual({ kind: "OPEN" });
  });
  it("an admin hostname is ADMIN only; Customer #1's address is that customer's only", () => {
    expect(classifyHost("admin.udboy.com", settings, domains)).toEqual({ kind: "ADMIN" });
    expect(classifyHost("ZOVENTIO.udboy.com", settings, domains)).toEqual({ kind: "CUSTOMER", customerId: "c1" });
    // A stray overlap (impossible through the forms) resolves to admin, never to customer data.
    expect(classifyHost("admin.udboy.com", settings, [...domains, { hostname: "admin.udboy.com", customerId: "c9", status: "ACTIVE" }])).toEqual({ kind: "ADMIN" });
  });
  it("an ACTIVE or VERIFIED customer domain opens that customer; PENDING, DISABLED and unknown open nothing", () => {
    expect(classifyHost("customer2.udboy.com", settings, domains)).toEqual({ kind: "CUSTOMER", customerId: "c2" });
    expect(classifyHost("customer3.udboy.com", settings, domains)).toEqual({ kind: "CUSTOMER", customerId: "c3" });
    expect(classifyHost("pending.udboy.com", settings, domains)).toEqual({ kind: "UNKNOWN" });
    expect(classifyHost("off.udboy.com", settings, domains)).toEqual({ kind: "UNKNOWN" });
    expect(classifyHost("evil.example", settings, domains)).toEqual({ kind: "UNKNOWN" });
    expect(classifyHost("", settings, domains)).toEqual({ kind: "OPEN" });
  });
});

describe("what a hostname may serve", () => {
  it("the admin portal: open and admin hosts only", () => {
    expect(hostAllowsAdminPortal({ kind: "OPEN" })).toBe(true);
    expect(hostAllowsAdminPortal({ kind: "ADMIN" })).toBe(true);
    expect(hostAllowsAdminPortal({ kind: "CUSTOMER", customerId: "c2" })).toBe(false);
    expect(hostAllowsAdminPortal({ kind: "UNKNOWN" })).toBe(false);
  });
  it("a customer host opens only its own project — for a Main Admin too", () => {
    const c2 = { kind: "CUSTOMER", customerId: "c2" } as const;
    expect(hostAllowsProject(c2, "c2", false)).toBe(true);
    expect(hostAllowsProject(c2, "c1", false)).toBe(false);
    expect(hostAllowsProject(c2, "c1", true)).toBe(false);
    expect(hostAllowsProject(c2, null, true)).toBe(false);
  });
  it("the admin host opens every project for a Main Admin and none for anybody else", () => {
    expect(hostAllowsProject({ kind: "ADMIN" }, "c2", true)).toBe(true);
    expect(hostAllowsProject({ kind: "ADMIN" }, "c2", false)).toBe(false);
    expect(hostAllowsProject({ kind: "ADMIN" }, null, false)).toBe(false);
  });
  it("an unknown host opens nothing; an open host everything", () => {
    expect(hostAllowsProject({ kind: "UNKNOWN" }, "c1", true)).toBe(false);
    expect(hostAllowsProject({ kind: "OPEN" }, "c1", false)).toBe(true);
  });
});

describe("nextDomainStatus", () => {
  const step = (key: DomainCheckStep["key"], ok: boolean): DomainCheckStep => ({ key, ok, detail: "" });
  const all = (https: boolean, dns = true) => [step("FORMAT", true), step("DNS", dns), step("REACHES_APP", dns), step("HTTPS", https)];
  it("ACTIVE needs every step; VERIFIED everything but HTTPS; otherwise PENDING", () => {
    expect(nextDomainStatus("PENDING", all(true))).toBe("ACTIVE");
    expect(nextDomainStatus("PENDING", all(false))).toBe("VERIFIED");
    expect(nextDomainStatus("PENDING", all(false, false))).toBe("PENDING");
  });
  it("a failed check never takes a live domain down, and never revives a disabled one", () => {
    expect(nextDomainStatus("ACTIVE", all(false, false))).toBe("ACTIVE");
    expect(nextDomainStatus("DISABLED", all(true))).toBe("DISABLED");
  });
});
