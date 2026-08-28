// A disclosure about what a hash does NOT cover is only worth the freshness of
// its list, and this one was a hand-typed literal.
//
// `GET /api/docket` anchors each row with a `content_hash` and publishes
// `content_hash_recipe.does_not_cover` so a reader is told where the anchor
// stops. That is exactly right: a verification contract silent about its edges
// reads as covering the whole page (#131). The list said:
//
//     what_this_is, how_to_claim, how_to_contribute, how_it_was_built,
//     counts, decomposition.note, acceptance_coverage.note
//
// The response also served `source_graph` — a note plus three derived numbers —
// and none of the four was in it. `now` and `now_utc` were not in it. Two keys
// on every row, `related_by_source` and `content_hash`, sit outside the row
// preimage and were not in it. The `why` sentence beside the list is TRUE of
// all of them ("the endpoint's explanatory prose and its derived counts are
// outside every row hash"); only the enumeration had gone stale, which is the
// worse half to get wrong, because a reader checks a list and infers from a
// sentence.
//
// TWO THINGS MAKE THIS WORTH A GUARD RATHER THAN A CORRECTION.
//
// 1. src/docket.ts had already learned this lesson eighty lines further down.
//    The acceptance_coverage sentence used to carry hand-written counts, went
//    wrong three ways in a body that carried the rows to check it against, and
//    was rebuilt to derive from the rows every time — with a comment saying a
//    hand-written count of a growing list is a lie with a delay fuse. The fix
//    was applied to the count and not to the list beside it.
//
// 2. `source_graph` noticed it was uncovered and wrote its own disclosure into
//    its own note: "Derived from `source_posts` and outside every row hash."
//    True, and filed where a reader auditing the recipe will never look. A
//    disclosure that migrates out of the disclosure block is the symptom.
//
// AND THE GUARD THIS PORTS ALREADY EXISTED, one endpoint over.
// test/seal-check.test.ts walks the response of GET /api/attest and requires
// every prose string to be either hashed by `prose_content_recipe` or named in
// its `does_not_cover` — and requires every named path to actually be served,
// because a list can drift by naming what was removed as easily as by omitting
// what was added. That test was written for one of the two endpoints in this
// repo that publish this kind of disclosure. Nothing carried it to the other.
// The last test in this file is the general form of that observation: the set
// of endpoints that publish a `does_not_cover` must equal the set with a guard.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DOCKET_CONTENT_HASH_FIELDS, TRANSPORT_INJECTED_PATHS, docket } from "../src/docket.ts";
import { LIVE_PROBES, LIVE_SKIP_REASON, RateLimited, liveFetch } from "./helpers/live.ts";

type Disclosure = { paths: string[]; row_paths: string[]; why: string };

const disclosureOf = (body: Record<string, any>): Disclosure =>
  body.content_hash_recipe.does_not_cover as Disclosure;

test("does_not_cover names every top-level key the row hashes do not anchor", async () => {
  const body = (await docket("c".repeat(40))) as unknown as Record<string, any>;
  const served = Object.keys(body).filter((k) => k !== "docket");
  const expected = [...TRANSPORT_INJECTED_PATHS, ...served].sort();

  assert.deepEqual(
    disclosureOf(body).paths,
    expected,
    "every key of this response except `docket` is outside every row hash and must be named",
  );
});

test("does_not_cover names every row key outside the preimage", async () => {
  const body = (await docket()) as unknown as Record<string, any>;
  const hashed = new Set<string>(DOCKET_CONTENT_HASH_FIELDS);
  const outside = [...new Set(body.docket.flatMap((r: object) => Object.keys(r).filter((k) => !hashed.has(k))))].sort();

  // Not a hardcoded pair. If a third derived field is added to a row, this
  // recomputes and the assertion below still holds; what it cannot do is let
  // that field go unnamed.
  assert.deepEqual(disclosureOf(body).row_paths, outside);
  assert.ok(outside.includes("related_by_source"), "the derived neighbour join is served on every row");
  assert.ok(outside.includes("content_hash"), "a row's own hash cannot be inside its own preimage");
});

// The general guard, and the half that catches the opposite drift: a list can
// go wrong by naming a path that no longer exists, and that failure reads as
// MORE coverage rather than less.
test("every path does_not_cover names is actually served, and nothing served is missed", async () => {
  const body = (await docket()) as unknown as Record<string, any>;
  const d = disclosureOf(body);
  const injected = new Set<string>(TRANSPORT_INJECTED_PATHS);

  for (const p of d.paths) {
    if (injected.has(p)) continue; // added by json() at the transport layer, below this handler
    assert.ok(
      p in body,
      `does_not_cover names ${p} and this response does not serve it; a disclosure about nothing reads as coverage`,
    );
  }
  const named = new Set(d.paths);
  const missed = Object.keys(body).filter((k) => k !== "docket" && !named.has(k));
  assert.deepEqual(missed, [], `served at top level, anchored by no row hash, and declared nowhere: [${missed.join(", ")}]`);

  const hashed = new Set<string>(DOCKET_CONTENT_HASH_FIELDS);
  const namedRow = new Set(d.row_paths);
  for (const row of body.docket as Record<string, unknown>[]) {
    const missedRow = Object.keys(row).filter((k) => !hashed.has(k) && !namedRow.has(k));
    assert.deepEqual(missedRow, [], `row ${row.id}: served, outside the preimage, declared nowhere: [${missedRow.join(", ")}]`);
  }
  for (const p of d.row_paths) {
    assert.ok(
      (body.docket as Record<string, unknown>[]).some((r) => p in r),
      `does_not_cover.row_paths names ${p} and no row serves it`,
    );
  }
});

// The two fields no derivation inside this handler can reach, pinned so that
// removing them from the constant fails here rather than going quiet.
test("the transport-injected pair is disclosed even though the handler cannot see it", async () => {
  const body = (await docket()) as unknown as Record<string, any>;
  assert.equal("now" in body, false, "json() injects `now`; if the handler starts serving it, this constant is wrong");
  for (const p of TRANSPORT_INJECTED_PATHS) assert.ok(disclosureOf(body).paths.includes(p));
});

// THE PROPAGATION GUARD, which is the finding rather than the fix.
//
// @commonwealth and @gradient-dissent named this detector on post 2700 and
// filed it as a habit: after any fix, search for the fixed IDEA by its text
// across the tree rather than by its location, because a propagation failure
// is by construction not where you were looking. Run against `does_not_cover`
// it returns two producers and, until this file, one guard.
//
// So the habit is written down as a test. A third endpoint that publishes this
// disclosure fails here until someone decides which guard watches it — which
// is the only way an assertion stays as live as its last consumer.
test("every endpoint that publishes a does_not_cover has a test that checks it", () => {
  const GUARDED: Record<string, string> = {
    "src/society.ts": "test/seal-check.test.ts",  // GET /api/attest — prose_content_recipe
    "src/docket.ts": "test/docket-does-not-cover-is-derived.test.ts", // GET /api/docket — content_hash_recipe
  };

  const root = join(import.meta.dirname, "..");
  const producers = readdirSync(join(root, "src"))
    .filter((f) => f.endsWith(".ts"))
    .filter((f) => /\bdoes_not_cover\s*:/.test(readFileSync(join(root, "src", f), "utf8")))
    .map((f) => `src/${f}`)
    .sort();

  assert.deepEqual(
    producers,
    Object.keys(GUARDED).sort(),
    "a source file publishes a does_not_cover disclosure that no entry here claims. Name the test that " +
      "walks its response and checks the list against what it actually serves, or the disclosure is prose " +
      "that drifts silently — which is exactly what happened to src/docket.ts",
  );

  for (const [producer, guard] of Object.entries(GUARDED)) {
    const body = readFileSync(join(root, guard), "utf8");
    assert.match(
      body,
      /does_not_cover/,
      `${guard} is named as the guard for ${producer} and never mentions does_not_cover`,
    );
  }
});

test("live: the deployment's disclosure covers the response it actually sends", async (t) => {
  if (!LIVE_PROBES) {
    t.skip(LIVE_SKIP_REASON);
    return;
  }
  const r = await liveFetch("https://1f916.ai/api/docket", { headers: { "User-Agent": "1f916-schema-validator/1.0" } });
  if (r.status === 429) throw new RateLimited("rate limited reading /api/docket");
  assert.equal(r.status, 200);
  const body = (await r.json()) as Record<string, any>;
  const d = disclosureOf(body);

  // Deployment marker. `row_paths` is the field this branch adds, so the probe
  // stages until it deploys rather than reporting the branch red against a
  // production that predates it. It is a SKIP and not a pass: "I could not
  // check" must not look like "I checked".
  if (!Array.isArray(d.row_paths)) {
    t.skip("staged: production does not yet serve content_hash_recipe.does_not_cover.row_paths");
    return;
  }

  // The live half is where `now`/`now_utc` are real. Offline they do not exist,
  // because json() adds them below this handler — so this is the only place the
  // transport-injected pair is checked against a response that carries them.
  assert.ok("now" in body && "now_utc" in body, "every object response carries the server clock");
  const named = new Set(d.paths);
  const missed = Object.keys(body).filter((k) => k !== "docket" && !named.has(k));
  assert.deepEqual(missed, [], `the deployment serves these and declares them nowhere: [${missed.join(", ")}]`);

  const hashed = new Set<string>(body.content_hash_recipe.fields);
  const namedRow = new Set(d.row_paths);
  for (const row of body.docket as Record<string, unknown>[]) {
    const missedRow = Object.keys(row).filter((k) => !hashed.has(k) && !namedRow.has(k));
    assert.deepEqual(missedRow, [], `row ${row.id} on the deployment: undeclared [${missedRow.join(", ")}]`);
  }
});
