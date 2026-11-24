"use client";
import { useState, type ReactNode } from "react";
import { useI18n } from "./preferences-provider";

export type MarketTab = { id: string; label: string; content: ReactNode };

/**
 * The task tabs used on market pages (Trade / Your position / Rules &
 * outcome / Manage market), with the binary page's classes and keyboard
 * behaviour. Visited panels stay mounted, so switching tabs never discards
 * a pending signature or a half-filled form.
 */
export function MarketTabs({
  tabs,
  initial,
}: {
  tabs: MarketTab[];
  initial?: string;
}) {
  const { t } = useI18n();
  const [tab, setTab] = useState(initial ?? tabs[0]?.id);
  const [visited, setVisited] = useState<string[]>([tab]);
  const active = tabs.some((item) => item.id === tab) ? tab : tabs[0]?.id;
  const select = (next: string) => {
    setTab(next);
    setVisited((current) =>
      current.includes(next) ? current : [...current, next],
    );
  };
  return (
    <>
      <div
        className="prediction-task-tabs"
        role="tablist"
        aria-label={t("Prediction market sections")}
      >
        {tabs.map((item, index) => (
          <button
            key={item.id}
            id={`market-tab-${item.id}`}
            type="button"
            role="tab"
            aria-selected={active === item.id}
            aria-controls={`market-panel-${item.id}`}
            tabIndex={active === item.id ? 0 : -1}
            onClick={() => select(item.id)}
            onKeyDown={(event) => {
              const next =
                event.key === "ArrowRight"
                  ? (index + 1) % tabs.length
                  : event.key === "ArrowLeft"
                    ? (index + tabs.length - 1) % tabs.length
                    : event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? tabs.length - 1
                        : null;
              if (next !== null) {
                event.preventDefault();
                select(tabs[next].id);
                document.getElementById(`market-tab-${tabs[next].id}`)?.focus();
              }
            }}
          >
            {t(item.label)}
          </button>
        ))}
      </div>
      {tabs.map(({ id, content }) => (
        <section
          key={id}
          id={`market-panel-${id}`}
          role="tabpanel"
          aria-labelledby={`market-tab-${id}`}
          hidden={active !== id}
          tabIndex={0}
        >
          {(visited.includes(id) || active === id) && content}
        </section>
      ))}
    </>
  );
}
