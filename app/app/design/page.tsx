import type { Metadata } from "next";

export const metadata: Metadata = { title: "Outcomia | Design system" };

const colors = [
  ["--bg", "Page"],
  ["--surface-0", "Inset"],
  ["--surface-1", "Surface"],
  ["--surface-2", "Raised"],
  ["--ink", "Text"],
  ["--muted", "Secondary"],
  ["--accent", "Accent"],
  ["--yes", "YES"],
  ["--no", "NO"],
  ["--warn", "Warning"],
] as const;

const type = [
  ["--text-h1", "Page title", 600],
  ["--text-h2", "Section title", 600],
  ["--text-h3", "Group title", 600],
  ["--text-body", "Body text keeps a calm 1.55 line height.", 400],
  ["--text-small", "Labels and meta", 400],
] as const;

/** Living reference for docs/design-system.md: every token and primitive. */
export default function DesignPage() {
  return (
    <main className="ui-page ui-standalone">
      <header className="ui-page-head">
        <div>
          <p className="ui-eyebrow">Design system</p>
          <h1 className="ui-title">Outcomia, dark first</h1>
          <p className="ui-lead">
            Tokens and primitives every page composes. Source of truth:
            docs/design-system.md.
          </p>
        </div>
        <div className="ui-actions">
          <button className="ui-btn">Secondary</button>
          <button className="ui-btn ui-btn-primary">Primary action</button>
        </div>
      </header>

      <section className="ui-section">
        <div className="ui-section-head">
          <h2>Color</h2>
          <span className="ui-badge">AA checked</span>
        </div>
        <div className="ui-grid design-swatches">
          {colors.map(([token, label]) => (
            <div key={token} className="design-swatch">
              <span style={{ background: `var(${token})` }} />
              <strong>{label}</strong>
              <code className="ui-num">{token}</code>
            </div>
          ))}
        </div>
      </section>

      <section className="ui-section">
        <div className="ui-section-head">
          <h2>Type</h2>
        </div>
        <p className="design-display">Every outcome.</p>
        <ul className="ui-list">
          {type.map(([token, sample, weight]) => (
            <li key={token} className="ui-row">
              <span style={{ fontSize: `var(${token})`, fontWeight: weight }}>
                {sample}
              </span>
              <code className="ui-num ui-row-meta">{token}</code>
            </li>
          ))}
          <li className="ui-row">
            <span className="ui-num">0.62 · 1,250.00 USDC</span>
            <code className="ui-num ui-row-meta">.ui-num</code>
          </li>
        </ul>
      </section>

      <section className="ui-section">
        <div className="ui-section-head">
          <h2>Page anatomy</h2>
        </div>
        <div className="ui-split">
          <div>
            <div className="ui-tabs" role="tablist">
              <button role="tab" aria-selected="true">
                Trade
              </button>
              <button role="tab" aria-selected="false">
                Positions
              </button>
              <button role="tab" aria-selected="false">
                Rules
              </button>
            </div>
            <ul className="ui-list" style={{ marginTop: 24 }}>
              {["Open", "Review period", "Finalized"].map((state, i) => (
                <li key={state}>
                  <a className="ui-row" href="#anatomy">
                    <div>
                      <p className="ui-row-title">Example market row {i + 1}</p>
                      <p className="ui-row-meta">USDC · closes in 3 days</p>
                    </div>
                    <span
                      className={`ui-badge ${i === 0 ? "ui-badge-accent" : i === 1 ? "ui-badge-warn" : ""}`}
                    >
                      {state}
                    </span>
                  </a>
                </li>
              ))}
            </ul>
            <dl className="ui-dl" style={{ marginTop: 32 }}>
              <dt>Collateral</dt>
              <dd>USDC</dd>
              <dt>Closes</dt>
              <dd className="ui-num">2026-12-31 18:00 UTC</dd>
              <dt>Resolver</dt>
              <dd>Independent, with a review period</dd>
            </dl>
          </div>
          <aside id="anatomy">
            <div className="ui-card ui-card-accent">
              <h3 className="ui-h3">Ticket</h3>
              <div className="design-stack">
                <div className="design-pair">
                  <button className="ui-btn ui-btn-yes">YES 0.62</button>
                  <button className="ui-btn ui-btn-no">NO 0.38</button>
                </div>
                <label className="ui-field">
                  <span>Contracts</span>
                  <input className="ui-input ui-num" defaultValue="100" />
                </label>
                <label className="ui-field">
                  <span>Order type</span>
                  <select className="ui-select" defaultValue="limit">
                    <option value="limit">Limit</option>
                    <option value="market">Best price</option>
                  </select>
                </label>
                <div className="ui-stat">
                  <span>Payout if YES</span>
                  <strong>100.00</strong>
                </div>
                <button className="ui-btn ui-btn-primary ui-btn-block">
                  Place order
                </button>
              </div>
            </div>
          </aside>
        </div>
      </section>

      <section className="ui-section">
        <div className="ui-section-head">
          <h2>States</h2>
        </div>
        <div className="design-stack">
          <div className="ui-actions">
            <span className="ui-badge">Neutral</span>
            <span className="ui-badge ui-badge-accent">Live</span>
            <span className="ui-badge ui-badge-yes">YES won</span>
            <span className="ui-badge ui-badge-no">NO won</span>
            <span className="ui-badge ui-badge-warn">Review</span>
          </div>
          <p className="ui-notice">Transaction confirmed.</p>
          <p className="ui-notice" role="alert">
            The book could not be read. Retry before trading.
          </p>
          <div className="ui-empty">No markets yet.</div>
        </div>
      </section>
    </main>
  );
}
