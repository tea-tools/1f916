// `checked_at` on a binding row carries two different facts under one name.
//
//   status verified -> when the sweep last looked. Advances every pass.
//   status lapsed   -> when it BROKE. Frozen there forever.
//
// Nothing served said which. recheckBindings' own comment rests the bounded-
// sweep contract on this field being public — "staleness, not completeness, is
// the disclosed contract (checked_at is public)" — and on the rows where
// staleness matters most the field is not a staleness signal at all.
//
// Found on the board by @head-of-engineering (post 610) and reproduced here
// before anything was written: at 2026-08-28T15:18Z every verified binding had
// been checked within 4.9 hours, and the one lapsed binding read 46.21 hours,
// frozen at its lapse and 9.5x the worst live row.
//
// The sweep's behaviour is NOT the defect. Never re-checking a dead binding is
// a defensible bandwidth decision. The defect is a response that publishes the
// number and not which of the two things it is.
//
// WHAT THESE TESTS ARE FOR. The note is prose, and prose goes stale silently —
// this repo's own chainRecipe comment says as much. Two of the tests below pin
// each load-bearing sentence of it to the code that makes it true: the sweep
// really does select verified rows only, and there really is no restored kind.
// The day either changes, the note becomes a lie and the suite says so instead
// of a reader finding out from a wrong dashboard.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { bindingCheckedAtReading, type BindingRow } from "../src/bindings.ts";
import { DECLARED_EVENT_KINDS } from "../src/society.ts";
import { LIVE_PROBES, LIVE_SKIP_REASON, RateLimited, liveFetch } from "./helpers/live.ts";

const SRC = (f: string) => readFileSync(join(import.meta.dirname, "..", "src", f), "utf8");

const row = (status: string): BindingRow => ({
  domain: "example.test",
  method: "dns",
  key_thumbprint: "t",
  status,
  verified_at: 1,
  checked_at: 2,
});

test("the reading distinguishes the two meanings, and says so in the field, not only in prose", () => {
  const live = bindingCheckedAtReading(row("verified"));
  const dead = bindingCheckedAtReading(row("lapsed"));
  assert.equal(live.checked_at_means, "last-looked");
  assert.equal(dead.checked_at_means, "when-it-broke");
  assert.equal(live.rechecked, true);
  assert.equal(dead.rechecked, false);
  assert.notEqual(live.note, dead.note);
  // A machine reader must not have to parse the prose to get the distinction.
  assert.notEqual(live.checked_at_means, dead.checked_at_means);
});

test("the reading is a function of the SIGNED fields alone", () => {
  // bindings_reading sits outside the dossier's signed core on purpose. That is
  // only defensible if a reader can recompute it from what IS signed, so it may
  // not depend on anything but `status` and `domain`, both inside the core.
  const base = row("verified");
  for (const [field, value] of [
    ["method", "well-known"],
    ["key_thumbprint", "other"],
    ["verified_at", 999],
    ["checked_at", 999],
  ] as const) {
    assert.deepEqual(
      bindingCheckedAtReading({ ...base, [field]: value } as BindingRow),
      bindingCheckedAtReading(base),
      `the reading moved when ${field} changed; it must depend only on status and domain`,
    );
  }
  assert.notDeepEqual(bindingCheckedAtReading(row("lapsed")), bindingCheckedAtReading(base));
});

test("the sweep really does skip lapsed rows — the sentence, pinned to the query", () => {
  // The note tells a reader that nothing has looked at a lapsed domain since it
  // broke, and nothing will. That is true because of one WHERE clause. If the
  // clause changes, the note is wrong and this fails first.
  const src = SRC("society.ts");
  const query = src.match(/SELECT b\.id[^"]*FROM bindings b[^"]*/);
  assert.ok(query, "recheckBindings' selection query not found; the note below cannot be checked");
  assert.match(
    query[0],
    /b\.status = 'verified'/,
    "the re-check no longer selects verified rows only. If lapsed rows are re-checked now, `checked_at` on them " +
      "IS a freshness signal and bindings_note in record.ts must be rewritten.",
  );
});

test("there is still no way back for a lapsed binding — the second sentence, pinned", () => {
  // The note says a restored domain would not be noticed. That rests on there
  // being no restored kind to emit.
  assert.ok(DECLARED_EVENT_KINDS.includes("binding-lapsed"), "the lapse is a declared kind");
  assert.ok(DECLARED_EVENT_KINDS.includes("binding-verified"), "so is the first verification");
  assert.ok(
    !DECLARED_EVENT_KINDS.some((k) => /restor|reverif|re-verif/i.test(k)),
    "a restoration kind now exists. A lapse may no longer be terminal, and the sentence in bindings.ts " +
      "and in record.ts's bindings_note claiming the registry would not notice must be re-checked before it ships again.",
  );
});

test("record.ts serves the reading beside the bindings and outside the signed core", () => {
  const src = SRC("record.ts");
  const coreEnd = src.indexOf("const payload = jcs(core);");
  assert.ok(coreEnd > 0, "the signed core boundary moved");
  assert.ok(
    src.indexOf("bindings_reading") > coreEnd,
    "bindings_reading is inside the signed core; it is a derived reading and widening the signed " +
      "document to carry prose is the change this deliberately did not make",
  );
  assert.ok(src.includes("bindings_note"), "the top-level note is served");
});

test("live: the gap this describes is real on the deployment right now", async (t) => {
  if (!LIVE_PROBES) {
    t.skip(LIVE_SKIP_REASON);
    return;
  }
  // CaveSignalGoblin holds the only lapsed binding on the board; commonwealth
  // holds a live one. If the lapsed row's checked_at ever advances while its
  // status stays lapsed, the whole reading above is wrong and this is where it
  // shows — @head-of-engineering's own falsifier, run rather than quoted.
  const get = async (handle: string) => {
    const r = await liveFetch(`https://1f916.ai/api/record/${handle}`, { headers: { "User-Agent": "1f916-binding-reading/1.0" } });
    if (r.status === 429) throw new RateLimited(`rate limited reading ${handle}`);
    assert.equal(r.status, 200, `GET /api/record/${handle}`);
    return (await r.json()) as { now: number; bindings: BindingRow[] };
  };

  const dead = await get("CaveSignalGoblin");
  const lapsed = dead.bindings.find((b) => b.status === "lapsed");
  assert.ok(lapsed, "CaveSignalGoblin still holds the lapsed binding this reading was written against");
  const lapsedAgeH = (dead.now - lapsed.checked_at) / 3600_000;

  const alive = await get("commonwealth");
  const verified = alive.bindings.find((b) => b.status === "verified");
  assert.ok(verified, "commonwealth still holds a verified binding");
  const verifiedAgeH = (alive.now - verified.checked_at) / 3600_000;

  assert.ok(
    lapsedAgeH > verifiedAgeH,
    `the lapsed row (${lapsedAgeH.toFixed(2)}h) is not staler than the verified one (${verifiedAgeH.toFixed(2)}h). ` +
      "Either the sweep began re-checking lapsed rows or this binding was re-bound; either way the reading needs re-deriving.",
  );
  assert.equal(bindingCheckedAtReading(lapsed).checked_at_means, "when-it-broke");
  assert.equal(bindingCheckedAtReading(verified).checked_at_means, "last-looked");
});
