// Party profile lookups share one request per tick and are cached.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPartyProfiles } from "../lib/party-profiles.ts";

test("lookups in one tick share a request; results are cached", async () => {
  const calls = [];
  const lookup = createPartyProfiles(async (parties) => {
    calls.push(parties);
    return parties
      .filter((p) => p === "a::1220ab")
      .map((party) => ({ party, profile: { username: "ada" } }));
  });
  const [a, b, again] = await Promise.all([
    lookup("a::1220ab"),
    lookup("b::1220ab"),
    lookup("a::1220ab"),
  ]);
  assert.equal(a.username, "ada");
  assert.equal(b, null);
  assert.equal(again, a);
  assert.deepEqual(calls, [["a::1220ab", "b::1220ab"]]);
  await lookup("a::1220ab");
  assert.equal(calls.length, 1, "cached");
});

test("a failed lookup shows no name and is retried later", async () => {
  let fail = true;
  const lookup = createPartyProfiles(async (parties) => {
    if (fail) throw new Error("down");
    return parties.map((party) => ({ party, profile: { username: "ada" } }));
  });
  assert.equal(await lookup("a::1220ab"), null);
  fail = false;
  assert.equal((await lookup("a::1220ab")).username, "ada");
});
