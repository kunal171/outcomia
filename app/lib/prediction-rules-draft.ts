/** Editable rules become one deterministic UTF-8 document for upload and hashing. */
export interface ExtraRule {
  id: string;
  key: string;
  value: string;
  type: "text" | "json";
}

export interface PredictionRulesDraft {
  question: string;
  description: string;
  resolutionSource: string;
  yesCriteria: string;
  noCriteria: string;
  invalidCriteria: string;
  evidenceRequirements: string;
  conflictingEvidencePolicy: string;
  closeTime: string;
  earliestResolutionTime: string;
  resolutionDelaySeconds: string;
  fallbackEnabled: boolean;
  fallbackResolver: string;
  fallbackAvailableTime: string;
  fallbackDeadlineTime: string;
  fallbackProcedure: string;
  additionalRules: ExtraRule[];
}

export const MAX_RULES_UPLOAD_BYTES = 64 * 1024;

/** These are starting terms, not a substitute for the creator's review. */
export function initialPredictionRulesDraft(): PredictionRulesDraft {
  return {
    question: "",
    description: "",
    resolutionSource: "",
    yesCriteria:
      "Resolve YES if the named source confirms the condition in the question was met by the stated cutoff.",
    noCriteria:
      "Resolve NO if the named source confirms the condition in the question was not met by the stated cutoff.",
    invalidCriteria:
      "Resolve Invalid if the event is cancelled or the outcome cannot be established using these rules.",
    evidenceRequirements:
      "Provide the source URL, observation time in UTC, and a copy or reference to the published result.",
    conflictingEvidencePolicy:
      "Use the named source as authoritative. Document any revisions and apply the same cutoff to both outcomes.",
    closeTime: "",
    earliestResolutionTime: "",
    resolutionDelaySeconds: "3600",
    fallbackEnabled: false,
    fallbackResolver: "",
    fallbackAvailableTime: "",
    fallbackDeadlineTime: "",
    fallbackProcedure:
      "The fallback resolver applies the same criteria and evidence requirements.",
    additionalRules: [],
  };
}

function unixSeconds(localTime: string, label: string): number | null {
  if (!localTime) return null;
  const milliseconds = new Date(localTime).getTime();
  if (!Number.isFinite(milliseconds) || milliseconds < 0)
    throw new Error(`${label} must be a valid date`);
  return Math.floor(milliseconds / 1000);
}

/** Inputs: editable draft and creator address. Returns the exact document text.
 * Dates are entered in the browser's local timezone and stored as Unix seconds.
 * Empty required fields remain visible in the preview; parsePredictionRules
 * rejects an incomplete document before upload. Optional policies stay null.
 * Custom fields are nested so they cannot replace protocol-critical terms.
 */
export function serializePredictionRulesDraft(
  draft: PredictionRulesDraft,
  creator: string,
): string {
  if (
    !/^\d+$/.test(draft.resolutionDelaySeconds) ||
    !Number.isSafeInteger(Number(draft.resolutionDelaySeconds)) ||
    Number(draft.resolutionDelaySeconds) <= 0
  )
    throw new Error("Review delay must be a positive whole number of seconds");
  const additionalRules: Record<string, unknown> = Object.create(null);
  for (const row of draft.additionalRules) {
    if (
      !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(row.key) ||
      ["__proto__", "constructor", "prototype"].includes(row.key)
    )
      throw new Error(
        "Additional rule keys must start with a letter and use up to 64 letters, digits, underscores or hyphens",
      );
    if (Object.hasOwn(additionalRules, row.key))
      throw new Error(`Duplicate rule key: ${row.key}`);
    if (!row.value.trim()) throw new Error(`Enter a value for ${row.key}`);
    if (row.type === "json") {
      try {
        additionalRules[row.key] = JSON.parse(
          row.value,
          (_key, value: unknown) => {
            if (
              typeof value === "number" &&
              (!Number.isFinite(value) ||
                (Number.isInteger(value) && !Number.isSafeInteger(value)))
            )
              throw new Error(
                "Use a string for numbers outside the safe JSON range",
              );
            return value;
          },
        );
      } catch {
        throw new Error(`Invalid JSON value for ${row.key}`);
      }
    } else additionalRules[row.key] = row.value;
  }
  const deadline = draft.fallbackEnabled
    ? unixSeconds(draft.fallbackDeadlineTime, "Fallback deadline")
    : null;
  const document = {
    schemaVersion: 1,
    question: draft.question,
    description: draft.description,
    resolutionSource: draft.resolutionSource,
    resolutionRules: {
      yesCriteria: draft.yesCriteria,
      noCriteria: draft.noCriteria,
      invalidCriteria: draft.invalidCriteria,
      evidenceRequirements: draft.evidenceRequirements,
      conflictingEvidencePolicy: draft.conflictingEvidencePolicy,
    },
    closeTimestamp: unixSeconds(draft.closeTime, "Trading close"),
    earliestResolutionTimestamp: unixSeconds(
      draft.earliestResolutionTime,
      "Earliest resolution",
    ),
    primaryResolver: creator,
    fallback: draft.fallbackEnabled
      ? {
          resolver: draft.fallbackResolver,
          availableTimestamp: unixSeconds(
            draft.fallbackAvailableTime,
            "Fallback activation",
          ),
          proposalDeadlineTimestamp: deadline,
          activation: "No primary proposal exists at the activation time",
          procedure: draft.fallbackProcedure,
          noProposalOutcome: deadline
            ? "Invalid after the proposal deadline"
            : "No automatic timeout; await resolver",
        }
      : null,
    resolutionDelaySeconds: Number(draft.resolutionDelaySeconds),
    ...(draft.additionalRules.length ? { additionalRules } : {}),
  };
  const json = JSON.stringify(document, null, 2) + "\n";
  if (new TextEncoder().encode(json).byteLength > MAX_RULES_UPLOAD_BYTES)
    throw new Error("Rules document exceeds the 64 KiB upload limit");
  return json;
}
