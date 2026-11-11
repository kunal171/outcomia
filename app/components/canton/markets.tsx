"use client";

import {
  CantonPageHeading,
  CantonDeploymentNotice,
  CantonUnavailable,
} from "./workspace";
import { CantonGuide } from "./order-preview";

export function CantonMarkets() {
  return (
    <>
      <CantonPageHeading title="Predictions">
        <CantonGuide />
      </CantonPageHeading>
      <CantonDeploymentNotice />
      <CantonUnavailable
        icon="market"
        title="Markets unavailable"
        description="Deployed Canton markets will appear here."
      />
    </>
  );
}
