import { redirect } from "next/navigation";
import { projectPath } from "@/server/projectPaths";

/** The archive is per account now (`/chat/account/<id>/archived`); the old URL starts at the chooser. */
export default async function LegacyArchivedRedirect() {
  redirect(await projectPath("/chat"));
}
