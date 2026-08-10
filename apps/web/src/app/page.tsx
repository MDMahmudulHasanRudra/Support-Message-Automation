import { redirect } from "next/navigation";
import { getSession } from "@/server/auth";

export default async function Home() {
  const session = await getSession();
  redirect(session ? "/overview" : "/login");
}
