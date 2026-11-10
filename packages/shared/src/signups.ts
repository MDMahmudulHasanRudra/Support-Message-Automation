import { validateProjectSlug } from "./projects.js";

/** Public sign-up (SIGNUP.md): what a form must hold. Pure, so the form and the server read it alike. */

export const SIGNUP_VERIFY_HOURS = 48;
/** A form sent sooner than this after it was shown was not filled in by a person. */
export const SIGNUP_MIN_FILL_MS = 2500;
export const SIGNUP_FORM_MAX_AGE_MS = 6 * 3_600_000;

export interface SignupFields {
  businessName: string;
  ownerName: string;
  email: string;
  phone: string | null;
  slug: string;
}

export type SignupFieldErrors = Partial<Record<keyof SignupFields | "planId", string>>;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** A web address made from a business name; the person can change it. */
export function suggestSignupSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
}

export function readSignupFields(input: Record<string, unknown>): { fields: SignupFields } | { errors: SignupFieldErrors } {
  const text = (key: string, max: number) => (typeof input[key] === "string" ? (input[key] as string).trim().replace(/\s+/g, " ").slice(0, max) : "");
  const errors: SignupFieldErrors = {};
  const businessName = text("businessName", 120);
  const ownerName = text("ownerName", 120);
  const email = text("email", 200).toLowerCase();
  const phone = text("phone", 40);
  const slug = text("slug", 63).toLowerCase();
  if (businessName.length < 2) errors.businessName = "Enter your business name.";
  if (ownerName.length < 2) errors.ownerName = "Enter your name.";
  if (!EMAIL.test(email)) errors.email = "Enter a valid email address.";
  if (phone && !/^[+\d][\d\s()-]{6,}$/.test(phone)) errors.phone = "Enter a valid phone number, or leave it empty.";
  const slugError = validateProjectSlug(slug);
  if (slugError) errors.slug = slugError;
  return Object.keys(errors).length ? { errors } : { fields: { businessName, ownerName, email, phone: phone || null, slug } };
}
