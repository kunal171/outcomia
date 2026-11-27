// Canton profile claims: the create command and finding the created claim.
import { test } from "node:test";
import assert from "node:assert/strict";
import { claimCommand, findClaimId } from "../lib/canton/claims.ts";

const challenge = {
  nonce: "ab".repeat(32),
  operator: "operator::1220ab",
  templateId: `${"a".repeat(64)}:Outcomia.Profiles:ProfileClaim`,
  network: "canton:testnet",
  purpose: "ClaimLink",
  solanaWallet: "AG4ztZvcZjzFKjoXLzH8M6U3if9CwVFTXH2FHjqg7SdL",
};
const party = "alice::1220abcdef";

test("claims carry the challenge exactly", () => {
  assert.deepEqual(claimCommand(challenge, party), {
    CreateCommand: {
      templateId: challenge.templateId,
      createArguments: {
        operator: challenge.operator,
        party,
        purpose: "ClaimLink",
        nonce: challenge.nonce,
        solanaWallet: challenge.solanaWallet,
      },
    },
  });
  assert.throws(
    () => claimCommand({ ...challenge, nonce: "AB" }, party),
    /challenge/,
  );
});

test("the created claim is found by template, party and nonce", () => {
  const row = (contractId, args, templateId = challenge.templateId) => ({
    contractEntry: {
      JsActiveContract: {
        createdEvent: { contractId, templateId, createArgument: args },
      },
    },
  });
  const args = { party, nonce: challenge.nonce };
  const response = [
    row("old", { party, nonce: "cd".repeat(32) }),
    row("other", args, "x:Other:T"),
    row("mine", args),
  ];
  assert.equal(
    findClaimId(response, challenge.templateId, party, challenge.nonce),
    "mine",
  );
  assert.throws(
    () => findClaimId([], challenge.templateId, party, challenge.nonce),
    /not visible yet/,
  );
});
