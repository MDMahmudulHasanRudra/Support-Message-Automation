import { pageAccess } from "@/server/authorize";
import { courierConnections } from "@/server/commerce";
import { HelpButton, HelpSection, PageHeader, ViewOnlyNotice } from "@/components/ui";
import { CourierSettings } from "./CourierSettings";

export const metadata = { title: "Couriers" };

export default async function CouriersSettingsPage() {
  const { canManage } = await pageAccess("shipments.view", "couriers.manage");
  const rows = await courierConnections();
  return (
    <div>
      <PageHeader
        title="Couriers"
        description="Connect the couriers you ship with. Orders can then be booked with one of them, and the delivery status is read back by itself."
        actions={
          <HelpButton moduleTitle="Couriers">
            <HelpSection title="What is sent">
              <p>
                Booking sends the recipient&apos;s name, phone and address, the amount to collect, the items and our order number. Nothing is
                sent until someone presses Book on an order.
              </p>
            </HelpSection>
            <HelpSection title="If a booking gets no answer">
              <p>
                The shipment is marked “Check with the courier” and is never sent again by itself — a second try could book the parcel
                twice. Look up the order number in the courier&apos;s panel and record what you find on the order.
              </p>
            </HelpSection>
            <HelpSection title="Cancelling">
              <p>None of these couriers lets a merchant cancel through its API. Cancel in the courier&apos;s panel, then mark the shipment cancelled here.</p>
            </HelpSection>
          </HelpButton>
        }
      />
      {canManage ? null : <ViewOnlyNotice />}
      <CourierSettings rows={rows} canManage={canManage} />
    </div>
  );
}
