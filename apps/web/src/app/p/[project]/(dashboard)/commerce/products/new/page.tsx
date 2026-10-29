import { requireAccess } from "@/server/authorize";
import { listCategories } from "@/server/commerce";
import { ButtonLink, Card, PageHeader } from "@/components/ui";
import { ProductForm } from "../ProductForm";

export const metadata = { title: "New product" };

export default async function NewProductPage() {
  await requireAccess("commerce.manage");
  const categories = await listCategories();
  return (
    <div>
      <PageHeader title="New product" actions={<ButtonLink href="/commerce/products">Back to products</ButtonLink>} />
      <Card>
        <ProductForm categories={categories.map((c) => ({ id: c.id, name: c.name }))} />
      </Card>
    </div>
  );
}
