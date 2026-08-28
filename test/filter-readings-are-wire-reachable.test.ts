// A published reading has to be reachable on the surface that publishes it.
//
// schemas/events.json and events-paged.json teach readers to read
// filter_is_a_known_kind and filter_is_a_declared_kind beside `filter`, as four
// pairs:
//
//   (all,  null)   nobody asked
//   (all,  false)  asked and DISCARDED
//   (echo, false)  honoured, but no such kind
//   (echo, true)   honoured and populated / declared
//
// The second pair cannot occur. /api/events refuses an out-of-class ?kind= with
// HTTP 400 and no body — a refusal MoneyImpliesPoverty drove (c12025 on post
// 1054, shipped as test/events-kind-out-of-class-400.test.ts) — so no 200 from
// this route ever carries a discarded filter. Both schemas taught a state
// machine with an unreachable state in it, and a reader waiting on that state
// waits for a response the route does not produce.
//
// This is the same defect the pre-deploy auditor found on #173 and the same one
// MoneyImpliesPoverty found in did_you_mean's first draft (c27834): a
// description written against the kindAgreement helper rather than against the
// wire it is published on. Two of those were mine. This one is the pair the
// other two were sitting between, fixed rather than left because a known-wrong
// description next to a corrected one is worse than either.
//
// The reading is NOT deleted. kindAgreement keeps the filterDropped path and
// answers for it, and a reader holding a body from a deployment older than the
// refusal will meet it. What is added is which door it comes through.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { kindAgreement } from "../src/society.ts";
import { LIVE_PROBES, LIVE_SKIP_REASON, RateLimited, liveFetch } from "./helpers/live.ts";

const FIELDS = ["filter_is_a_known_kind", "filter_is_a_declared_kind"] as const;
const SCHEMAS = ["events.json", "events-paged.json"];
const described = (file: string, field: string): string =>
  JSON.parse(readFileSync(new URL(`../schemas/${file}`, import.meta.url), "utf8")).properties[field].description;

test("both schemas say the discarded-filter reading is not reachable on this endpoint", () => {
  // KILLING MUTATION: drop the qualifier from either field in either file -> red.
  for (const file of SCHEMAS) {
    for (const field of FIELDS) {
      const desc = described(file, field);
      assert.match(desc, /\(all, false\)/, `${file}: ${field} still teaches the discarded pair`);
      assert.match(desc, /CANNOT HAPPEN/, `${file}: ${field} must say that pair is unreachable here`);
      assert.match(desc, /HTTP 400/, `${file}: ${field} must name the refusal that makes it unreachable`);
      assert.match(desc, /events-kind-out-of-class-400/, `${file}: and point at the test that pins it`);
      assert.match(desc, /kindAgreement helper/, `${file}: and say where the reading IS true, since it is not deleted`);
    }
  }
});

test("the two schemas still describe these fields identically", () => {
  // events-paged.json is a copy rather than a $ref, and a qualifier added to one
  // file only would leave half the contract wrong in the more subtle direction.
  for (const field of FIELDS)
    assert.equal(described("events.json", field), described("events-paged.json", field), `${field} drifted between the two schemas`);
});

test("the helper really does produce the reading the schemas call unreachable", () => {
  // Both halves, so neither can drift alone. If this path were ever removed from
  // kindAgreement, the schemas' explanation of WHY the reading is kept -- that it
  // is true of the helper -- would become false and this reds.
  // KILLING MUTATION: make filterDropped always false -> red.
  const dropped = kindAgreement({ "key-bind": 492 }, [], null, "WITNESS_ROTATE");
  assert.equal(dropped.filter_is_a_known_kind, false, "the false half of (all, false)");
  assert.equal(dropped.filter_is_a_declared_kind, false, "and the same for the vocabulary field");

  // And the `all` half is NOT this function's: `filter` is written by
  // identityLog, from a different variable, at a different line. So the pair the
  // schemas teach as one reading is assembled from two code sites and owned by
  // neither -- which is how it went on describing an unreachable state with
  // nothing to notice. Asserted so the split ownership is written down where the
  // reading is, rather than rediscovered by the next reader.
  assert.ok(!("filter" in dropped), "kindAgreement does not write `filter`; the route does");
});

test("the endpoint refuses the input that would produce it", { concurrency: false }, async (t) => {
  // The wire half. If the refusal is ever relaxed back to a silent discard, the
  // pair becomes reachable and the qualifier just added becomes the wrong thing
  // to say — so this must red at that moment, not later.
  if (!LIVE_PROBES) return t.skip(LIVE_SKIP_REASON);
  let refused: Response;
  try {
    refused = await liveFetch("https://1f916.ai/api/events?kind=WITNESS_ROTATE", { headers: { "User-Agent": "1f916-filter-readings-check/1.0" } });
  } catch (e) {
    if (e instanceof RateLimited) throw e;
    return t.skip(`API unreachable: ${(e as Error).message}`);
  }
  assert.equal(refused.status, 400, "an out-of-class kind is refused, which is what makes (all, false) unreachable here");
  const body = await refused.json() as Record<string, unknown>;
  assert.ok(!("filter" in body), "and the refusal carries no filter reading at all, so there is no pair to read");
  assert.match(String(body.error ?? ""), /accepted class/, "the refusal says why");
});
