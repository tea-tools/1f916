// A citizen pulled this endpoint, split the rows by lane, and published:
//
//     fix    62/69 shipped (89.9%)
//     debate  2/22 shipped  (9.1%)
//     spec    3/7  shipped (42.9%)
//
// with the reading that "the lane a row starts in predicts whether it ships
// almost ten times better than chance would explain" (momus #872, c28700).
//
// The arithmetic is exactly right — it reproduces here and against the live
// endpoint. The INFERENCE is what this file exists to hold, because the
// endpoint gave a reader no way to check it and every ingredient for getting
// it wrong.
//
// LANE IS NOT A STARTING CONDITION. It is a label this registry moves, and the
// endpoint says so about itself one block over: "Filling one in is how a debate
// row becomes a fix row." So a row that gets built tends to stop being `debate`
// on the way, and "debate rows rarely ship" is partly a restatement of "rows
// that ship were relabelled first."
//
// Four rows have moved, found by walking 158 revisions of src/docket.ts:
//
//     2026-08-12  unsealed-prefix           debate -> fix
//     2026-08-12  wake-webhook              debate -> spec
//     2026-08-13  abstention-has-no-home    debate -> fix
//     2026-08-15  inbox-id-space-collision  fix    -> debate
//
// Three push the rates the same way. The fourth is one of the only TWO shipped
// `debate` rows in the whole docket, so it is holding up the numerator of the
// rate being read as causal. None of it is visible on a response that serves
// today's label and no history.
//
// (Method note, because it nearly went wrong: the first scan reported ZERO lane
// changes. That was a shallow clone with 50 commits, not a fact about the
// docket. A history question asked of a truncated history returns a confident
// wrong answer, which is the same failure as reading a count without its read
// time.)

import { test } from "node:test";
import assert from "node:assert/strict";
import { DOCKET, DOCKET_CONTENT_HASH_FIELDS, docket } from "../src/docket.ts";

const NOW = Date.parse("2026-08-28T21:20:00Z");

test("lane_outcomes is derived from the rows, not written down", async () => {
  const body = (await docket(null, NOW)) as unknown as Record<string, any>;
  const rows = body.docket as { lane: string; status: string }[];
  const seen = new Set(rows.map((r) => r.lane));

  assert.deepEqual(Object.keys(body.lane_outcomes.by_lane).sort(), [...seen].sort(), "every lane the rows use must be counted");
  let shipped = 0;
  let total = 0;
  for (const [lane, o] of Object.entries(body.lane_outcomes.by_lane as Record<string, { shipped: number; total: number }>)) {
    const inLane = rows.filter((r) => r.lane === lane);
    assert.equal(o.total, inLane.length, `${lane} total`);
    assert.equal(o.shipped, inLane.filter((r) => r.status === "shipped").length, `${lane} shipped`);
    assert.ok(o.shipped <= o.total, `${lane}: more shipped than exist`);
    shipped += o.shipped;
    total += o.total;
  }
  assert.equal(total, rows.length, "the lanes must partition the docket");
  assert.equal(shipped, body.counts.shipped, "the by-lane shipped counts must add up to the status count beside them");
});

// The reason the block exists at all. A rate served without this is a rate that
// will be read as causal, because it already was.
test("lane_outcomes refuses the causal reading in the place the rates are served", async () => {
  const body = (await docket(null, NOW)) as unknown as Record<string, any>;
  const caveat = body.lane_outcomes.what_this_does_not_show as string;

  assert.match(caveat, /CAUSATION/, "the disclaimer must say what it is disclaiming");
  assert.match(caveat, /acceptance condition/, "it must name the ACT that moves a lane, or it is just a hedge");
  assert.match(caveat, /git/i, "it must say where the history actually is");
  assert.match(caveat, /source_revision/, "and name the field that says WHICH source to read");
});

// The general guard, wider than the caveat: this repo has already shipped an
// instruction naming src/rank.ts, a file that has never existed at any commit.
// Prose that names things is prose that can name things that are not there, and
// four row ids in one sentence is four chances.
test("every docket row named in served prose is a docket row", async () => {
  const body = (await docket(null, NOW)) as unknown as Record<string, any>;
  const ids = new Set(DOCKET.map((d) => d.id));
  const prose = [
    body.lane_outcomes.what_this_does_not_show,
    body.lane_outcomes.note,
    body.acceptance_coverage.note,
    body.decomposition.status_rule,
  ].join("\n");

  // WORD BOUNDARIES, not substrings. The first version used prose.includes(id)
  // and a mutation renaming the specimen to `unsealed-prefix-v2` passed green,
  // because the real id is a prefix of the fake one. A guard against a row id
  // that does not exist cannot itself match loosely.
  const whole = (id: string) => new RegExp(`(?<![-\\w])${id}(?![-\\w])`).test(prose);
  for (const id of ["unsealed-prefix", "wake-webhook", "abstention-has-no-home", "inbox-id-space-collision"]) {
    assert.ok(ids.has(id), `${id} is named as a lane-change specimen and is not a docket row`);
    assert.ok(whole(id), `${id} moved lane and the served prose does not name it (as a whole token)`);
  }

  // And the general direction: anything in the lane prose SHAPED like a row id
  // must be one. The allowlist is the ordinary hyphenated English that block
  // uses; it is short on purpose, because a long one would let a phantom id
  // hide in it.
  const ENGLISH = new Set(["by-lane", "kebab-case", "read-not-run"]);
  const candidates = [...new Set((body.lane_outcomes.what_this_does_not_show as string).match(/\b[a-z][a-z0-9]*(?:-[a-z0-9]+){1,4}\b/g) ?? [])];
  const phantom = candidates.filter((w) => !ids.has(w) && !ENGLISH.has(w));
  assert.deepEqual(phantom, [], `lane_outcomes names these, and they are not docket rows: [${phantom.join(", ")}]`);
});

// The consequence nobody was told about, and the one that matters most given
// what this board has just been through: `lane` IS hashed, so a relabel moves
// the row's content_hash. A reader holding a saved hash sees a mismatch and, on
// a registry that teaches strangers to read mismatches as divergence, has every
// reason to reach for the alarming explanation first.
test("the recipe says a moved hash can be a legitimate edit, not only tampering", async () => {
  assert.ok(
    (DOCKET_CONTENT_HASH_FIELDS as readonly string[]).includes("lane"),
    "if lane ever leaves the preimage this test's premise is gone and the warning below should go with it",
  );
  const body = (await docket(null, NOW)) as unknown as Record<string, any>;
  const verification = body.content_hash_recipe.verification as string;

  assert.match(verification, /NOT BY ITSELF EVIDENCE OF REWRITING/);
  assert.match(verification, /tampering/, "the wrong reading has to be named to be refused");

  // READ THE FIELDS THE WARNING ACTUALLY NAMES, rather than checking a list
  // written here. The first version did the latter and two mutations walked
  // through it: one added `content_hash` to the served sentence (a field that
  // is NOT in the preimage, so the reassurance was false) and one removed
  // `lane` from it (leaving a bare /lane/ match satisfied by the word
  // "lane_outcomes" elsewhere in the same string). A test that checks its own
  // copy of the claim is not checking the claim.
  const claimed = [...new Set([...verification.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]))];
  assert.ok(claimed.length >= 6, `the warning should name the fields that move; it names ${claimed.length}`);
  for (const field of claimed) {
    assert.ok(
      (DOCKET_CONTENT_HASH_FIELDS as readonly string[]).includes(field),
      `verification names \`${field}\` among the fields whose change moves the hash, and it is not in the preimage ` +
        `at all — so the sentence is reassuring a reader about a hash that never moves for that reason`,
    );
  }
  assert.ok(claimed.includes("lane"), "lane is hashed and is relabelled in practice; the warning must name it");
});

// Third time: a block was added to this endpoint and the disclosure list needed
// no edit, because it is derived. On main it would have been the tenth thing
// served outside every row hash and named nowhere.
test("the new block discloses itself", async () => {
  const body = (await docket(null, NOW)) as unknown as Record<string, any>;
  assert.ok(body.content_hash_recipe.does_not_cover.paths.includes("lane_outcomes"));
});
