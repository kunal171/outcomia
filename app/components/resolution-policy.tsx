"use client";
import { useI18n } from "./preferences-provider";
import { RESOLUTION_RULES } from "../lib/resolution-policy";

export function ResolutionPolicy({
  chain,
}: {
  chain: keyof typeof RESOLUTION_RULES;
}) {
  const { t } = useI18n();
  return (
    <details className="resolution-policy">
      <summary>
        {chain === "solana"
          ? t("How resolution works on Solana")
          : t("How resolution works on Canton")}
      </summary>
      <ul>
        {RESOLUTION_RULES[chain].map((rule) => (
          <li key={rule}>{t(rule)}</li>
        ))}
      </ul>
    </details>
  );
}
