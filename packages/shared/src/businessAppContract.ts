import type { BusinessAppCapability, BusinessAppKey } from "./businessApps.js";

/**
 * The typed side of docs/BUSINESS_APP_INTEGRATION_CONTRACT.md. TYPES ONLY: no endpoint, path or address
 * is defined here. The adapter that speaks to a real app (Commerce: `commerceAppAdapter` in packages/db,
 * against Commerce's published v1 host contract) implements this interface; the host code above it never
 * learns a path.
 *
 * Money is integer minor units with an ISO 4217 currency, never a float. Every answer carries the time
 * the app produced it (`asOf`), so a caller can refuse stale data instead of quoting it.
 */

/** Errors an app (or the adapter on its behalf) may answer with. Never mapped to an empty success. */
export type BusinessAppErrorCode =
  | "NOT_AVAILABLE" // no adapter, endpoint or configuration exists yet for this app — not a failure of the app
  | "UNAUTHORIZED" // the app refused the host's credentials
  | "FORBIDDEN" // the scope does not cover this call, or the app says the connection is not active
  | "NOT_FOUND"
  | "WORKSPACE_NOT_PROVISIONED"
  | "WORKSPACE_MISMATCH" // the app answered for a different workspace than this installation is mapped to
  | "RATE_LIMITED"
  | "TIMEOUT" // the outcome is unknown; never read as "zero" or "none"
  | "UPSTREAM_ERROR"
  | "CONTRACT_MISMATCH"; // the app speaks a contract version (or a response shape) this host does not

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
  /** The "was" price, only when the app gives one higher than the price. */
  compareAtPrice?: Money | null;
  /** null = the app did not say. Never defaulted to true or false. */
  inStock: boolean | null;
  /** Units the app says can be sold now; null = not given. */
  quantityAvailable?: number | null;
  category?: string | null;
  brand?: string | null;
  shortDescription?: string | null;
}

export interface ActiveOffer {
  offerId: string;
  title: string;
  description: string | null;
  endsAt: string | null;
  /** The product it applies to, when the app names one; null = not product-specific (or not said). */
  productId?: string | null;
}

export interface CommerceCapabilityRequests {
  "commerce.searchProducts": { query: string; limit: number };
  "commerce.getProductDetails": { productId: string };
  "commerce.getCurrentPrice": { productId: string; variantId?: string };
  "commerce.checkAvailability": { productId: string; variantId?: string; quantity: number };
  "commerce.getActiveOffers": { productId?: string };
  /**
   * Only for a verified customer: the host passes the identity it verified, never a number someone typed.
   * `orderReference` null = the customer's most recent orders.
   */
  "commerce.getOrderStatus": { orderReference: string | null; verifiedCustomer: { kind: "PHONE_E164"; value: string } };
}

export interface OrderStatusSummary {
  orderReference: string;
  status: string;
  paymentStatus: string | null;
  fulfillmentStatus: string | null;
  placedAt: string | null;
  updatedAt: string;
  total: Money | null;
  trackingUrl: string | null;
}

export interface CommerceCapabilityResponses {
  "commerce.searchProducts": { products: ProductSummary[]; truncated: boolean };
  "commerce.getProductDetails": ProductSummary & {
    description: string | null;
    /** `price` is what a customer pays now (offers applied); `listPrice` the regular price before them. */
    variants: Array<{ variantId: string; name: string; price: Money | null; listPrice?: Money | null; inStock: boolean | null }>;
    offers: ActiveOffer[];
  };
  "commerce.getCurrentPrice": { price: Money; validUntil: string | null };
  "commerce.checkAvailability": { available: boolean; quantityAvailable: number | null };
  "commerce.getActiveOffers": { offers: ActiveOffer[] };
  /** Orders of the ONE customer whose stored number is the verified one; empty when none matches exactly. */
  "commerce.getOrderStatus": { orders: OrderStatusSummary[] };
}

/** The installation an adapter acts for. The external workspace id is what the app gave at provisioning. */
export interface BusinessAppInstallationRef {
  projectId: string;
  appKey: BusinessAppKey;
  externalWorkspaceId: string | null;
  contractVersion: string;
  /** The decrypted per-installation credential, server-side only, or null when none is held. */
  credential: string | null;
}

/** Who the host is, for the app's own mapping record. Ids only; no person, no secret. */
export interface HostProjectIdentity {
  hostCustomerId: string;
  hostProjectId: string;
  customerName: string | null;
  projectName: string;
}

/**
 * What a Main Admin asked for.
 *   PROVISION_NEW  — the app creates a new workspace for this project.
 *   LINK_EXISTING  — the app links a workspace it already has (its id, as the app's own admin sees it).
 *   RECHECK        — check an installation that already has a mapping and a credential.
 */
export type ConnectRequest =
  | { mode: "PROVISION_NEW"; currency: string | null }
  | { mode: "LINK_EXISTING"; externalWorkspaceId: string }
  | { mode: "RECHECK" };

/** A credential the app issued during a connection attempt. The host encrypts it BEFORE anything else happens. */
export interface IssuedCredential {
  secret: string;
  /** A non-secret prefix to recognise the key by (the app's own key prefix). */
  hint: string;
}

export interface ConnectContext {
  host: HostProjectIdentity;
  request: ConnectRequest;
  /**
   * Called the moment the app hands over a credential, before any further check: an app that shows a key
   * only once must not lose it because a later step failed. Throws if it could not be stored.
   */
  persistCredential(credential: IssuedCredential): Promise<void>;
}

/** What a successful connection check proves: the app answered, for this workspace, on this contract. */
export interface VerifiedConnection {
  externalWorkspaceId: string;
  appContractVersion: string;
  verifiedAt: string;
  externalTenantId?: string | null;
  externalConnectionId?: string | null;
}

/** A short-lived, single-use hand-off for one person to open the app. */
export interface LaunchTicket {
  /** The app's own sign-in URL carrying a single-use code — never a host session cookie or long-lived token. */
  redirectUrl: string;
  expiresAt: string;
  /**
   * SIGN_IN: the app recognises this person and signs them straight in. LINK: the app asks them to sign in to
   * their own account in the app once, which links the two; it never trusts the host's word alone.
   */
  mode?: "SIGN_IN" | "LINK";
}

export interface LaunchSubject {
  /** Stable per-installation pseudonymous id; the app maps it to its own user. */
  subject: string;
  displayName: string;
  /** Scopes the host grants for this launch. The app's own roles decide what the person may do there. */
  scopes: readonly string[];
  /** Which host project is asking: the app finds its connection from these, as when provisioning. */
  host: Pick<HostProjectIdentity, "hostCustomerId" | "hostProjectId">;
  /** A path inside the app to land on, already passed through `safeAppPath`. */
  path: string;
}

export interface BusinessAppAdapter {
  readonly appKey: BusinessAppKey;
  verifyConnection(installation: BusinessAppInstallationRef, context: ConnectContext): Promise<BusinessAppResult<VerifiedConnection>>;
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
