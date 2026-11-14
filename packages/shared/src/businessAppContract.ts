import type { BusinessAppCapability, BusinessAppKey } from "./businessApps.js";

/**
 * The typed side of docs/BUSINESS_APP_INTEGRATION_CONTRACT.md. TYPES ONLY: no endpoint, path or address
 * is defined here, because the Commerce app has not published one. An adapter that implements this
 * interface against a real, published endpoint is the next step (WAITING FOR COMMERCE); until then the
 * host registers none, and every connection check answers NOT_AVAILABLE honestly.
 *
 * Money is integer minor units with an ISO 4217 currency, never a float. Every answer carries the time
 * the app produced it (`asOf`), so a caller can refuse stale data instead of quoting it.
 */

/** Errors an app (or the adapter on its behalf) may answer with. Never mapped to an empty success. */
export type BusinessAppErrorCode =
  | "NOT_AVAILABLE" // no adapter or endpoint exists yet for this app — not a failure of the app
  | "UNAUTHORIZED" // the app refused the host's credentials
  | "FORBIDDEN" // the scope does not cover this call
  | "NOT_FOUND"
  | "WORKSPACE_NOT_PROVISIONED"
  | "RATE_LIMITED"
  | "TIMEOUT" // the outcome is unknown; never read as "zero" or "none"
  | "UPSTREAM_ERROR"
  | "CONTRACT_MISMATCH"; // the app speaks a contract version this host does not

export interface BusinessAppError {
  code: BusinessAppErrorCode;
  /** A sentence safe to show a Main Admin. Never a stack trace, never a token. */
  message: string;
  retryable: boolean;
}

export type BusinessAppResult<T> = { ok: true; data: T; asOf: string } | { ok: false; error: BusinessAppError };

export interface Money {
  /** Integer minor units (e.g. paisa, cents). */
  amountMinor: string;
  currency: string;
}

export interface ProductSummary {
  productId: string;
  name: string;
  sku: string | null;
  price: Money | null;
  /** null = the app did not say. Never defaulted to true or false. */
  inStock: boolean | null;
}

export interface CommerceCapabilityRequests {
  "commerce.searchProducts": { query: string; limit: number };
  "commerce.getProductDetails": { productId: string };
  "commerce.getCurrentPrice": { productId: string; variantId?: string };
  "commerce.checkAvailability": { productId: string; variantId?: string; quantity: number };
  "commerce.getActiveOffers": { productId?: string };
  /** Only for a verified customer: the host passes the identity it verified, never a number someone typed. */
  "commerce.getOrderStatus": { orderReference: string; verifiedCustomer: { kind: "PHONE_E164"; value: string } };
}

export interface CommerceCapabilityResponses {
  "commerce.searchProducts": { products: ProductSummary[]; truncated: boolean };
  "commerce.getProductDetails": ProductSummary & { description: string | null; variants: Array<{ variantId: string; name: string; price: Money | null; inStock: boolean | null }> };
  "commerce.getCurrentPrice": { price: Money; validUntil: string | null };
  "commerce.checkAvailability": { available: boolean; quantityAvailable: number | null };
  "commerce.getActiveOffers": { offers: Array<{ offerId: string; title: string; description: string | null; endsAt: string | null }> };
  "commerce.getOrderStatus": { orderReference: string; status: string; updatedAt: string; trackingUrl: string | null };
}

/** The installation an adapter acts for. The external workspace id is what the app gave at provisioning. */
export interface BusinessAppInstallationRef {
  projectId: string;
  appKey: BusinessAppKey;
  externalWorkspaceId: string | null;
  contractVersion: string;
}

/** What a successful connection check proves: the app answered, for this workspace, on this contract. */
export interface VerifiedConnection {
  externalWorkspaceId: string;
  appContractVersion: string;
  verifiedAt: string;
}

/** A short-lived, single-use hand-off for one person to open the app (proposed OIDC-style launch). */
export interface LaunchTicket {
  /** The app's own sign-in URL carrying a single-use code — never a host session cookie or long-lived token. */
  redirectUrl: string;
  expiresAt: string;
}

export interface LaunchSubject {
  /** Stable per-installation pseudonymous id; the app maps it to its own user. */
  subject: string;
  displayName: string;
  /** Scopes the host grants for this launch. The app's own roles decide what the person may do there. */
  scopes: readonly string[];
}

export interface BusinessAppAdapter {
  readonly appKey: BusinessAppKey;
  verifyConnection(installation: BusinessAppInstallationRef): Promise<BusinessAppResult<VerifiedConnection>>;
  createLaunch(installation: BusinessAppInstallationRef, subject: LaunchSubject): Promise<BusinessAppResult<LaunchTicket>>;
  call<C extends BusinessAppCapability & keyof CommerceCapabilityRequests>(
    installation: BusinessAppInstallationRef,
    capability: C,
    request: CommerceCapabilityRequests[C],
  ): Promise<BusinessAppResult<CommerceCapabilityResponses[C]>>;
}

/** The answer for an app no adapter exists for yet. One wording everywhere. */
export function notAvailableError(appName: string): BusinessAppError {
  return {
    code: "NOT_AVAILABLE",
    message: `${appName} has not published its connection endpoint yet, so it cannot be connected. The installation stays waiting; nothing was sent anywhere.`,
    retryable: true,
  };
}
