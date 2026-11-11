"use client";

import Link from "next/link";
import { useI18n } from "./preferences-provider";

/** Brand assets stay independent of either chain's account readers. */
export function BrandMark() {
  return (
    <span className="brand-mark" aria-hidden="true">
      <svg className="outcomia-mark" viewBox="0 0 36 36" fill="none">
        <circle
          cx="17"
          cy="19"
          r="11"
          stroke="currentColor"
          strokeWidth="3.5"
        />
        <path
          d="M19 17 29 7m-7 0h7v7"
          stroke="currentColor"
          strokeWidth="3.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}

export function OutcomiaBrand() {
  const { t } = useI18n();
  return (
    <Link className="brand" href="/" aria-label={t("Outcomia home")}>
      <BrandMark />
      <span>Outcomia</span>
    </Link>
  );
}
