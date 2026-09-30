import { redirect } from "next/navigation";

export default function ConfigurationIndex() {
  redirect("/admin/configuration/employees");
}
