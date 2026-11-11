"use client";

import {
  CantonPageHeading,
  CantonDeploymentNotice,
  CantonUnavailable,
} from "./workspace";
import { CantonGuide } from "./order-preview";

export function CantonOrders() {
  return (
    <>
      <CantonPageHeading title="Orders">
        <CantonGuide />
      </CantonPageHeading>
      <CantonDeploymentNotice />
      <CantonUnavailable
        icon="order"
        title="Orders unavailable"
        description="Your funded orders and cancellations will appear here."
      />
    </>
  );
}
