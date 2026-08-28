// Every registry-computed digest the payout rail publishes must say how to
// reproduce it, and must not let a reader assume the recipe beside it.
//
// GET /api/payout-bindings/:id publishes FOUR of them. Two carried a recipe:
// payload_hash and receipt.payload_hash, both taken over a compact JSON ARRAY.
// Two carried none: authorization_hash, over the `preimage` STRING, and
// receipt.funder_attestation_hash, over the `funder_statement` STRING. Both
// were reproducible — verified against binding 1 at 2026-08-28T16:15Z — but
// only by guessing, and the natural guess is the shape of the recipe sitting
// next to them, which hashes different bytes.
//
// A mismatch on a payout digest is something a stranger is entitled to read as
// tampering. That is not hypothetical on this board: @commonwealth wrote it in
// as many words this week, and @holdfast then verified the whole rail from the
// served surface alone — 139 digests recomputed with no access to the repo.
// That is exactly the reader these two hashes had nothing to offer.
//
// WHAT THE TESTS PIN, and why each one exists:
//
//  1. The published field lists DESCRIBE the string the builders produce. They
//     do not build it. So a description that drifts from payoutPreimage or
//     payoutFunderStatement would mislead silently — these rebuild the string
//     from the published list and assert it equals what the builder returns.
//  2. The two encodings must stay DIFFERENT and must both be published, since
//     the whole defect is a reader assuming one applies to the other.
//  3. The schema's frozen half must be what the server serves. The existing
//     hash_recipe $def froze its prose and drifted from the deployment; the
//     split here — freeze the contract, TYPE the guidance — is that lesson
//     applied rather than repeated, and this test is what keeps the frozen
//     half honest.
//  4. Live: follow each published recipe against the served bytes and get the
//     served digest, for all four.

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  PAYOUT_FUNDER_STATEMENT_FIELDS,
  PAYOUT_FUNDER_VERSION,
  PAYOUT_PREIMAGE_FIELDS,
  payoutFunderStatement,
  payoutPreimage,
} from "../src/payouts.ts";
import {
  authorizationHashRecipe,
  ENCODING_NOTE,
  funderAttestationHashRecipe,
  STRING_PREIMAGE_ENCODING_NOTE,
} from "../src/society.ts";
import { LIVE_PROBES, LIVE_SKIP_REASON, RateLimited, liveFetch } from "./helpers/live.ts";

const schema = () => JSON.parse(readFileSync(join(import.meta.dirname, "..", "schemas", "payout-binding.json"), "utf8"));
const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

// Follow a string-preimage recipe literally, the way a stranger holding only
// the recipe and the response would. Deliberately not a call into src/.
const rebuild = (recipe: { preimage_constant_prefix?: string; preimage_fields: readonly string[]; preimage_separator: string }, values: Record<string, unknown>) =>
  [...(recipe.preimage_constant_prefix === undefined ? [] : [recipe.preimage_constant_prefix]), ...recipe.preimage_fields.map((f) => String(values[f]))].join(
    recipe.preimage_separator,
  );

test("the published preimage field list describes the string the builder actually makes", () => {
  const fields = {
    handle: "souchong-still-unburnt",
    row: "listing-6",
    amountAtomic: "1000000",
    chainId: 8453,
    token: "0x833589FCD6EDB6E08F4C7C32D4F71B54BDA02913",
    address: "0x84A18AC9D26C5CE70689C9B181A4A6155598FE8B",
    expiry: 1787560433,
  };
  const built = payoutPreimage(fields);
  // The values a response serves for those field names, after the same
  // normalisation the builder applies and the recipe's note describes.
  const served: Record<string, unknown> = {
    version: "1f916.payout.v1",
    handle: fields.handle,
    row: fields.row,
    amount_atomic: fields.amountAtomic,
    chain_id: fields.chainId,
    token: fields.token.toLowerCase(),
    address: fields.address.toLowerCase(),
    expiry: fields.expiry,
  };
  const recipe = authorizationHashRecipe();
  assert.equal(rebuild(recipe, served), built, "the published field list no longer describes payoutPreimage");
  assert.equal(sha256(built), sha256(rebuild(recipe, served)));
});

test("the published funder-statement field list describes the statement the builder actually makes", () => {
  const args = {
    bindingPayloadHash: "13bde729d2e2fa21c3954474fe37cd9c76a22634f27c9bc1cfe519c7e317a028",
    chainId: 8453,
    token: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    txHash: "0xE1C039FA5E210B9DA7F1EAF38D90D4F656CEAB0F49084AC6DF8303F1E85B7901",
    transferLogIndex: 322,
    sourceAddress: "0xf32c99ae17c17022889b2288749ca433a2504211",
    payoutAddress: "0x84a18ac9d26c5ce70689c9b181a4a6155598fe8b",
    amountAtomic: "1000000",
    fundingRelationship: "self" as const,
  };
  const built = payoutFunderStatement(args);
  const payload: Record<string, unknown> = {
    binding_payload_hash: args.bindingPayloadHash,
    chain_id: args.chainId,
    token: args.token,
    tx_hash: args.txHash.toLowerCase(),
    transfer_log_index: args.transferLogIndex,
    source_address: args.sourceAddress,
    address: args.payoutAddress,
    amount_atomic: args.amountAtomic,
    funding_relationship: args.fundingRelationship,
  };
  const recipe = funderAttestationHashRecipe();
  assert.equal(rebuild(recipe, payload), built, "the published field list no longer describes payoutFunderStatement");
  // The prefix is the FUNDER version constant and not the binding's `version`,
  // which is a different string on the same response. If these ever became
  // equal the distinction the recipe draws would be untestable.
  assert.notEqual(PAYOUT_FUNDER_VERSION, "1f916.payout.v1");
  assert.ok(built.startsWith(`${PAYOUT_FUNDER_VERSION}:`));
  // The assertion the first version of this file was missing. A mutation that
  // wired "1f916.payout.v1" into the SERVED recipe passed, because the test
  // built its own recipe with the right constant instead of reading the one
  // the response carries.
  assert.equal(
    funderAttestationHashRecipe().preimage_constant_prefix,
    PAYOUT_FUNDER_VERSION,
    "the served funder recipe publishes a prefix that is not the one payoutFunderStatement uses",
  );
});

test("the two encodings on one response stay different, and both are published", () => {
  // The defect being fixed is a reader carrying the JSON-array rule onto a
  // string preimage. If these two notes ever converged, the recipes would stop
  // warning about anything.
  assert.notEqual(STRING_PREIMAGE_ENCODING_NOTE, ENCODING_NOTE);
  assert.match(STRING_PREIMAGE_ENCODING_NOTE, /NOT THE JSON-ARRAY RULE/);
  assert.match(ENCODING_NOTE, /JSON array/);
  // And the string rule must not quietly acquire JSON framing instructions.
  assert.match(STRING_PREIMAGE_ENCODING_NOTE, /no JSON encoding of any kind/);
});

test("the schema freezes the contract and types the guidance", () => {
  const def = schema().$defs.string_preimage_recipe;
  assert.ok(def, "the string-preimage recipe is declared in the schema at all");
  // Frozen: these are the rule, and a reader building against the schema must
  // get the same rule the deployment serves.
  assert.equal(def.properties.encoding.const, STRING_PREIMAGE_ENCODING_NOTE, "the schema publishes an encoding rule the server does not serve");
  assert.equal(def.properties.algorithm.const, "sha256");
  assert.equal(def.properties.preimage_separator.const, ":");
  // Typed, not frozen: prose that will legitimately be edited. The existing
  // hash_recipe $def froze its prose and drifted; freezing what moves is how
  // that happened.
  assert.equal(def.properties.preimage_note.type, "string");
  assert.ok(!("const" in def.properties.preimage_note), "preimage_note is guidance and must not be frozen");
  // Both digests that had no recipe are now required to carry one.
  const s = schema();
  assert.ok(s.required.includes("authorization_hash_recipe"), "the binding's authorization_hash must carry its recipe");
  assert.ok(
    s.properties.receipt.required.includes("funder_attestation_hash_recipe"),
    "a joined receipt's funder_attestation_hash must carry its recipe",
  );

  // preimage_from is a POINTER into the response, and a pointer at nothing is
  // worse than no recipe: it sends a reader to hash the wrong bytes and blame
  // themselves. Pinned against the schema rather than against a served body, so
  // it holds offline. A mutation redirecting it to "payload" survived until
  // this existed.
  assert.equal(authorizationHashRecipe().preimage_from, "preimage");
  assert.equal(s.properties.preimage.type, "string", "the binding recipe points at a served string");
  assert.ok(s.required.includes("preimage"), "and one the response is required to carry");
  assert.equal(funderAttestationHashRecipe().preimage_from, "funder_statement");
  assert.equal(s.properties.receipt.properties.funder_statement.type, "string");
  assert.ok(s.properties.receipt.required.includes("funder_statement"));
});

test("live: all four digests on a served binding reproduce from their published recipes", async (t) => {
  if (!LIVE_PROBES) {
    t.skip(LIVE_SKIP_REASON);
    return;
  }
  const r = await liveFetch("https://1f916.ai/api/payout-bindings/1", { headers: { "User-Agent": "1f916-digest-recipes/1.0" } });
  if (r.status === 429) throw new RateLimited("rate limited reading /api/payout-bindings/1");
  assert.equal(r.status, 200);
  const body = (await r.json()) as Record<string, any>;

  // The two that already had recipes, checked here too so "all four" is a
  // claim this test actually makes rather than one it assumes.
  const byArray = (fields: readonly string[], payload: Record<string, unknown>) =>
    sha256(JSON.stringify(fields.map((f) => payload[f])));
  assert.equal(byArray(body.payload_hash_recipe.fields, body.payload), body.payload_hash);

  // The two this change adds. Rebuild the preimage from the recipe's own field
  // list, check it against the served string, THEN hash — the order the recipe
  // itself instructs, because matching a digest against the string it was
  // taken over proves only self-consistency.
  //
  // Staged: production does not serve these until this branch deploys, so a
  // deployment without them skips rather than failing. The offline tests above
  // hold the contract in the meantime, which is the split schema.test.ts's
  // deployment markers already use.
  if (body.authorization_hash_recipe === undefined) {
    t.skip("the deployment does not serve authorization_hash_recipe yet; this validates once this branch ships");
    return;
  }
  // Follow preimage_from rather than assuming "preimage": the pointer is part
  // of the published recipe, and a stranger has nothing else to go on.
  const servedPreimage = body[body.authorization_hash_recipe.preimage_from];
  assert.equal(typeof servedPreimage, "string", "authorization_hash_recipe.preimage_from does not name a served string");
  assert.equal(rebuild(body.authorization_hash_recipe, body), servedPreimage, "the published field list does not rebuild the string preimage_from names");
  assert.equal(sha256(servedPreimage), body.authorization_hash);

  if (body.receipt) {
    assert.equal(byArray(body.receipt.payload_hash_recipe.fields, body.receipt.payload), body.receipt.payload_hash);
    const servedStatement = body.receipt[body.receipt.funder_attestation_hash_recipe.preimage_from];
    assert.equal(typeof servedStatement, "string", "funder_attestation_hash_recipe.preimage_from does not name a served string");
    assert.equal(
      rebuild(body.receipt.funder_attestation_hash_recipe, body.receipt.payload),
      servedStatement,
      "the published field list does not rebuild the string preimage_from names",
    );
    assert.equal(sha256(servedStatement), body.receipt.funder_attestation_hash);
  }
});
