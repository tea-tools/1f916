// A migration may not rewrite a column whose value is inside a published digest.
//
// The rule, from @commonwealth's post #2852: when a stored value means the
// wrong thing there are two repairs — change the byte, or change how the byte
// is read — and if the byte is an input to any digest that has been published,
// only the second exists. A hash cannot carry a caveat; a note can.
//
// The specimen was migration 0041 on an open PR, which rebuilt two tables that
// both have a column called `custody` and rewrote both to 'undeclared'. One is
// a mutable cache inside no digest. The other is field thirteen of
// PAYOUT_BINDING_HASH_FIELDS, and rewriting it would have decoupled every
// historical payout authorization from its own published `payload_hash` while
// copying that hash through unchanged.
//
// #2852 also gives the scan that finds it — "for every migration, for every
// column it writes: is that column named in any hash-field list this system
// publishes?" — run there as two greps, once, by hand, with zero standing hits.
// THIS FILE IS THAT SCAN AS A STANDING CHECK. A grep run once is a measurement
// of the day it ran; the class it protects against is a thing someone writes
// next month.
//
// AND THE SCAN AS STATED HAS A BLIND SPOT, WHICH IS THE REASON THIS IS NOT
// JUST THE GREP IN A TEST FILE. "Is that column named in a hash-field list"
// assumes the hash-field lists name columns. They do not: they name PAYLOAD
// fields, and the payload is assembled across a join and a rename.
// TRANSLATION below is measured, not assumed — twelve of the seventy-six
// published hashed fields are not columns of the table they describe. Seven of
// them are on payout_receipts, whose payload copies amount_atomic, chain_id,
// token and the payout address FROM THE BINDING. So a migration that rewrote
// `payout_bindings.payout_address` would break the binding digest and every
// receipt digest that copied it, and a name-only scan would see neither —
// on the very table that produced the specimen.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PAYLOAD, UNHASHED } from "../src/chain.ts";
import { PAYOUT_BINDING_HASH_FIELDS, PAYOUT_RECEIPT_HASH_FIELDS } from "../src/payouts.ts";
import { LISTING_HASH_FIELDS, SUBMISSION_HASH_FIELDS } from "../src/society.ts";

const ROOT = join(import.meta.dirname, "..");
const MIGRATIONS = join(ROOT, "migrations");

// Every published hash-field list, against the table whose rows it describes.
// A list added without an entry here is caught by the coverage test below, so
// a new digest cannot arrive unscanned.
const HASHED: Record<string, readonly string[]> = {
  identity_events: PAYLOAD.identity_events,
  ledger: PAYLOAD.ledger,
  payout_bindings: PAYOUT_BINDING_HASH_FIELDS,
  payout_receipts: PAYOUT_RECEIPT_HASH_FIELDS,
  listings: LISTING_HASH_FIELDS,
  listing_submissions: SUBMISSION_HASH_FIELDS,
};

// Hashed payload field -> the column whose value it actually carries, written
// `table.column`. Read off the payload builders, not guessed: the binding's
// from payoutBindingPayload/storedPayoutBindingPayload, the receipt's from
// storedPayoutReceiptPayload, `funder`/`handle` from the citizens join.
//
// Keyed by `<payload table>.<field>` because the same field name means
// different things on different payloads: `address` is the payout address on
// both, but `docket_id` is a receipt PAYLOAD field and a binding COLUMN.
const TRANSLATION: Record<string, string> = {
  "payout_bindings.handle": "citizens.handle",
  "payout_bindings.row": "payout_bindings.docket_id",
  "payout_bindings.address": "payout_bindings.payout_address",

  "payout_receipts.version": "payout_bindings.version",
  "payout_receipts.binding_payload_hash": "payout_bindings.payload_hash",
  "payout_receipts.docket_id": "payout_bindings.docket_id",
  "payout_receipts.amount_atomic": "payout_bindings.amount_atomic",
  "payout_receipts.chain_id": "payout_bindings.chain_id",
  "payout_receipts.token": "payout_bindings.token",
  "payout_receipts.address": "payout_bindings.payout_address",

  "listings.funder": "citizens.handle",
  "listing_submissions.handle": "citizens.handle",
};

function schemaColumns(): Map<string, Set<string>> {
  const sql = readFileSync(join(ROOT, "schema.sql"), "utf8");
  const tables = new Map<string, Set<string>>();
  for (const m of sql.matchAll(/CREATE TABLE(?: IF NOT EXISTS)? ([a-z_]+) \(([\s\S]*?)\n\);/g)) {
    const cols = new Set<string>();
    for (const line of m[2].split("\n")) {
      const c = line.trim().match(/^([a-z_]+)\s/);
      // Skip table-level constraint clauses, which also start at column depth.
      if (c && !/^(primary|unique|foreign|check|constraint)$/i.test(c[1])) cols.add(c[1]);
    }
    tables.set(m[1], cols);
  }
  return tables;
}

// Every (table, column) pair that is protected by some published digest,
// after translation.
function protectedColumns(): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const add = (table: string, column: string) => {
    if (!out.has(table)) out.set(table, new Set());
    out.get(table)!.add(column);
  };
  const columns = schemaColumns();
  for (const [table, fields] of Object.entries(HASHED)) {
    for (const field of fields) {
      const translated = TRANSLATION[`${table}.${field}`];
      if (translated) {
        const [t, c] = translated.split(".");
        add(t, c);
      } else {
        assert.ok(
          columns.get(table)?.has(field),
          `hashed field ${table}.${field} is neither a column of ${table} nor declared in TRANSLATION — ` +
            `the scan would silently protect nothing for it`,
        );
        add(table, field);
      }
    }
  }
  return out;
}

// Split a SQL expression list at top-level commas (parens and quotes respected).
function splitTopLevel(list: string): string[] {
  const out: string[] = [];
  let depth = 0, quote = false, current = "";
  for (let i = 0; i < list.length; i++) {
    const ch = list[i];
    if (quote) {
      current += ch;
      if (ch === "'") quote = list[i + 1] === "'" ? (current += list[++i], true) : false;
      continue;
    }
    if (ch === "'") { quote = true; current += ch; continue; }
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) { out.push(current.trim()); current = ""; continue; }
    current += ch;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

const stripComments = (sql: string) => sql.replace(/--[^\n]*/g, "");
// SQLite rebuilds a table under a temporary name; the digest belongs to the
// real one.
const realTable = (t: string) => t.replace(/_(new|old|tmp)$/, "");

export interface Write { file: string; table: string; column: string; value: string; }

// Every column a migration writes with something OTHER than the value already
// in it. Two shapes, and the second is the one that got #2852:
//
//   UPDATE <table> SET <col> = <expr>
//   INSERT INTO <table>_new (<cols>) SELECT <exprs> FROM <table>
//
// In the rebuild, a column copied as itself is a copy; a literal sitting in
// that position is a rewrite. Position matters, not name — which is why this
// aligns the two lists rather than grepping for the column.
export function migrationWrites(file: string, sql: string): Write[] {
  const clean = stripComments(sql);
  const writes: Write[] = [];

  for (const m of clean.matchAll(/UPDATE\s+([a-z_]+)\s+SET\s+([\s\S]*?)(?:\s+WHERE\b|;)/gi)) {
    for (const assign of splitTopLevel(m[2])) {
      const a = assign.match(/^([a-z_]+)\s*=\s*([\s\S]+)$/i);
      if (a) writes.push({ file, table: realTable(m[1]), column: a[1], value: a[2].trim() });
    }
  }

  for (const m of clean.matchAll(/INSERT\s+INTO\s+([a-z_]+)\s*\(([^)]*)\)\s*SELECT\s+([\s\S]*?)\s+FROM\s+/gi)) {
    const target = realTable(m[1]);
    const cols = splitTopLevel(m[2]).map((c) => c.trim());
    const exprs = splitTopLevel(m[3]);
    assert.equal(
      cols.length,
      exprs.length,
      `${file}: rebuild of ${m[1]} lists ${cols.length} columns and selects ${exprs.length} expressions; ` +
        `the scan cannot align them, and neither can a reader`,
    );
    cols.forEach((col, i) => {
      const expr = exprs[i].trim();
      // A bare identifier equal to the column (optionally qualified) is a copy.
      const identity = new RegExp(`^(?:[a-z_]+\\.)?${col}$`, "i").test(expr);
      if (!identity) writes.push({ file, table: target, column: col, value: expr });
    });
  }

  return writes;
}

test("every published hash-field list is scanned", () => {
  // Guard the guard: a new digest whose list is not in HASHED would make this
  // whole file pass by not looking.
  const declared = new Set(Object.values(HASHED).map((f) => f.join(",")));
  for (const [name, fields] of [
    ["PAYOUT_BINDING_HASH_FIELDS", PAYOUT_BINDING_HASH_FIELDS],
    ["PAYOUT_RECEIPT_HASH_FIELDS", PAYOUT_RECEIPT_HASH_FIELDS],
    ["LISTING_HASH_FIELDS", LISTING_HASH_FIELDS],
    ["SUBMISSION_HASH_FIELDS", SUBMISSION_HASH_FIELDS],
    ["PAYLOAD.identity_events", PAYLOAD.identity_events],
    ["PAYLOAD.ledger", PAYLOAD.ledger],
  ] as const) {
    assert.ok(declared.has(fields.join(",")), `${name} is published but not mapped to a table in HASHED`);
  }
});

test("every hashed field resolves to a real column, by name or by declared translation", () => {
  const columns = schemaColumns();
  // The measurement that motivates TRANSLATION, asserted rather than described:
  // if these ever became real columns the translation would be dead weight, and
  // if MORE fields drift off the schema the count moves and this says so.
  const gaps: string[] = [];
  for (const [table, fields] of Object.entries(HASHED))
    for (const field of fields) if (!columns.get(table)?.has(field)) gaps.push(`${table}.${field}`);
  assert.deepEqual(
    gaps.sort(),
    Object.keys(TRANSLATION).sort(),
    "the set of hashed fields that are not columns has changed; TRANSLATION must move with it",
  );
  // And the resolution itself must land somewhere real.
  for (const [from, to] of Object.entries(TRANSLATION)) {
    const [t, c] = to.split(".");
    assert.ok(columns.get(t)?.has(c), `${from} translates to ${to}, which is not a column`);
  }
});

test("no migration rewrites a column that is inside a published digest", () => {
  const guarded = protectedColumns();
  const offenders: string[] = [];
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
  assert.ok(files.length > 0, "no migrations found; the scan would pass by scanning nothing");

  for (const file of files) {
    for (const w of migrationWrites(file, readFileSync(join(MIGRATIONS, file), "utf8"))) {
      if (!guarded.get(w.table)?.has(w.column)) continue;
      offenders.push(`${w.file}: ${w.table}.${w.column} := ${w.value.slice(0, 60)}`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    "a migration writes a column whose value is inside a published digest. The stored hash does not " +
      "move with it, so every affected row stops reproducing its own digest under the recipe this " +
      "registry publishes. Copy the column verbatim and put the reinterpretation in a note beside it.",
  );
});

test("a write to a hash-chained table on an UNHASHED column is not an offence", () => {
  // 0030 backfills ledger.tx on seven historical rows. `ledger` IS chained, so
  // a table-level check would fire here — and be wrong. `tx` is named in
  // UNHASHED.ledger precisely so it can be written without breaking a digest.
  // This is the distinction #2852 says is invisible at the column, made
  // visible: the scan has to be column-level or it is useless.
  const sql = readFileSync(join(MIGRATIONS, "0030_ledger_tx_out_of_prose.sql"), "utf8");
  const writes = migrationWrites("0030", sql);
  assert.ok(writes.length > 0, "0030 writes something");
  assert.ok(writes.every((w) => w.table === "ledger" && w.column === "tx"));
  assert.ok(UNHASHED.ledger?.includes("tx"), "tx is declared outside the ledger preimage");
  assert.ok(!PAYLOAD.ledger.includes("tx"), "and is therefore not in the preimage");
});

test("the scan fires on the specimen it was written for", () => {
  // Not a hypothetical: this is the shape of migration 0041 as it stood on the
  // open PR — a CHECK widened by rebuilding the table, with a literal in the
  // position of a hashed column and payload_hash copied through beside it.
  //
  // A detector whose green has never been checked against a real positive is
  // not evidence of anything, so this runs the actual scanner over the actual
  // defect rather than trusting that it would have caught it.
  const specimen = `
    CREATE TABLE payout_bindings_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      citizen_id INTEGER NOT NULL,
      docket_id TEXT NOT NULL,
      citizen_key_custody TEXT NOT NULL CHECK (citizen_key_custody IN ('self','operator-held','undeclared')),
      payload_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    INSERT INTO payout_bindings_new (id, citizen_id, docket_id, citizen_key_custody, payload_hash, created_at)
      SELECT id, citizen_id, docket_id, 'undeclared', payload_hash, created_at FROM payout_bindings;
  `;
  const writes = migrationWrites("specimen-0041", specimen);
  assert.deepEqual(
    writes.map((w) => `${w.table}.${w.column} := ${w.value}`),
    ["payout_bindings.citizen_key_custody := 'undeclared'"],
    "the rewrite is found by POSITION in the rebuild, and the columns copied as themselves are not flagged",
  );
  assert.ok(
    protectedColumns().get("payout_bindings")?.has("citizen_key_custody"),
    "and that column is inside a published digest, so the scan reports it",
  );

  // The other half of the same migration, which was safe and must stay
  // unflagged — same word, same day, same migration, no digest over it.
  const cache = `
    INSERT INTO keys_new (id, citizen_id, custody, created_at)
      SELECT id, citizen_id, 'undeclared', created_at FROM keys;
  `;
  const cacheWrites = migrationWrites("specimen-keys", cache);
  assert.equal(cacheWrites.length, 1, "the cache rewrite is still detected as a write");
  assert.ok(
    !protectedColumns().get("keys")?.has("custody"),
    "but keys.custody is inside no digest, so it is not an offence — the scan must not cry wolf on it",
  );
});
