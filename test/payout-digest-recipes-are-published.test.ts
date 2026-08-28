// The published recipe for a digest must be the recipe the server hashes by,
// and it must be followable by a stranger who has only the schema.
//
// It was neither. `schemas/payout-binding.json` froze `payload_hash_recipe`
// (and the receipt's) as a JSON Schema `const` reading
//
//     { algorithm: "sha256", encoding: "UTF-8 JSON array", fields: [...] }
//
// while GET /api/payout-bindings/:id has been serving five keys and a much
// longer `encoding`. `const` means exact equality, so every production answer
// on that route violated its own published contract — on the one field whose
// entire job is to tell a stranger how to reproduce a digest.
//
// WHY NOTHING CAUGHT IT, which is the part worth fixing rather than the typo:
//
//   1. schema.test.ts probed the LIST (/api/payouts) live and never the
//      DETAIL. The comment beside the list entry already says it — "a contract
//      nothing checks is prose" — and the same sentence was true of this
//      schema with nobody to write it.
//   2. The only local check was test/fixtures/payout-binding-detail.json,
//      which the repo writes itself. A fixture agreeing with a schema is one
//      hand agreeing with the other; it cannot falsify either. That fixture's
//      payload_hash is the literal string "aaaa…", so no recipe in it has ever
//      been followed by anything.
//
// AND THE TWO DROPPED PIECES WERE THE LOAD-BEARING ONES. The abridged
// `encoding` drops the warning that non-ASCII characters are NOT escaped —
// which does not raise an error when you get it wrong, it silently produces a
// different digest, and is the exact trap this repo warns strangers about
// elsewhere. The dropped `values_from` is what says `fields` names keys of
// `payload` rather than of the response body. Someone building against the
// schema instead of against a live response got neither, and a mismatch on a
// payout digest is something a stranger is entitled to read as tampering.
//
// The three-way pin below: schema ≡ source (offline), source ≡ deployment
// (the live probe added to schema.test.ts), and the published rule actually
// reproduces a digest when followed literally (both offline and live).

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ENCODING_NOTE, payloadHashRecipe } from "../src/society.ts";
import { PAYOUT_BINDING_HASH_FIELDS, PAYOUT_RECEIPT_HASH_FIELDS } from "../src/payouts.ts";
import { LIVE_PROBES, LIVE_SKIP_REASON, RateLimited, liveFetch } from "./helpers/live.ts";

const SCHEMA_DIR = join(import.meta.dirname, "..", "schemas");
const loadSchema = (name: string) => JSON.parse(readFileSync(join(SCHEMA_DIR, name), "utf8"));

// Follow a served recipe literally, the way a stranger with only this object
// would. Deliberately NOT a call into src/: a test that reproduced the digest
// by calling the same function that produced it would prove the code agrees
// with itself, which is what the fixture already did.
function digestByRecipe(recipe: { fields: readonly string[] }, payload: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(recipe.fields.map((f) => payload[f])), "utf8").digest("hex");
}

test("the recipe const each schema publishes is the recipe the server builds", () => {
  const schema = loadSchema("payout-binding.json");
  assert.deepEqual(
    schema.properties.payload_hash_recipe.const,
    JSON.parse(JSON.stringify(payloadHashRecipe(PAYOUT_BINDING_HASH_FIELDS))),
    "payout-binding.json publishes a payload_hash_recipe the server does not serve",
  );
  assert.deepEqual(
    schema.properties.receipt.properties.payload_hash_recipe.const,
    JSON.parse(JSON.stringify(payloadHashRecipe(PAYOUT_RECEIPT_HASH_FIELDS))),
    "payout-binding.json publishes a receipt payload_hash_recipe the server does not serve",
  );
});

// The general guard, written before the specific fix and wider than it: no
// schema anywhere may publish an abridged form of the encoding rule. The
// abridgement is what made the drift invisible — "UTF-8 JSON array" reads like
// a complete answer.
test("no schema abridges the encoding rule it publishes", () => {
  const found: string[] = [];
  const walk = (node: unknown, path: string) => {
    if (Array.isArray(node)) return node.forEach((v, i) => walk(v, `${path}[${i}]`));
    if (node === null || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key.endsWith("recipe") && value !== null && typeof value === "object" && "const" in (value as object)) {
        const recipe = (value as { const: Record<string, unknown> }).const;
        if (typeof recipe?.encoding === "string") {
          found.push(`${path}.${key}`);
          assert.equal(
            recipe.encoding,
            ENCODING_NOTE,
            `${path}.${key} publishes an encoding rule that is not the one the server serves; ` +
              `a shorter one is not a summary, it is a different rule, and the part that goes ` +
              `missing first is the non-ASCII escaping warning that fails silently`,
          );
        }
      }
      walk(value, `${path}.${key}`);
    }
  };
  for (const file of readdirSync(SCHEMA_DIR).filter((f) => f.endsWith(".json"))) walk(loadSchema(file), file);
  assert.ok(found.length >= 2, `expected to have checked some recipe consts, checked ${found.length}`);
});

// The offline half of "followable". A payload carrying a non-ASCII character
// in a hashed field, hashed by following the published const and nothing else.
test("the published recipe reproduces a digest when followed literally, non-ASCII included", () => {
  const recipe = loadSchema("payout-binding.json").properties.payload_hash_recipe.const;
  const payload: Record<string, unknown> = Object.fromEntries(recipe.fields.map((f: string) => [f, f]));
  // An em-dash inside a hashed field. This is not decoration: it is the whole
  // difference between the rule the schema used to publish and the rule the
  // server hashes by.
  payload.docket_acceptance = "hand it in twice — the comment and the submission";

  const byRecipe = digestByRecipe(recipe, payload);
  assert.match(byRecipe, /^[0-9a-f]{64}$/);

  // What a reader following the abridged rule would have got. JSON.stringify
  // does not escape non-ASCII; a library that does (Python's json.dumps by
  // default) hashes different bytes for identical content, and the old
  // `encoding: "UTF-8 JSON array"` did not say which was meant.
  const escaped = JSON.stringify(recipe.fields.map((f: string) => payload[f])).replace(
    /[^\x00-\x7f]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
  const byAbridgedReading = createHash("sha256").update(escaped, "utf8").digest("hex");
  assert.notEqual(
    byAbridgedReading,
    byRecipe,
    "if these agreed, the dropped escaping warning would be harmless and this test would be pointless",
  );
});

test("live: the deployment serves the recipe this schema publishes, and it reproduces the digest", async (t) => {
  if (!LIVE_PROBES) {
    t.skip(LIVE_SKIP_REASON);
    return;
  }
  const r = await liveFetch("https://1f916.ai/api/payout-bindings/1", {
    headers: { "User-Agent": "1f916-schema-validator/1.0" },
  });
  if (r.status === 429) throw new RateLimited("rate limited reading /api/payout-bindings/1");
  assert.equal(r.status, 200, "binding 1 is the oldest row on the rail and is expected to be readable");
  const body = (await r.json()) as Record<string, any>;

  const schema = loadSchema("payout-binding.json");
  assert.deepEqual(body.payload_hash_recipe, schema.properties.payload_hash_recipe.const);
  assert.equal(
    digestByRecipe(body.payload_hash_recipe, body.payload),
    body.payload_hash,
    "following the published recipe against the published payload must produce the published digest",
  );

  if (body.receipt) {
    assert.deepEqual(body.receipt.payload_hash_recipe, schema.properties.receipt.properties.payload_hash_recipe.const);
    assert.equal(
      digestByRecipe(body.receipt.payload_hash_recipe, body.receipt.payload),
      body.receipt.payload_hash,
      "the receipt recipe must reproduce the receipt digest too",
    );
  }
});
