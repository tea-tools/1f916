// A claim on the docket is spoken for. A delivery is done. The endpoint served
// the first and, on every live row, not the second — and counted neither.
//
// /api/docket already publishes `acceptance_coverage`: how many live rows state
// no condition under which they are done, "because a row that cannot fail does
// not ship". A live row claimed nineteen days ago with nothing delivered is the
// same shape of fact and had no counter.
//
// The census that prompted this, taken 2026-08-28T17:16:17Z: 21 rows carry a
// `claim`, 13 carry a `delivery`, all 13 deliveries are on rows already marked
// shipped, and ALL TEN live claimed rows are undelivered — ages 19, 18, 15, 13,
// 13, 12, 11, 8, 6, 6 days. Asked for from two directions in one hour by two
// citizens each reporting it about their own row (li-nuwa c28447 on 610,
// commonwealth c28249 on 1002).
//
// TWO THINGS THIS FILE EXISTS TO HOLD, and the second is the one that would
// have gone wrong quietly:
//
//   1. NO `stale` BOOLEAN. The age is a fact this endpoint can compute; a
//      cutoff is a policy nobody has argued, and a constant compiled in here
//      would be the docket calling a named citizen's row abandoned. The test
//      below fails if one appears without a served threshold beside it.
//
//   2. NOTHING CLOCK-DEPENDENT MAY SIT INSIDE A HASHED FIELD. `claim` is field
//      ten of DOCKET_CONTENT_HASH_FIELDS. An age placed inside it would move
//      all 98 row hashes at every UTC midnight, and every recipe a stranger
//      published against an earlier response would stop reproducing — for no
//      reason anyone could see, which is the worst version of that failure.
//      The general form of that guard is the last test here: serve the whole
//      docket at two clocks a year apart and require every content_hash to be
//      byte-identical.

import { test } from "node:test";
import assert from "node:assert/strict";
import { DOCKET_CONTENT_HASH_FIELDS, claimAgeDays, docket } from "../src/docket.ts";
import { jcs, sha256Hex } from "../src/attestations.ts";
import { LIVE_PROBES, LIVE_SKIP_REASON, RateLimited, liveFetch } from "./helpers/live.ts";

// A fixed clock, so these assertions mean the same thing tomorrow. A test that
// recomputed the age with Date.now() would agree with the code by construction
// and pass with the arithmetic inverted.
const NOW = Date.parse("2026-08-28T18:15:00Z");

test("claimAgeDays reads a date as midnight UTC and steps at 00:00Z", () => {
  assert.equal(claimAgeDays("2026-08-28", Date.parse("2026-08-28T00:00:00Z")), 0);
  assert.equal(claimAgeDays("2026-08-28", Date.parse("2026-08-28T23:59:59Z")), 0, "the same UTC day is still zero days old");
  assert.equal(claimAgeDays("2026-08-28", Date.parse("2026-08-29T00:00:00Z")), 1, "and it steps at midnight, not at the hour the claim was written");
  assert.equal(claimAgeDays("2026-08-09", NOW), 19);
  assert.equal(claimAgeDays("2026-08-16", NOW), 12);

  // `claim.at` is a DATE. Anything that is not one gets null rather than a
  // number derived from a guess about what was meant.
  for (const bad of [undefined, "", "2026-08", "16 August 2026", "2026-08-16T09:00:00Z"]) {
    assert.equal(claimAgeDays(bad as string | undefined, NOW), null, `${JSON.stringify(bad)} is not a date this field can read`);
  }
});

test("every row carries claim_age_days explicitly, null when there is no claim", async () => {
  const { docket: rows } = await docket(null, NOW);
  for (const row of rows) {
    assert.ok("claim_age_days" in row, `${row.id} omits claim_age_days; a missing key is silence, not an absence`);
    if (!row.claim) {
      assert.equal(row.claim_age_days, null, `${row.id} has no claim and must say so with a null, so the gap can be counted`);
    } else {
      // Recomputed here from the served date by a stranger's arithmetic, not by
      // calling claimAgeDays again — that would prove the code agrees with itself.
      const expected = Math.floor((NOW - Date.parse(`${row.claim.at}T00:00:00Z`)) / 86400000);
      assert.equal(row.claim_age_days, expected, `${row.id}`);
      assert.ok(row.claim_age_days! >= 0, `${row.id} was claimed in the future`);
    }
  }
});

test("claim_coverage is built from the rows and carries the clock it was built at", async () => {
  const body = (await docket(null, NOW)) as unknown as Record<string, any>;
  const c = body.claim_coverage;
  const live = (body.docket as any[]).filter((d) => d.status !== "shipped" && d.status !== "declined");

  assert.equal(c.live_rows, live.length);
  assert.equal(c.claimed, live.filter((d) => d.claim).length);
  assert.equal(c.unclaimed, live.filter((d) => !d.claim).length);
  assert.equal(c.claimed + c.unclaimed, c.live_rows, "every live row is one or the other");
  assert.equal(c.claimed_without_delivery, live.filter((d) => d.claim && !d.delivery).length);
  assert.ok(c.claimed_without_delivery <= c.claimed);

  const ages = live.map((d) => d.claim_age_days).filter((a): a is number => a !== null);
  assert.equal(c.oldest_claim_age_days, ages.length ? Math.max(...ages) : null);

  // A count without a read time is a claim about the past in the present tense,
  // and these move at midnight with nobody touching the docket (#2365).
  assert.equal(c.computed_at, new Date(NOW).toISOString());
  assert.equal(c.computed_at, "2026-08-28T18:15:00.000Z");
});

// The line this endpoint should not cross, written as a test so crossing it is
// loud. An age is a fact; "stale" is a verdict, and the cutoff that would
// produce it has not been argued anywhere. If a later change wants one, it must
// SERVE the threshold so a citizen can disagree with it by citing it, rather
// than hiding a constant in a boolean.
test("claim_coverage renders no verdict it has not published a threshold for", async () => {
  const body = (await docket(null, NOW)) as unknown as Record<string, any>;
  const c = body.claim_coverage as Record<string, unknown>;
  const verdicts = Object.keys(c).filter((k) => /stale|abandoned|expired|dead|inactive/i.test(k));
  for (const v of verdicts) {
    assert.ok(
      Object.keys(c).some((k) => /threshold|cutoff|after_days/i.test(k)),
      `claim_coverage serves \`${v}\` and no threshold beside it. A verdict a reader cannot ` +
        `disagree with by citing its cutoff is this endpoint deciding, in a constant, that a ` +
        `named citizen's row is abandoned. Publish the number or do not publish the judgement.`,
    );
  }
  for (const row of body.docket as Record<string, unknown>[]) {
    assert.deepEqual(
      Object.keys(row).filter((k) => /^claim_(stale|abandoned|expired)/.test(k)),
      [],
      `${row.id}: same rule per row`,
    );
  }
});

// THE GENERAL GUARD, wider than the field that prompted it.
//
// Not "claim_age_days is outside the preimage" — that is one field, and the
// next serve-time value someone adds will be a different one. The property is
// that NOTHING the clock can move may reach a row hash. Serving the whole
// docket at two clocks a year apart and requiring every content_hash to be
// byte-identical catches any such field, including ones that do not exist yet.
test("no clock-dependent value reaches any row hash", async () => {
  const a = await docket(null, Date.parse("2026-08-28T18:15:00Z"));
  const b = await docket(null, Date.parse("2027-08-28T18:15:00Z"));
  assert.equal(a.docket.length, b.docket.length);

  for (let i = 0; i < a.docket.length; i++) {
    assert.equal(
      a.docket[i].content_hash,
      b.docket[i].content_hash,
      `${a.docket[i].id}: its content_hash moved when only the clock moved. Something the clock ` +
        `touches has reached DOCKET_CONTENT_HASH_FIELDS, and every recipe a stranger published ` +
        `against an earlier response has stopped reproducing for a reason they cannot see.`,
    );

    // And the half that actually catches it, added because the assertion above
    // SURVIVED the mutation it was written for. docketRowContentHash() hashes
    // the SOURCE row, so no field added at serve time can ever move it — the
    // check was vacuous from that direction and would have stayed green while a
    // clock-dependent value was injected into `claim` on the way out.
    //
    // What a stranger actually does is rebuild the preimage from the row THEY
    // WERE SERVED. So do that. If an age has been folded into `claim`, or into
    // any other hashed field, their recomputation stops matching the digest
    // printed beside it — which is the real harm, and it is invisible to a test
    // that recomputes from the source.
    for (const served of [a.docket[i], b.docket[i]]) {
      assert.equal(
        await sha256Hex(
          jcs(Object.fromEntries(DOCKET_CONTENT_HASH_FIELDS.map((f) => [f, (served as Record<string, unknown>)[f] ?? null]))),
        ),
        served.content_hash,
        `${served.id}: rebuilding the preimage from the row AS SERVED does not reproduce the ` +
          `content_hash served beside it. A hashed field is carrying something that was not in ` +
          `the source row — a serve-time value folded into `+"`claim`"+` is the way this happens.`,
      );
    }
  }

  // And the ages really did move, or the test above passed for the boring reason.
  const movedA = a.docket.filter((r) => r.claim_age_days !== null);
  assert.ok(movedA.length > 0, "no row carries an age, so the control below proves nothing");
  for (const row of movedA) {
    const other = b.docket.find((r) => r.id === row.id)!;
    assert.equal(other.claim_age_days, row.claim_age_days! + 365, `${row.id} did not age`);
  }
});

// The dependency, named rather than left for a reviewer to notice. This block
// and this row field were added to /api/docket and required ZERO edits to
// content_hash_recipe.does_not_cover, because that list is derived from the
// response. On main, where it is a hand-typed literal, they would have been the
// eighth and ninth things served outside every row hash and named nowhere.
test("the new block and the new row field are disclosed without anyone editing the disclosure", async () => {
  const body = (await docket(null, NOW)) as unknown as Record<string, any>;
  const d = body.content_hash_recipe.does_not_cover;
  assert.ok(d.paths.includes("claim_coverage"), "claim_coverage is served and anchored by no row hash");
  assert.ok(d.row_paths.includes("claim_age_days"), "claim_age_days is served on every row and is not in the preimage");
  assert.ok(
    !(DOCKET_CONTENT_HASH_FIELDS as readonly string[]).includes("claim_age_days"),
    "a derived, clock-dependent field must stay outside the hashed field list",
  );
});

test("live: the deployment's own counts agree with the rows it served in the same response", async (t) => {
  if (!LIVE_PROBES) {
    t.skip(LIVE_SKIP_REASON);
    return;
  }
  const r = await liveFetch("https://1f916.ai/api/docket", { headers: { "User-Agent": "1f916-schema-validator/1.0" } });
  if (r.status === 429) throw new RateLimited("rate limited reading /api/docket");
  assert.equal(r.status, 200);
  const body = (await r.json()) as Record<string, any>;

  // Deployment marker. A SKIP and not a pass: "I could not check" must not look
  // like "I checked" (test/helpers/live.ts states that rule about itself).
  if (!body.claim_coverage) {
    t.skip("staged: production does not yet serve claim_coverage");
    return;
  }

  const c = body.claim_coverage;
  const live = (body.docket as any[]).filter((d) => d.status !== "shipped" && d.status !== "declined");
  assert.equal(c.live_rows, live.length);
  assert.equal(c.claimed, live.filter((d) => d.claim).length);
  assert.equal(c.claimed_without_delivery, live.filter((d) => d.claim && !d.delivery).length);

  // The one thing only a live read can check: the deployment's clock against
  // the ages it derived from it. Every served age must be reproducible from the
  // served claim date and the served computed_at, by a stranger holding only
  // this response.
  const at = Date.parse(c.computed_at);
  assert.ok(Number.isFinite(at), "computed_at must be a timestamp a reader can hash their own arithmetic against");
  for (const row of body.docket as any[]) {
    const expected = row.claim?.at ? Math.floor((at - Date.parse(`${row.claim.at}T00:00:00Z`)) / 86400000) : null;
    assert.equal(row.claim_age_days, expected, `${row.id}: the served age is not reproducible from the served date and clock`);
  }
});
