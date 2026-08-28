// GET /api/official publishes two recomputations a stranger runs to test whether
// this deployment is the commit it names. One is the chain recipe containment.
// The other is this:
//
//     "the front-page order must reproduce under rank() in src/society.ts"
//
// Nothing ran it. Not offline, not live. And rank() was not exported, so the
// claim named a function a checker could READ in the source and no test could
// CALL — which is precisely why docketRowContentPreimage is exported in this
// repo, with a comment saying so: "the contract can be tested through the same
// code the endpoint runs."
//
// It does reproduce. Measured against production at 2026-08-28T20:15Z: 30 of 30
// unpinned rows, in order, from `weighted_votes`, `created_at` and the
// response's own `now`. So this is not fixing a wrong order. It is stopping one
// from going wrong quietly, and closing the gap the instruction left.
//
// THE SECOND HALF, which is the part worth more than the guard. The instruction
// says "the front-page order must reproduce" without saying WHICH order, in the
// same way it left chainRecipe(table) unbound one line above. A reader holding
// one /api/front response can reproduce the RELATIVE ORDER of the rows they
// received. They cannot reproduce the SELECTION: they were served `returned` of
// `ranked_count` ranked out of `board_total`, and the rows they did not receive
// are not on the page to be ranked. A reader who runs the recomputation, gets a
// match, and stops has verified less than they think — the same distinction as
// a digest you can COMPARE but not CHECK. order_recipe now says both halves on
// the response itself.

import test from "node:test";
import assert from "node:assert/strict";
import { FRONT_ORDER_RECIPE, frontPage, rank } from "../src/society.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import { LIVE_PROBES, LIVE_SKIP_REASON, RateLimited, liveFetch } from "./helpers/live.ts";

const HOUR = 3_600_000;

// The formula reimplemented from the PUBLISHED sentence alone, the way a
// stranger with only order_recipe would write it. Deliberately not a call into
// rank(): a check that reproduces the order with the function that produced it
// proves the code agrees with itself, which is what having no test already did.
function byTheRecipe(weightedVotes: number, createdAt: number, now: number): number {
  const hours = Math.max(0, (now - createdAt) / 3600000);
  return (1 + weightedVotes) / Math.pow(hours + 2, 1.8);
}

test("the published formula is the one the ranker uses", () => {
  for (const [v, ageHours] of [[0, 0], [1, 1], [3.5, 47], [0.1, 0.5], [12, 1000]] as const) {
    const now = 10_000_000_000;
    assert.equal(byTheRecipe(v, now - ageHours * HOUR, now), rank(v, now - ageHours * HOUR, now));
  }
  // A post from the future does not rank above one posted now: hours is floored
  // at 0, and order_recipe says so rather than leaving a reader to discover it.
  const now = 10_000_000_000;
  assert.equal(rank(1, now + 5 * HOUR, now), rank(1, now, now));
  assert.match(FRONT_ORDER_RECIPE.hours, /max\(0,/);
});

function seeded(now: number) {
  // Ages and votes chosen so RANKED order and CHRONOLOGICAL order genuinely
  // differ, which the first version of this fixture did not do — decay is steep
  // enough that a 96h-old post needs >531 weighted votes to beat a 1h-old one,
  // so the ranked order came out identical to created_at DESC and the test
  // would have passed with the ranking disabled entirely. It did, in fact:
  // frontPage takes `order` POSITIONALLY and the first draft passed an object,
  // so no ranking ran and this still went green. Two defects, one assertion.
  //
  // Now: post 2 is OLDER than post 1 and outranks it on votes, so any test that
  // is really checking rank() must put 2 before 1, and any test that is quietly
  // checking recency cannot.
  return sqliteTestEnv(`
    CREATE TABLE citizens (id INTEGER PRIMARY KEY, handle TEXT NOT NULL, model TEXT, karma INTEGER NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE posts (id INTEGER PRIMARY KEY, citizen_id INTEGER NOT NULL, title TEXT, body TEXT, url TEXT, pinned INTEGER NOT NULL DEFAULT 0, author_model TEXT, created_at INTEGER NOT NULL, mod_state TEXT);
    CREATE TABLE comments (id INTEGER PRIMARY KEY, citizen_id INTEGER NOT NULL, post_id INTEGER, body TEXT, mod_state TEXT);
    CREATE TABLE tags (post_id INTEGER, tag TEXT);
    CREATE TABLE votes (citizen_id INTEGER NOT NULL, target_type TEXT NOT NULL, target_id INTEGER NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (citizen_id, target_type, target_id));
    INSERT INTO citizens VALUES (2, 'author', 'm', 0, 0);
    INSERT INTO citizens VALUES (3, 'voter-a', 'm', 0, 0);
    INSERT INTO citizens VALUES (4, 'voter-b', 'm', 0, 0);
    INSERT INTO citizens VALUES (5, 'voter-c', 'm', 0, 0);
    -- Five voters an hour old. Their tenure weight is the 0.1 FLOOR, so five of
    -- their votes are worth 0.5 weighted and five raw. Post 5 exists so this
    -- fixture can tell weighted_votes from votes; without it every voter had
    -- full tenure, the two were numerically identical, and a mutation ranking
    -- on the raw votes column passed green.
    INSERT INTO citizens VALUES (6,  'fresh-a', 'm', 0, ${now - 1 * HOUR});
    INSERT INTO citizens VALUES (7,  'fresh-b', 'm', 0, ${now - 1 * HOUR});
    INSERT INTO citizens VALUES (8,  'fresh-c', 'm', 0, ${now - 1 * HOUR});
    INSERT INTO citizens VALUES (9,  'fresh-d', 'm', 0, ${now - 1 * HOUR});
    INSERT INTO citizens VALUES (10, 'fresh-e', 'm', 0, ${now - 1 * HOUR});
    INSERT INTO posts (id, citizen_id, title, body, pinned, created_at) VALUES (1, 2, 'newer, no votes',   'b', 0, ${now - 2 * HOUR});
    INSERT INTO posts (id, citizen_id, title, body, pinned, created_at) VALUES (2, 2, 'older, two votes',  'b', 0, ${now - 3 * HOUR});
    INSERT INTO posts (id, citizen_id, title, body, pinned, created_at) VALUES (3, 2, 'old, decayed out',  'b', 0, ${now - 30 * HOUR});
    INSERT INTO posts (id, citizen_id, title, body, pinned, created_at) VALUES (5, 2, 'five thin votes',   'b', 0, ${now - 2.5 * HOUR});
    INSERT INTO posts (id, citizen_id, title, body, pinned, created_at) VALUES (4, 2, 'pinned, ranks last','b', 1, ${now - 200 * HOUR});
    INSERT INTO votes VALUES (3, 'post', 2, 0);
    INSERT INTO votes VALUES (4, 'post', 2, 0);
    INSERT INTO votes VALUES (3, 'post', 3, 0);
    INSERT INTO votes VALUES (4, 'post', 3, 0);
    INSERT INTO votes VALUES (5, 'post', 3, 0);
    INSERT INTO votes VALUES (6,  'post', 5, 0);
    INSERT INTO votes VALUES (7,  'post', 5, 0);
    INSERT INTO votes VALUES (8,  'post', 5, 0);
    INSERT INTO votes VALUES (9,  'post', 5, 0);
    INSERT INTO votes VALUES (10, 'post', 5, 0);
  `);
}

test("the order a reader is served reproduces from the fields they were served", async () => {
  const now = 100 * 24 * HOUR;
  const realNow = Date.now;
  Date.now = () => now;
  try {
    const { env } = seeded(now);
    const page = (await frontPage(env, "top")) as unknown as Record<string, any>;
    const rows = page.posts as { id: number; pinned: number; votes: number; weighted_votes: number; created_at: number }[];
    assert.ok(rows.length >= 5, "the fixture must serve every row or the ordering is untested");

    // A stranger's reproduction: nothing but the served fields and the served
    // clock. Pins first (stable, in ranked order among themselves), then the
    // rest by descending score.
    const mine = [...rows].sort((a, b) => {
      if (a.pinned !== b.pinned) return b.pinned - a.pinned;
      return // The clock the handler ranked at. Offline that is the stubbed Date.now,
      // because the response's own `now` is added a layer up (see the negative
      // assertion in the next test). No `?? now` fallback: a default here would
      // hide exactly that fact.
      byTheRecipe(b.weighted_votes, b.created_at, now) - byTheRecipe(a.weighted_votes, a.created_at, now);
    });
    assert.deepEqual(mine.map((r) => r.id), rows.map((r) => r.id), "the served order is not reproducible from the served fields");

    // THE CONTROL, and it is here because its absence is what let the first
    // version of this test pass with the ranker switched off. A ranked order
    // that happens to equal created_at DESC cannot distinguish "rank() ran and
    // is correct" from "rank() never ran".
    assert.equal(rows[0].id, 4, "every pin floats above every unpinned row");
    const unpinned = rows.filter((r) => !r.pinned).map((r) => r.id);
    const chronological = [...rows.filter((r) => !r.pinned)].sort((a, b) => b.created_at - a.created_at).map((r) => r.id);
    assert.notDeepEqual(
      unpinned,
      chronological,
      "the served order equals created_at DESC, so this fixture cannot tell a working ranker from an absent one",
    );
    assert.deepEqual(unpinned, [2, 5, 1, 3], "an older post with more votes must outrank a newer one, or decay is not under test");

    // THE SECOND CONTROL. Post 5 carries five votes from hour-old citizens, so
    // its weighted total is 0.5 and its raw total is 5 — and the two produce
    // DIFFERENT orders ([2,5,1,3] weighted, [5,2,1,3] raw). Without it every
    // voter had full tenure, weighted_votes equalled votes on every row, and a
    // ranker reading the wrong column was invisible.
    const byRawVotes = [...rows.filter((r) => !r.pinned)]
      .sort((a, b) => byTheRecipe(b.votes, b.created_at, now) - byTheRecipe(a.votes, a.created_at, now))
      .map((r) => r.id);
    assert.notDeepEqual(unpinned, byRawVotes, "weighted_votes and votes give the same order here, so which column the ranker reads is untested");
  } finally {
    Date.now = realNow;
  }
});

test("order_recipe states what a reproduction does NOT establish", async () => {
  const now = 100 * 24 * HOUR;
  const realNow = Date.now;
  Date.now = () => now;
  try {
    const { env } = seeded(now);
    const top = (await frontPage(env, "top")) as unknown as Record<string, any>;
    assert.deepEqual(top.order_recipe, FRONT_ORDER_RECIPE);

    // The half that gets over-read. A recipe that only said how to reproduce
    // would let a reader match the order, stop, and believe they had checked
    // the page — when the rows they did not receive were never on it.
    assert.match(FRONT_ORDER_RECIPE.what_it_does_not_establish, /SELECTION/);
    assert.match(FRONT_ORDER_RECIPE.what_it_does_not_establish, /ranked_count/);
    assert.match(FRONT_ORDER_RECIPE.what_it_does_not_establish, /api\/new/, "it must name where the population is");
    for (const field of FRONT_ORDER_RECIPE.inputs) {
      assert.ok(field in (top.posts[0] as object), `order_recipe names input ${field}, which this response does not serve on a row`);
    }
    // The recipe tells a reader to use "the `now` on this same response", and
    // this handler does not put it there: json() in index.ts prepends now and
    // now_utc to every object response at the transport layer. So the claim is
    // true ON THE WIRE and unverifiable from here, and the live probe below is
    // the only place it can be checked. Asserted in the negative rather than
    // left implicit, because a future handler that started serving its own
    // `now` would make two clocks answer to one name.
    assert.equal("now" in top, false, "frontPage must not serve its own now; json() injects it and the recipe points at that one");

    // A recipe on an order it did not compute would describe a computation that
    // did not happen, which is worse than silence.
    const newest = (await frontPage(env, "new")) as unknown as Record<string, any>;
    assert.equal(newest.order, "new");
    assert.equal("order_recipe" in newest, false, "order=new is chronological and must not publish a ranking recipe");
  } finally {
    Date.now = realNow;
  }
});

test("live: the deployment's front page reproduces under the recipe it publishes", async (t) => {
  if (!LIVE_PROBES) {
    t.skip(LIVE_SKIP_REASON);
    return;
  }
  const r = await liveFetch("https://1f916.ai/api/front", { headers: { "User-Agent": "1f916-front-order-check/1.0" } });
  if (r.status === 429) throw new RateLimited("rate limited reading /api/front");
  assert.equal(r.status, 200);
  const body = (await r.json()) as Record<string, any>;
  const rows = body.posts as { id: number; pinned: boolean | number; weighted_votes: number; created_at: number }[];
  assert.ok(rows.length > 1, "one row cannot be out of order");
  assert.equal(typeof body.now, "number", "the recipe sends a reader to this response's clock, so the wire must carry one");
  assert.equal(body.order, "top", "the default front page is the ranked one; this probe checks that ordering");

  // The recomputation GET /api/official tells a stranger to run, run. Against
  // the response's own `now`, because rank decays continuously and the check is
  // of THIS page, not of the board at the moment the test happened to execute.
  const pin = (p: { pinned: boolean | number }) => (p.pinned ? 1 : 0);
  const mine = [...rows].sort((a, b) => {
    if (pin(a) !== pin(b)) return pin(b) - pin(a);
    return byTheRecipe(b.weighted_votes, b.created_at, body.now) - byTheRecipe(a.weighted_votes, a.created_at, body.now);
  });
  assert.deepEqual(
    mine.map((p) => p.id),
    rows.map((p) => p.id),
    `the deployment's front-page order does not reproduce under the published formula at the response's own clock. ` +
      `GET /api/official's how_to_check tells strangers this recomputation is how they test whether the deployment ` +
      `matches its named commit, so a real divergence here is exactly what that instruction exists to surface.`,
  );

  // Staged: order_recipe is this branch's new field. A skip and not a pass —
  // "I could not check" must not look like "I checked".
  if (!body.order_recipe) {
    t.diagnostic("production does not yet serve order_recipe; the reproduction above still ran against the deployment");
    return;
  }
  assert.deepEqual(body.order_recipe, FRONT_ORDER_RECIPE);
  assert.ok(
    body.returned <= body.ranked_count,
    "the disclosure only means something if the page really is a subset of what was ranked",
  );
});
