import { Prisma } from "@prisma/client";

/**
 * Whether a write failed because a unique column already holds that value.
 *
 * The backstop behind every "is that name/number/email taken?" pre-check. A pre-check alone is a
 * race — two saves can both pass it in the same instant — and an uncaught P2002 in a Server Action
 * does not reach the form: it replaces the page with the error boundary. So an action that can
 * collide catches this and returns a sentence instead.
 */
export function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}
