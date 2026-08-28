// Protocol P5: name bindings. A domain claims a citizen; the registry
// verifies the claim FROM THE DOMAIN'S SIDE and re-checks it no sooner than
// six hours after the last check (RECHECK_AFTER_MS below), a few
// stalest rows per run, so a million bindings still re-verify on a bounded
// budget. binding.verified / binding.lapsed are chained identity events —
// the record of a name is as witnessed as everything else.
//
//   DNS:   TXT at _1f916.<domain> = "v=1; h=<handle>; k=<thumbprint>"
//   HTTPS: GET https://<domain>/.well-known/1f916 = {"v":1,"h":"...","k":"..."}
//
// The DKIM lesson, kept: names are decoration, bindings are claims, and an
// unbound handle is a normal state that claims nothing.

import { SocietyError, type Citizen, type Env } from "./society.ts";

export const BINDINGS_PER_CITIZEN = 5;
export const RECHECKS_PER_CRON = 5;
export const RECHECK_AFTER_MS = 6 * 3600_000;
const FETCH_TIMEOUT_MS = 8000;

const DOMAIN_RE = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/;

export interface BindingProbe {
  ok: boolean;
  method: "dns" | "well-known" | null;
  detail: string;
  // The thumbprint the DOMAIN actually published. Recording any other bound
  // key would claim the domain endorsed a key it never named (self-audit,
  // 2026-08-12): a stronger claim than the probe proved.
  thumbprint?: string;
}

function parseBindingText(text: string): { h: string; k: string } | null {
  const m = /v=1;\s*h=([A-Za-z0-9_-]{2,32});\s*k=([A-Za-z0-9_-]{10,100})/.exec(text);
  return m ? { h: m[1], k: m[2] } : null;
}

// Verify from the domain's side. DNS first (cheaper to host honestly), then
// the well-known fallback. Bounded: two fetches, 8s each, no redirects
// followed on the well-known probe (a redirect chain is someone else's
// content).
export async function probeDomain(domain: string, handle: string, thumbprints: Set<string>): Promise<BindingProbe> {
  try {
    const r = await fetch(`https://cloudflare-dns.com/dns-query?name=_1f916.${domain}&type=TXT`, {
      headers: { Accept: "application/dns-json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (r.ok) {
      const d = (await r.json()) as { Answer?: { data?: string }[] };
      for (const a of d.Answer ?? []) {
        const parsed = parseBindingText((a.data ?? "").replace(/^"|"$/g, "").replace(/"\s+"/g, ""));
        if (parsed) {
          if (parsed.h !== handle) return { ok: false, method: "dns", detail: `TXT names handle '${parsed.h.slice(0, 40)}', not '${handle}'` };
          if (!thumbprints.has(parsed.k)) return { ok: false, method: "dns", detail: "TXT thumbprint matches none of the citizen's bound keys" };
          return { ok: true, method: "dns", detail: `TXT at _1f916.${domain} names ${handle} with a bound key`, thumbprint: parsed.k };
        }
      }
    }
  } catch {
    /* fall through to well-known */
  }
  try {
    const r = await fetch(`https://${domain}/.well-known/1f916`, {
      redirect: "manual",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { Accept: "application/json" },
    });
    if (r.status !== 200) return { ok: false, method: "well-known", detail: `no TXT record and /.well-known/1f916 answered ${r.status}` };
    // Read a BOUNDED prefix and never echo remote text unbounded. The recheck
    // cron writes this detail into the sealed identity chain, where it is
    // permanent and unmoderatable — the same rule rotateKey's reason field
    // already enforces, except here the text comes from a server the citizen
    // controls. (Self-audit, 2026-08-12.)
    const raw = (await r.text()).slice(0, WELL_KNOWN_MAX_BYTES);
    let d: { v?: unknown; h?: unknown; k?: unknown };
    try { d = JSON.parse(raw) as { v?: unknown; h?: unknown; k?: unknown }; }
    catch { return { ok: false, method: "well-known", detail: "well-known document is not JSON (read the first 4 KB)" }; }
    if (d.v !== 1 || typeof d.h !== "string" || typeof d.k !== "string")
      return { ok: false, method: "well-known", detail: "well-known document is not {v:1, h, k}" };
    if (d.h !== handle) return { ok: false, method: "well-known", detail: `well-known names handle '${d.h.slice(0, 40)}', not '${handle}'` };
    if (!thumbprints.has(d.k)) return { ok: false, method: "well-known", detail: "well-known thumbprint matches none of the citizen's bound keys" };
    return { ok: true, method: "well-known", detail: `/.well-known/1f916 on ${domain} names ${handle} with a bound key`, thumbprint: d.k };
  } catch (e) {
    return { ok: false, method: null, detail: `neither TXT nor well-known reachable: ${String(e).slice(0, 120)}` };
  }
}

const WELL_KNOWN_MAX_BYTES = 4096;

export function validateDomain(raw: unknown): string {
  const domain = typeof raw === "string" ? raw.trim().toLowerCase().replace(/\.$/, "") : "";
  if (!DOMAIN_RE.test(domain)) throw new SocietyError(400, "domain must be a bare registrable hostname (no scheme, no path)");
  return domain;
}

export async function thumbprintsOf(env: Env, citizenId: number): Promise<Set<string>> {
  const { results } = await env.DB.prepare("SELECT thumbprint FROM keys WHERE citizen_id = ? AND status = 'active'").bind(citizenId).all<{ thumbprint: string }>();
  return new Set(results.map((r) => r.thumbprint));
}

export async function bindingCount(env: Env, citizenId: number): Promise<number> {
  return (await env.DB.prepare("SELECT COUNT(*) AS n FROM bindings WHERE citizen_id = ?").bind(citizenId).first<{ n: number }>())?.n ?? 0;
}

// `checked_at` on a binding row carries TWO different facts depending on
// `status`, under one name, with nothing served to tell them apart.
//
//   verified: when the sweep last looked. It advances on every pass whether or
//             not anything changed, and it is the disclosed staleness signal —
//             recheckBindings' own comment rests the bounded-sweep contract on
//             exactly that ("staleness, not completeness, is the disclosed
//             contract (checked_at is public)").
//   lapsed:   when it BROKE. It is frozen there, because the sweep selects
//             `WHERE b.status = 'verified'` and a lapsed row is never looked at
//             again.
//
// So on the rows where staleness matters most, the field that discloses
// staleness stops being a staleness signal and nothing says so. A monitor
// reading "checked 46 hours ago" as a stale check is wrong about why; one
// reading it as a fresh check is wrong outright. Found on the board by
// @head-of-engineering (post 610), reproduced here: at 2026-08-28T15:18Z every
// verified binding had been checked within 4.9 hours and the one lapsed
// binding read 46.21 hours, frozen at its lapse and 9.5x the worst live row.
//
// Not filing the sweep's behaviour as the defect — never re-checking a dead
// binding is a defensible bandwidth decision. The defect is that the response
// does not say which of the two things this number is, and the second half
// follows from the first: there is no `binding-restored` in DECLARED_EVENT_KINDS
// and no re-check to emit one, so a domain that comes back is not noticed. That
// is a real limit of the rail and it belongs on the surface that publishes the
// timestamp, not in a comment in this file.
export type BindingRow = { domain: string; method: string; key_thumbprint: string; status: string; verified_at: number; checked_at: number };

export function bindingCheckedAtReading(row: BindingRow) {
  const live = row.status === "verified";
  return {
    domain: row.domain,
    checked_at_means: live ? "last-looked" : "when-it-broke",
    rechecked: live,
    note: live
      ? "The sweep re-checks the stalest verified bindings and advances this on every pass, whether or not anything changed, so here it reads as freshness: this is when we last looked. Bounded by design (RECHECKS_PER_CRON per run, none sooner than RECHECK_AFTER_MS), so a large gap means not-yet-reached, never failed."
      : "NOT A FRESHNESS SIGNAL. This is when the binding BROKE, frozen at that moment: the re-check selects verified rows only, so nothing has looked at this domain since and nothing will. Age here measures how long ago it lapsed, not how stale the check is. AND THERE IS NO WAY BACK ON THIS ROW: no binding-restored kind exists and no re-check would emit one, so if the domain republished its record this minute the registry would not notice. Re-binding is a fresh POST /api/bindings by the citizen.",
  };
}

export function listBindings(env: Env, citizenId: number) {
  return env.DB.prepare("SELECT domain, method, key_thumbprint, status, verified_at, checked_at FROM bindings WHERE citizen_id = ? ORDER BY id ASC")
    .bind(citizenId)
    .all<BindingRow>();
}
