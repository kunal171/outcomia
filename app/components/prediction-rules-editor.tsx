"use client";

import { type PredictionRulesDraft } from "../lib/prediction-rules-draft";

interface Props {
  value: PredictionRulesDraft;
  creator: string;
  disabled: boolean;
  json: string | null;
  issue: string | null;
  onChange: (draft: PredictionRulesDraft) => void;
}

/** Named core fields keep the schema stable; custom key/value rules extend it. */
export function PredictionRulesEditor({
  value,
  creator,
  disabled,
  json,
  issue,
  onChange,
}: Props) {
  function set<K extends keyof PredictionRulesDraft>(
    key: K,
    field: PredictionRulesDraft[K],
  ) {
    onChange({ ...value, [key]: field });
  }
  function download() {
    if (!json) return;
    const url = URL.createObjectURL(
      new Blob([json], { type: "application/json" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = "prediction-rules.json";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <fieldset className="rules-editor" disabled={disabled}>
      <legend>
        <span className="section-marker" aria-hidden="true">
          02
        </span>{" "}
        Market rules
      </legend>
      <p className="rules-help">
        Start with these terms, then make the criteria specific to your
        question. All rules are public after upload.
      </p>
      <label>
        Full question
        <textarea
          required
          aria-label="Full question"
          value={value.question}
          onChange={(e) => set("question", e.target.value)}
          placeholder="Will the named event occur by the cutoff?"
          rows={2}
        />
      </label>
      <label>
        Description <small>Optional</small>
        <textarea
          aria-label="Description"
          value={value.description}
          onChange={(e) => set("description", e.target.value)}
          rows={2}
        />
      </label>
      <label>
        Authoritative resolution source
        <input
          required
          value={value.resolutionSource}
          onChange={(e) => set("resolutionSource", e.target.value)}
          placeholder="Source name and URL"
        />
      </label>
      {(
        [
          ["yesCriteria", "YES criteria"],
          ["noCriteria", "NO criteria"],
          ["invalidCriteria", "Invalid outcome criteria"],
          ["evidenceRequirements", "Evidence requirements"],
          ["conflictingEvidencePolicy", "Conflicting evidence policy"],
        ] as const
      ).map(([key, label]) => (
        <label key={key}>
          {label}
          <textarea
            required
            aria-label={label}
            value={value[key]}
            onChange={(e) => set(key, e.target.value)}
            rows={3}
          />
        </label>
      ))}
      <div className="rules-field-grid">
        <label>
          Trading close (local time)
          <input
            type="datetime-local"
            required
            value={value.closeTime}
            onChange={(e) => set("closeTime", e.target.value)}
          />
        </label>
        <label>
          Earliest resolution (local time)
          <input
            type="datetime-local"
            aria-label="Earliest resolution (local time)"
            value={value.earliestResolutionTime}
            onChange={(e) => set("earliestResolutionTime", e.target.value)}
          />
          <small>Optional; defaults to trading close.</small>
        </label>
      </div>
      <label>
        Review delay (seconds)
        <input
          type="number"
          min="1"
          step="1"
          required
          value={value.resolutionDelaySeconds}
          onChange={(e) => set("resolutionDelaySeconds", e.target.value)}
        />
      </label>
      <label>
        Primary resolver
        <input aria-label="Primary resolver" readOnly value={creator} />
        <small>
          The connected creator wallet will be the primary resolver.
        </small>
      </label>
      <label className="rules-checkbox">
        <input
          type="checkbox"
          checked={value.fallbackEnabled}
          onChange={(e) => set("fallbackEnabled", e.target.checked)}
        />
        Add a fallback resolver
      </label>
      {value.fallbackEnabled ? (
        <div className="rules-fallback">
          <label>
            Fallback resolver address
            <input
              required
              value={value.fallbackResolver}
              onChange={(e) => set("fallbackResolver", e.target.value)}
            />
          </label>
          <label>
            Fallback activation (local time)
            <input
              type="datetime-local"
              required
              value={value.fallbackAvailableTime}
              onChange={(e) => set("fallbackAvailableTime", e.target.value)}
            />
          </label>
          <label>
            Fallback proposal deadline (local time)
            <input
              type="datetime-local"
              aria-label="Fallback proposal deadline (local time)"
              value={value.fallbackDeadlineTime}
              onChange={(e) => set("fallbackDeadlineTime", e.target.value)}
            />
            <small>
              Optional. Without a deadline there is no automatic timeout
              outcome.
            </small>
          </label>
          <label>
            Fallback procedure
            <textarea
              required
              rows={2}
              value={value.fallbackProcedure}
              onChange={(e) => set("fallbackProcedure", e.target.value)}
            />
          </label>
          <p className="rules-help">
            Fallback activates only when no primary proposal exists at
            activation.{" "}
            {value.fallbackDeadlineTime
              ? "If no proposal exists by its deadline, the configured timeout outcome is Invalid."
              : "Otherwise positions may remain unresolved while waiting for a resolver."}
          </p>
        </div>
      ) : (
        <p className="rules-help">
          No fallback: only the creator can propose. There is no automatic
          timeout payout.
        </p>
      )}
      <div className="rules-section-heading">
        <h3>Additional rules</h3>
        <button
          type="button"
          className="admin-action-button"
          onClick={() =>
            set("additionalRules", [
              ...value.additionalRules,
              { id: crypto.randomUUID(), key: "", value: "", type: "text" },
            ])
          }
        >
          Add rule +
        </button>
      </div>
      {!value.additionalRules.length && (
        <p className="rules-help">
          Optional: add edge cases, reference links or other terms.
        </p>
      )}
      {value.additionalRules.map((row, index) => (
        <div className="rules-extra-row" key={row.id}>
          <label>
            Rule key
            <input
              required
              aria-label={`Rule ${index + 1} key`}
              value={row.key}
              placeholder="edgeCases"
              onChange={(e) =>
                set(
                  "additionalRules",
                  value.additionalRules.map((item) =>
                    item.id === row.id
                      ? { ...item, key: e.target.value }
                      : item,
                  ),
                )
              }
            />
          </label>
          <label>
            Value type
            <select
              aria-label={`Rule ${index + 1} value type`}
              value={row.type}
              onChange={(e) =>
                set(
                  "additionalRules",
                  value.additionalRules.map((item) =>
                    item.id === row.id
                      ? { ...item, type: e.target.value as "text" | "json" }
                      : item,
                  ),
                )
              }
            >
              <option value="text">Text</option>
              <option value="json">JSON (object, list, number…)</option>
            </select>
          </label>
          <label className="rules-extra-value">
            Rule value
            <textarea
              required
              aria-label={`Rule ${index + 1} value`}
              rows={2}
              value={row.value}
              onChange={(e) =>
                set(
                  "additionalRules",
                  value.additionalRules.map((item) =>
                    item.id === row.id
                      ? { ...item, value: e.target.value }
                      : item,
                  ),
                )
              }
            />
          </label>
          <button
            type="button"
            className="danger-button"
            aria-label={`Remove rule ${index + 1}`}
            onClick={() =>
              set(
                "additionalRules",
                value.additionalRules.filter((item) => item.id !== row.id),
              )
            }
          >
            Remove
          </button>
        </div>
      ))}
      {issue && (
        <p className="access-denied" role="alert">
          {issue}
        </p>
      )}
      <details className="rules-json-preview">
        <summary>Preview generated JSON</summary>
        <pre>{json ?? "Complete the highlighted rules to generate JSON."}</pre>
      </details>
      <button
        type="button"
        className="admin-action-button"
        disabled={!json}
        onClick={download}
      >
        Download JSON
      </button>
    </fieldset>
  );
}
