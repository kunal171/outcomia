"use client";
import Link from "next/link";
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { BrandMark } from "../workspace-brand";
import { DisplayPreferences } from "../display-preferences";
import { useI18n } from "../preferences-provider";
import { useReveal } from "../ui/use-reveal";
import { APP_HOME } from "../network-workspace";

const topics = [
  "Elections",
  "Football",
  "Crypto",
  "Interest rates",
  "Weather",
  "Box office",
  "AI",
  "Earnings",
  "Esports",
  "Science",
];

type Feature = {
  title: string;
  body: string;
  art: ReactNode;
  wide?: boolean;
  soon?: boolean;
};

function LaunchButton({ large = false }: { large?: boolean }) {
  const { t } = useI18n();
  return (
    <Link
      className={`ui-btn ui-btn-primary lp-launch${large ? " lp-launch-lg" : ""}`}
      href={APP_HOME}
    >
      {t("Launch app")}
      <span aria-hidden="true">→</span>
    </Link>
  );
}

/** Decorative: YES and NO orders converge on one dollar. */
function HeroArt() {
  const { t } = useI18n();
  return (
    <div
      className="lp-hero-art"
      role="img"
      aria-label={t(
        "Illustration: a YES order and a NO order meet at one dollar",
      )}
    >
      <div className="lp-ring" aria-hidden="true" />
      <div className="lp-ring lp-ring-2" aria-hidden="true" />
      <div className="lp-meet" aria-hidden="true">
        <span className="lp-bar lp-bar-yes">YES</span>
        <span className="lp-dollar">$1</span>
        <span className="lp-bar lp-bar-no">NO</span>
      </div>
    </div>
  );
}

function BookArt() {
  return (
    <div className="lp-art-book" aria-hidden="true">
      {[72, 54, 88, 40, 64].map((w, i) => (
        <span
          key={`b${i}`}
          className="yes"
          style={{ "--w": `${w}%`, "--i": i } as CSSProperties}
        />
      ))}
      <i />
      {[48, 80, 36, 66, 58].map((w, i) => (
        <span
          key={`s${i}`}
          className="no"
          style={{ "--w": `${w}%`, "--i": i } as CSSProperties}
        />
      ))}
    </div>
  );
}

function ChainsArt() {
  return (
    <div className="lp-art-chains" aria-hidden="true">
      <span>Solana</span>
      <i />
      <span>Canton</span>
    </div>
  );
}

function ResolveArt() {
  return (
    <div className="lp-art-resolve" aria-hidden="true">
      <span />
      <span />
      <span />
      <b>✓</b>
    </div>
  );
}

function ClubsArt() {
  return (
    <div className="lp-art-clubs" aria-hidden="true">
      {Array.from({ length: 7 }, (_, i) => (
        <span key={i} style={{ "--i": i } as CSSProperties} />
      ))}
    </div>
  );
}

function OutcomesArt() {
  return (
    <div className="lp-art-outcomes" aria-hidden="true">
      {[62, 24, 14].map((w, i) => (
        <span key={i} style={{ "--w": `${w}%`, "--i": i } as CSSProperties} />
      ))}
    </div>
  );
}

function StandardArt() {
  return (
    <div className="lp-art-standard" aria-hidden="true">
      <code>{"interface MarketFactory"}</code>
      <code>{"  create : Terms -> Market"}</code>
      <code>{"  policy : Eligibility"}</code>
    </div>
  );
}

function SettleArt() {
  return (
    <div className="lp-art-settle" aria-hidden="true">
      <span className="yes">YES</span>
      <i />
      <span className="no">NO</span>
    </div>
  );
}

function FeeArt() {
  const { t } = useI18n();
  return (
    <div className="lp-fee" aria-hidden="true">
      <div className="lp-fee-bar">
        <span className="lp-fee-platform" />
        <span className="lp-fee-club" />
      </div>
      <div className="lp-fee-legend">
        <span>{t("Platform")}</span>
        <span>{t("Club operator")}</span>
      </div>
    </div>
  );
}

export function Landing() {
  const { t } = useI18n(),
    root = useReveal<HTMLDivElement>(),
    [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 12);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const features: Feature[] = [
    {
      title: t("A real order book"),
      body: t(
        "Limit orders on YES and NO. Prices are set by traders, not a house.",
      ),
      art: <BookArt />,
      wide: true,
    },
    {
      title: t("Two chains, one app"),
      body: t(
        "Public speed on Solana. Private, institutional markets on Canton.",
      ),
      art: <ChainsArt />,
    },
    {
      title: t("Rules you can read"),
      body: t(
        "Published criteria, evidence and a review window before payout.",
      ),
      art: <ResolveArt />,
    },
    {
      title: t("Clubs"),
      body: t("Private communities with their own markets and members."),
      art: <ClubsArt />,
    },
    {
      title: t("Many outcomes"),
      body: t("Not just yes or no. Trade every candidate in one market."),
      art: <OutcomesArt />,
    },
    {
      title: t("Settles atomically"),
      body: t("Trades, fees and payouts settle together or not at all."),
      art: <SettleArt />,
    },
    {
      title: t("An open standard"),
      body: t(
        "Canton markets are created through an open-source factory anyone can run.",
      ),
      art: <StandardArt />,
      wide: true,
    },
  ];

  const steps = [
    [t("Pick a question"), t("Anything with a clear, checkable answer.")],
    [t("Buy YES or NO"), t("The price is the market's probability.")],
    [t("Collect $1"), t("Each winning contract pays one dollar.")],
  ];

  return (
    <div className="lp ui-standalone" ref={root}>
      <a className="lp-skip" href="#lp-main">
        {t("Skip to content")}
      </a>
      <header className={`lp-nav${scrolled ? " is-scrolled" : ""}`}>
        <div className="lp-nav-inner">
          <Link className="lp-brand" href="/" aria-label={t("Outcomia home")}>
            <BrandMark />
            <span>Outcomia</span>
          </Link>
          <nav className="lp-links" aria-label={t("Sections")}>
            <a href="#features">{t("Features")}</a>
            <a href="#how">{t("How it works")}</a>
            <a href="#creator-clubs">{t("Creator Clubs")}</a>
          </nav>
          <div className="lp-nav-actions">
            <DisplayPreferences />
            <LaunchButton />
          </div>
        </div>
      </header>

      <main id="lp-main">
        <section className="lp-hero" aria-labelledby="lp-title">
          <div className="lp-aurora" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
          <div className="lp-grid-bg" aria-hidden="true" />
          <div className="lp-hero-inner">
            <div className="lp-hero-copy">
              <p
                className="ui-eyebrow lp-in"
                style={{ "--d": 0 } as CSSProperties}
              >
                {t("Prediction markets on Solana and Canton")}
              </p>
              <h1 id="lp-title" className="lp-display">
                <span className="lp-in" style={{ "--d": 1 } as CSSProperties}>
                  {t("Every outcome")}
                </span>
                <span
                  className="lp-in lp-gradient"
                  style={{ "--d": 2 } as CSSProperties}
                >
                  {t("has a market.")}
                </span>
              </h1>
              <p className="lp-sub lp-in" style={{ "--d": 3 } as CSSProperties}>
                {t("Trade what you believe. Get paid when you're right.")}
              </p>
              <div
                className="lp-cta lp-in"
                style={{ "--d": 4 } as CSSProperties}
              >
                <LaunchButton large />
                <a
                  className="ui-btn ui-btn-ghost lp-launch-lg"
                  href="#features"
                >
                  {t("Explore features")}
                </a>
              </div>
            </div>
            <HeroArt />
          </div>
        </section>

        <div className="lp-marquee" aria-label={t("Market topics")}>
          <div className="lp-marquee-track">
            {[0, 1].map((copy) => (
              <ul key={copy} aria-hidden={copy === 1 || undefined}>
                {topics.map((topic) => (
                  <li key={topic}>{t(topic)}</li>
                ))}
              </ul>
            ))}
          </div>
        </div>

        <section
          id="features"
          className="lp-section"
          aria-labelledby="features-title"
        >
          <div className="lp-section-head" data-reveal>
            <p className="ui-eyebrow">{t("Features")}</p>
            <h2 id="features-title" className="lp-h2">
              {t("Everything a market needs.")}
            </h2>
          </div>
          <div className="lp-bento">
            {features.map((f, i) => (
              <article
                key={f.title}
                className={`lp-card${f.wide ? " lp-card-wide" : ""}`}
                data-reveal
                style={{ "--reveal-index": i % 3 } as CSSProperties}
              >
                <div className="lp-card-art">{f.art}</div>
                <h3>{f.title}</h3>
                <p>{f.body}</p>
              </article>
            ))}
          </div>
        </section>

        <section id="how" className="lp-section" aria-labelledby="how-title">
          <div className="lp-section-head" data-reveal>
            <p className="ui-eyebrow">{t("How it works")}</p>
            <h2 id="how-title" className="lp-h2">
              {t("Three steps. No house.")}
            </h2>
          </div>
          <ol className="lp-steps">
            {steps.map(([title, body], i) => (
              <li
                key={title}
                data-reveal
                style={{ "--reveal-index": i } as CSSProperties}
              >
                <span className="lp-step-n ui-num">0{i + 1}</span>
                <h3>{title}</h3>
                <p>{body}</p>
              </li>
            ))}
          </ol>
        </section>

        <section
          id="creator-clubs"
          className="lp-section lp-creator"
          aria-labelledby="creator-title"
        >
          <div className="lp-creator-copy" data-reveal>
            <p className="ui-eyebrow">
              {t("Creator Clubs")}{" "}
              <span className="ui-badge ui-badge-accent">
                {t("Coming soon")}
              </span>
            </p>
            <h2 id="creator-title" className="lp-h2">
              {t("Build a community. Earn from its markets.")}
            </h2>
            <ul className="lp-checks">
              <li>{t("Public, open or private clubs")}</li>
              <li>{t("Verified, staked operators")}</li>
              <li>{t("Fee sharing enforced on-chain")}</li>
              <li>{t("Independent resolution, never the operator")}</li>
            </ul>
          </div>
          <div
            className="lp-creator-art"
            data-reveal
            style={{ "--reveal-index": 1 } as CSSProperties}
          >
            <FeeArt />
          </div>
        </section>

        <section className="lp-final" aria-labelledby="final-title" data-reveal>
          <div className="lp-aurora lp-aurora-final" aria-hidden="true">
            <span />
            <span />
          </div>
          <h2 id="final-title" className="lp-h2 lp-final-title">
            {t("Your view. Your market.")}
          </h2>
          <LaunchButton large />
        </section>
      </main>

      <footer className="lp-footer">
        <span className="lp-brand">
          <BrandMark />
          <span>Outcomia</span>
        </span>
        <nav aria-label={t("Links")}>
          <a
            href="https://x.com/outcomia"
            target="_blank"
            rel="noopener noreferrer"
          >
            X ↗
          </a>
          <a
            href="https://github.com/kunal171/outcomia"
            target="_blank"
            rel="noreferrer"
          >
            GitHub ↗
          </a>
        </nav>
      </footer>
    </div>
  );
}
