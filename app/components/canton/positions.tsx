"use client";

import {
  CantonPageHeading,
  CantonDeploymentNotice,
  CantonUnavailable,
} from "./workspace";
import { CantonGuide } from "./order-preview";

export function CantonPositions() {
  return (
    <>
      <CantonPageHeading title="Positions">
        <CantonGuide />
      </CantonPageHeading>
      <CantonDeploymentNotice />
      <CantonUnavailable
        icon="position"
        title="Positions unavailable"
        description="Your YES and NO contracts will appear here."
      />
    </>
  );
}
