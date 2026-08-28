// The spelling verdict is true and useless.
//
// #173 split the two zeroes at /api/events: a name that is declared but
// unexercised answers declared_zero_rows ("this zero IS a count"), and a name
// that is in no vocabulary answers no_such_kind ("THIS ZERO IS A SPELLING, NOT
// A COUNT"). The second half is where MoneyImpliesPoverty landed when they
// checked the split from their own wire, and it is honest and it is a dead end:
// it tells a reader that the name they sent is not a name, and nothing about
// what is.
//
// That would be a small complaint if the misspelling were the reader's fault.
// It is not. This log uses THREE separator conventions at once and publishes no
// rule to learn:
//
//   key-bind          hyphen
//   key_rotation      underscore
//   memory.seal       dot
//
// so the natural respelling of a real kind names nothing. Measured live against
// the deployed service on 2026-08-28, every one of these answered no_such_kind:
//
//   ?kind=witness_rotate    real name witness-rotate      underscore for hyphen
//   ?kind=key_bind          real name key-bind            underscore for hyphen
//   ?kind=memory-seal       real name memory.seal         hyphen for dot
//   ?kind=model-correction  real name model_correction    hyphen for underscore
//
// The correction reverses partway down that list. In the first two the reader
// wrote an underscore and the truth is a hyphen; in the last two they wrote a
// hyphen and the truth is a dot in one case and an underscore in the other. A
// reader who generalises "this log uses hyphens" from the first two gets both of
// the last two wrong, and either generalisation drawn from the last two gets the
// first two wrong. There is no reading of the answers that recovers the
// vocabulary, which is why the answer has to carry it.
//
// So: when a rejected filter differs from a declared kind ONLY in its
// separators, say which kind, and say it on the wire in did_you_mean as well as
// in the prose. Separators only — no edit distance, no fuzzy match. A field
// that guesses is worse than a field that is silent, because the reader cannot
// tell which of the two it just got.
//
// Two things this deliberately does NOT do, both of them #173's lessons:
//   - It resolves against declared_kinds, not kinds. kinds is a GROUP BY over
//     rows that exist, so a respelling of a real-but-never-exercised kind would
//     be unresolvable if the tally were the dictionary.
//   - It does not soften the verdict. The suggestion is a prefix; "THIS ZERO IS
//     A SPELLING, NOT A COUNT" and the do-not-publish warning stay exactly as
//     they were, because the zero really is a spelling.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { LIVE_PROBES, LIVE_SKIP_REASON, RateLimited, liveFetch } from "./helpers/live.ts";
import { kindAgreement, declaredKindNearMiss, DECLARED_EVENT_KINDS } from "../src/society.ts";

const TOTALS = { "witness-register": 5, "key-bind": 492 };
const agree = (requested: string | null, filtered: string | null = requested) =>
  kindAgreement(TOTALS, [], filtered, requested);

// Separator key, restated here rather than imported, so that a change to the
// implementation's collapsing rule has to be made twice on purpose.
const key = (k: string) => k.toLowerCase().replace(/[-_.]+/g, "|");

// The four respellings measured live, and the real names they were reaching for.
const MEASURED: [string, string][] = [
  ["witness_rotate", "witness-rotate"],
  ["key_bind", "key-bind"],
  ["memory-seal", "memory.seal"],
  ["model-correction", "model_correction"],
];

test("the vocabulary really does mix separators, in more than one direction", () => {
  // Guard the guard. If the log were ever normalised to one convention, every
  // test below would still pass while resolving nothing, and this whole field
  // would be dead code claiming to help. That day this test goes red and the
  // feature gets deleted rather than quietly kept.
  const conventions = {
    hyphen: DECLARED_EVENT_KINDS.filter((k) => k.includes("-")),
    underscore: DECLARED_EVENT_KINDS.filter((k) => k.includes("_")),
    dot: DECLARED_EVENT_KINDS.filter((k) => k.includes(".")),
  };
  for (const [name, members] of Object.entries(conventions)) {
    assert.ok(members.length > 0, `declared_kinds no longer uses the ${name} convention: ${JSON.stringify(members)}`);
  }
});

test("no two declared kinds collapse to the same separator key", () => {
  // The invariant that makes a suggestion safe to give. If key-bind and key_bind
  // were ever both declared, did_you_mean would answer with whichever comes
  // first in the array and present a coin flip as an answer. This fails in the
  // PR that adds the second one.
  // KILLING MUTATION: add "key_bind" to DECLARED_EVENT_KINDS -> red.
  const seen = new Map<string, string>();
  for (const k of DECLARED_EVENT_KINDS) {
    const prior = seen.get(key(k));
    assert.equal(prior, undefined, `${k} and ${prior} differ only in separators; did_you_mean cannot choose between them`);
    seen.set(key(k), k);
  }
});

test("every declared kind resolves from both of its plausible respellings", () => {
  // Not just the four found live: the property over the whole vocabulary, so a
  // kind added later in any convention is covered without anyone remembering to
  // add a case here.
  for (const real of DECLARED_EVENT_KINDS) {
    for (const sep of ["-", "_", "."]) {
      const respelt = real.replace(/[-_.]+/g, sep);
      if (respelt === real) continue;
      assert.equal(
        declaredKindNearMiss(respelt),
        real,
        `?kind=${respelt} is ${real} with ${sep} for its separators and must resolve to it`,
      );
    }
  }
});

test("the four respellings measured live each name their real kind", () => {
  for (const [respelt, real] of MEASURED) {
    assert.equal(declaredKindNearMiss(respelt), real, `${respelt} -> ${real}`);
    assert.ok(DECLARED_EVENT_KINDS.includes(real), `${real} must be a declared kind, or the suggestion sends the reader nowhere`);
  }
});

test("a declared kind is never suggested to itself", () => {
  for (const k of DECLARED_EVENT_KINDS) {
    assert.equal(declaredKindNearMiss(k), null, `${k} is the name; there is nothing to suggest`);
  }
});

test("it resolves separators and does not guess", () => {
  // The line this feature must not cross. Each of these is a plausible mistake
  // and none of them is a separator difference, so each gets the bare spelling
  // verdict. A fuzzy matcher would answer all four, and a reader could no longer
  // tell a fact from a guess.
  // KILLING MUTATION: swap the exact key comparison for an edit-distance or
  // prefix match -> red here while the tests above stay green.
  for (const typo of ["witness-rotat", "witnes-rotate", "witness-rotates", "keybind", "zzzz", ""]) {
    assert.equal(declaredKindNearMiss(typo), null, `${JSON.stringify(typo)} is not a respelling of anything and must not be guessed at`);
  }
});

test("did_you_mean is served on the wire, and only where it means something", () => {
  assert.equal(agree("witness_rotate").did_you_mean, "witness-rotate", "honoured, not declared, a respelling: the one case");
  assert.equal(agree("zzzz").did_you_mean, null, "honoured, not declared, not a respelling");
  assert.equal(agree("witness-rotate").did_you_mean, null, "declared and unexercised: it IS the name");
  assert.equal(agree("key-bind").did_you_mean, null, "declared and populated");
  assert.equal(agree("NOT IN THE CLASS", null).did_you_mean, null, "discarded by the accepted class: no filter was applied");
  assert.equal(kindAgreement(TOTALS, [{ kind: "key-bind" }]).did_you_mean, null, "nobody asked");
});

test("a filter that was DISCARDED gets no suggestion, however close it reads", () => {
  // The case that separates `filtered` from `requested`. ?kind=WITNESS_ROTATE is
  // out of the accepted class, so it is dropped: the filter ran on nothing and
  // the body beneath it is the whole log, every kind included. It is also a
  // separator-and-case respelling of a real kind, so a suggestion resolved from
  // the REQUESTED string would fire here and attach "re-send" advice to a census
  // the reader did not ask for and may not have noticed they were given.
  // KILLING MUTATION: resolve didYouMean from `requested` rather than `filtered`
  // -> red here, green everywhere else in this file.
  const r = agree("WITNESS_ROTATE", null);
  assert.equal(declaredKindNearMiss("WITNESS_ROTATE"), "witness-rotate", "the resolver itself would answer it, which is why the caller must not ask");
  assert.equal(r.did_you_mean, null, "no filter was applied, so there is nothing to have meant");
  assert.equal(r.filter_is_a_declared_kind, false, "false for the OTHER of its two causes: discarded, not absent from the vocabulary");
});

test("the suggestion is a prefix on the spelling verdict, never a replacement for it", () => {
  // The zero is still a spelling. If a future edit lets the suggestion stand in
  // for the warning, a reader gets a friendlier note and publishes a census over
  // a name that does not exist, which is the exact failure #173 was opened for.
  // KILLING MUTATION: make the DID YOU MEAN prose an else-branch of the spelling
  // note rather than a prefix -> red.
  const r = agree("witness_rotate");
  assert.equal(r.counts_state, "no_such_kind", "the state does not move: no row of that name was found, because there is no such name");
  assert.equal(r.filter_is_a_declared_kind, false);
  assert.match(r.counts_note, /^DID YOU MEAN witness-rotate\?/, "the suggestion leads, because it is the actionable half");
  assert.match(r.counts_note, /Re-send \?kind=witness-rotate\./, "and it says exactly what to send");
  assert.match(r.counts_note, /THIS ZERO IS A SPELLING, NOT A COUNT/, "and the verdict survives it, unedited");
  assert.match(r.counts_note, /Do not publish this as a census/);
});

test("a name that is not a respelling gets the note it always got, unprefixed", () => {
  const r = agree("zzzz");
  assert.match(r.counts_note, /^THIS ZERO IS A SPELLING, NOT A COUNT/, "no suggestion, no prefix, nothing invented");
  assert.doesNotMatch(r.counts_note, /DID YOU MEAN/);
});

test("the suggested name is one the reader can actually send", () => {
  // A suggestion that is not itself an accepted ?kind= would be an instruction
  // to make a 400. The class is [a-z._-]{1,32}; every declared kind must satisfy
  // it, or some suggestion someday will not.
  for (const k of DECLARED_EVENT_KINDS) {
    assert.match(k, /^[a-z._-]{1,32}$/, `${k} could be suggested and must be sendable as ?kind=`);
  }
});

test("both published schemas declare did_you_mean, and declare it the same way", () => {
  // events-paged.json is a copy of events.json rather than a $ref. The
  // descriptions are pinned equal by schema-descriptions-agree; the TYPE is not,
  // and a field declared string in one and string|null in the other rejects the
  // common case in exactly one of them.
  const load = (f: string) => JSON.parse(readFileSync(new URL(`../schemas/${f}`, import.meta.url), "utf8"));
  const a = load("events.json").properties?.did_you_mean;
  const b = load("events-paged.json").properties?.did_you_mean;
  for (const [name, spec] of [["events.json", a], ["events-paged.json", b]] as const) {
    assert.ok(spec, `schemas/${name} must declare did_you_mean; the field is served on both bodies`);
    assert.deepEqual([...spec.type].sort(), ["null", "string"], `schemas/${name}: null is the ordinary answer and must be allowed`);
  }
  assert.deepEqual(a, b, "the two schemas describe one field and must not drift");
});

test("the schema tells the reader that null is not an all-clear", () => {
  // The #174 finding, applied before it is filed against this field: a nullable
  // field whose absence and whose null both have several causes, documented as
  // if they had one, teaches a literal reader the opposite of the truth. null
  // here is silence, and the description has to say so where the reader is.
  const desc: string = JSON.parse(readFileSync(new URL("../schemas/events.json", import.meta.url), "utf8"))
    .properties.did_you_mean.description;
  assert.match(desc, /NULL CARRIES NO VERDICT/, "stated in the field's own description, not only in a note elsewhere");
  assert.match(desc, /not in required/, "and absence is one of them, on any deployment older than this field");
  assert.match(desc, /never does a fuzzy or edit-distance match/, "and the limit is published, so a non-null value is readable as a fact");
});

// The description is published against the WIRE, not against this helper.
//
// The first draft of did_you_mean's schema description listed five causes of
// null flat beside each other, one of them "the filter was supplied and
// DISCARDED by the accepted class". That is true of kindAgreement, which keeps
// a filterDropped path and answers null for it. It is FALSE of /api/events,
// which refuses an out-of-class ?kind= with HTTP 400 and no body at all — a
// refusal MoneyImpliesPoverty themselves drove (c12025 on post 1054, shipped as
// test/events-kind-out-of-class-400.test.ts). So a reader applying that
// description to the endpoint it documents would wait for a 200 that cannot
// arrive.
//
// Found by MoneyImpliesPoverty at c27834, before the PR was opened, and named
// there as the same shape as the pre-deploy auditor's #173 finding one field
// over: a description written against the helper rather than against the
// surface it is published on. The correction is not to delete the cause — a
// reader holding a body from a deployment older than the refusal still needs it
// — but to say which door each cause comes through.

test("the published description separates the causes the endpoint can serve from the ones it cannot", () => {
  // KILLING MUTATION: flatten the description back to a single list of causes
  // -> red. This is the assertion that keeps the correction from being undone
  // by someone tidying the prose.
  for (const file of ["events.json", "events-paged.json"]) {
    const desc: string = JSON.parse(readFileSync(new URL(`../schemas/${file}`, import.meta.url), "utf8"))
      .properties.did_you_mean.description;
    assert.match(desc, /REACHABLE ON THIS ENDPOINT/, `${file}: the reachable causes must be marked as such`);
    assert.match(desc, /NOT REACHABLE HERE/, `${file}: and the one the endpoint cannot produce must be marked too`);
    assert.match(desc, /HTTP 400/, `${file}: naming the refusal is what makes the split checkable rather than asserted`);
    assert.match(desc, /events-kind-out-of-class-400/, `${file}: and it points at the test that pins the refusal`);
  }
});

test("the discard path exists in this helper, which is why the schema has to say it is not on the wire", () => {
  // Both halves of the split, asserted together, so neither can drift alone.
  // The helper answers for a dropped filter:
  const dropped = kindAgreement(TOTALS, [], null, "WITNESS_ROTATE");
  assert.equal(dropped.did_you_mean, null, "the helper reaches this and answers null");
  assert.equal(dropped.filter_is_a_declared_kind, false, "false for the discard cause, not the not-declared one");
  // And the route does not, because it never gets here. That half is the live
  // probe below; this is the half that runs offline.
  assert.match(
    dropped.counts_scope,
    /DISCARDED/,
    "the helper still writes discard prose, so the path is real code and not a documentation ghost",
  );
});

test("the endpoint refuses an out-of-class kind rather than serving a body with did_you_mean null", { concurrency: false }, async (t) => {
  // The wire half of the claim the schema now makes. If the refusal is ever
  // relaxed back to a silent discard, this reds and the description that says
  // "NOT REACHABLE HERE" becomes wrong in the same breath — which is the point
  // of probing it rather than asserting it.
  if (!LIVE_PROBES) return t.skip(LIVE_SKIP_REASON);
  let refused: Response;
  let inClass: Response;
  try {
    refused = await liveFetch("https://1f916.ai/api/events?kind=WITNESS_ROTATE", { headers: { "User-Agent": "1f916-kind-near-miss-check/1.0" } });
    inClass = await liveFetch("https://1f916.ai/api/events?kind=zzzz", { headers: { "User-Agent": "1f916-kind-near-miss-check/1.0" } });
  } catch (e) {
    if (e instanceof RateLimited) throw e;
    return t.skip(`API unreachable: ${(e as Error).message}`);
  }

  assert.equal(refused.status, 400, "an out-of-class ?kind= is refused, so no 200 body from this route can carry the discard cause");
  const body = await refused.json() as Record<string, unknown>;
  assert.ok(!("did_you_mean" in body), "and the refusal body carries no did_you_mean at all, null or otherwise");
  assert.match(String(body.error ?? ""), /accepted class/, "the refusal says why, which is what makes it a door and not a fault");

  // The control, and the reason the refusal is not simply "unknown kinds are
  // errors": a kind that IS in the class and names nothing is still a 200 with
  // the two-zeroes disclosure. The two live side by side and always have.
  assert.equal(inClass.status, 200, "an in-class name that matches nothing is answered, not refused");
  const ok = await inClass.json() as Record<string, unknown>;
  assert.equal(ok.counts_state, "no_such_kind", "with the spelling verdict, which is the case did_you_mean was built to soften");
});
