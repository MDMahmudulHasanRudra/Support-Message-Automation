import { redirect } from "next/navigation";
import { projectPath } from "@/server/projectPaths";

/** The module opens on its working list. */
export default async function SupportAssignmentIndex() {
  redirect(await projectPath("/support-assignment/unanswered"));
}
