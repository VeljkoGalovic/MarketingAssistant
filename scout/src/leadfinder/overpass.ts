import { config } from "../config.ts";
import {
  addEvent,
  canonicalizeEmail,
  canonicalizeDomain,
  db,
  findEntityByCanon,
  findEntityByOsmId,
  isContactBlocked,
  setEntityResearch,
  upsertContact,
  upsertEntity,
} from "../db.ts";
import dns from "node:dns";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { generateResearchNote } from "../drafts/research.ts";

const execFileP = promisify(execFile);

/**
 * Lead-finder (Phase 6, PLAN §4): OSM Overpass sweeps per city →
 * accommodation POIs → website enrichment (emails/phones) → CRM entities.
 *
 * Free stack only: Nominatim (geocode) + Overpass (POIs) + the target's own
 * public contact pages. Politeness: 1 req/s hard spacing, honest UA.
 */

const UA = "LodgeTrackScout/0.1 (growth outreach; contact: veljko@lodgetrack.com)";

export interface CitySweep {
  city: string;
  bbox: [number, number, number, number]; // south, north, west, east
}

async function politeFetch(url: string, init?: RequestInit): Promise<Response> {
  await new Promise((r) => setTimeout(r, 1100)); // ≥1 req/s across ALL sources
  // generous safety net: network/external hangs must never stall the ticker forever
  return fetch(url, {
    ...init,
    headers: { "User-Agent": UA, ...(init?.headers ?? {}) },
    signal: init?.signal ?? AbortSignal.timeout(60_000),
  });
}

export async function geocodeCity(city: string): Promise<CitySweep | null> {
  try {
    const res = await politeFetch(
      `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(city)}&format=json&limit=1`
    );
    if (!res.ok) return null;
    const j = (await res.json()) as Array<{ boundingbox: string[]; display_name: string }>;
    if (!j?.length) return null;
    const bb = j[0].boundingbox.map(Number) as unknown as number[];
    return { city, bbox: [bb[0], bb[1], bb[2], bb[3]] };
  } catch (e) {
    addEvent("error", `geocode ${city}: ${String(e)}`);
    return null;
  }
}

interface Poi {
  osmType: string;
  osmId: number;
  name: string;
  website?: string;
  phone?: string;
  category?: string | null;
  city: string;
  lat: number;
  lon: number;
}

async function overpassQuery(sweep: CitySweep): Promise<Poi[]> {
  const [s, n, w, e] = sweep.bbox;
  const q = `
    [out:json][timeout:90];
    (
      nwr["tourism"~"hotel|guest_house|apartment|hostel|camp_site"](${s},${w},${n},${e});
    );
    out center tags;
  `.trim();
  const res = await politeFetch("https://overpass-api.de/api/interpreter", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ data: q }),
    signal: AbortSignal.timeout(75_000), // below their own 90s query budget
  });
  if (!res.ok) throw new Error(`overpass HTTP ${res.status}`);
  const j = (await res.json()) as {
    elements: Array<{
      type: string;
      id: number;
      tags?: Record<string, string>;
      lat?: number;
      lon?: number;
      center?: { lat: number; lon: number };
    }>;
  };
  return j.elements
    .map((el) => ({
      osmType: el.type,
      osmId: el.id,
      name: el.tags?.name ?? "",
      website: el.tags?.website ?? el.tags?.["contact:website"],
      phone: el.tags?.phone ?? el.tags?.["contact:phone"],
      category: el.tags?.tourism ?? el.tags?.amenity ?? null,
      city: sweep.city,
      lat: el.lat ?? el.center?.lat ?? 0,
      lon: el.lon ?? el.center?.lon ?? 0,
    }))
    .filter((p) => p.name);
}

/** Very light homepage scrape: first mailto/link email + phone. Read-only GET. */
async function enrichWebsite(
  website: string
): Promise<{ email?: string; phone?: string; domainCanon?: string }> {
  const results: { email?: string; phone?: string } = {};
  const pages = [website];
  try {
    const u = new URL(website);
    // one likely contact page guess, only if homepage doesn't yield
    const emailRe = /mailto:([\w.+-]+@[\w-]+\.[\w.]+)|([\w.+-]+@[\w-]+\.[a-z]{2,})/i;
    const phoneRe = /(?:tel:|phone[:\s"']*)(\+?[\d\s().-]{7,16}\d)/i;

    for (const page of pages) {
      try {
        const res = await politeFetch(page, { signal: AbortSignal.timeout(10_000) });
        if (!res.ok) continue;
        const html = (await res.text()).slice(0, 300_000);
        const email = html.match(emailRe)?.[1] ?? html.match(emailRe)?.[2];
        if (email) results.email = email;
        const phone = html.match(phoneRe)?.[1];
        if (phone) results.phone = phone;
        if (results.email && results.phone) break;
        if (!results.email) {
          const rest = new URL(u.toString());
          rest.pathname = "/contact";
          pages.push(rest.toString()); // next iteration
        }
      } catch {
        continue;
      }
    }
  } catch {
    // bad website URL — skip
  }
  return {
    ...results,
    domainCanon: safeDomain(website),
  };
}

function safeDomain(website: string): string | undefined {
  try {
    return canonicalizeDomain(new URL(website).host);
  } catch {
    return undefined;
  }
}

/** email_extractor Go binary (decision #14, pre-staged at /opt/lodgetrack-scout/bin/).
 * Local binary, no API, honors our politeness flags; falls back to the light
 * in-process scraper when the binary is missing. */
export async function crawlEmails(website: string): Promise<string | null> {
  const bin = process.env.SCOUT_CRAWLER_BIN ?? "/opt/lodgetrack-scout/bin/email_extractor";
  try {
    await execFileP(
      bin,
      [`-url=${website}`, "-depth=1", "-limit-urls=8", "-limit-emails=10", "-sleep=1200", "-timeout=8000", "-out=/tmp/lodgetrack-ee.txt"],
      { timeout: 45_000 }
    );
    const fs = await import("node:fs");
    const file = fs.readFileSync("/tmp/lodgetrack-ee.txt", "utf8");
    const emails = file
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => /.+@.+\..+/.test(l) && !/\.png|\.jpg|example\.com|cloudflare|sentry|wixpress|@(no-?reply|smtp)/i.test(l));
    const role = emails.find((e) => /^(info|booking|contact|office|hello|rezerv|recep|stay)[._-]?/i.test(e));
    const chosen = role ?? emails.find((e) => !/(gmail|yahoo|hotmail|outlook|icloud)\./i.test(e)) ?? emails[0];
    fs.rmSync("/tmp/lodgetrack-ee.txt", { force: true });
    return chosen ?? null;
  } catch (e) {
    addEvent("error", `crawler ${website.slice(0, 60)}: ${String(e).slice(0, 90)}`);
    try {
      const fallback = await enrichWebsite(website);
      return fallback.email ?? null;
    } catch {
      return null;
    }
  }
}

/** MX gate: Node built-in resolver (decision #14 — no external validation services). */
export async function hasMx(domain: string): Promise<boolean> {
  try {
    const recs = await dns.promises.resolveMx(domain);
    return Array.isArray(recs) && recs.length > 0;
  } catch {
    return false;
  }
}

const CITY_COUNTRY: Record<string, string> = {
  lisbon: "Portugal",
  porto: "Portugal",
  faro: "Portugal",
  barcelona: "Spain",
  valencia: "Spain",
  "palma de mallorca": "Spain",
  seville: "Spain",
};

/** Run one full sweep. decision #14 modification: pass ONE city to rotate the
 * daily-rotation stream; omit to sweep all configured cities (legacy/weekly). */
export async function sweepCities(onlyCity?: string): Promise<void> {
  if (!config.leadfinder.enabled) {
    addEvent("lead", "leadfinder disabled (SCOUT_LEADFINDER_ENABLED)");
    return;
  }
  const cities = config.leadfinder.cities.split(",").map((c) => c.trim()).filter(Boolean);
  const run = onlyCity ? cities.filter((c) => c.toLowerCase() === onlyCity.toLowerCase()) : cities;
  let total = 0;
  for (const city of run) {
    if (total >= config.leadfinder.maxPerRun) break;
    const sweep = await geocodeCity(city);
    if (!sweep) {
      addEvent("lead", `geocode failed: ${city}`);
      continue;
    }
    let pois: Poi[] = [];
    try {
      pois = await overpassQuery(sweep);
    } catch (e) {
      addEvent("error", `overpass ${city}: ${String(e)}`);
      continue;
    }
    for (const poi of pois) {
      if (total >= config.leadfinder.maxPerRun) break;
      const domain = poi.website ? safeDomain(poi.website) : undefined;
      if (!poi.website && !poi.phone) continue;

      // dedupe: identity is (source, external_id) first, then domain — the same
      // business listed in two cities merges into ONE entity, never a twin
      const extId = `${poi.osmType}/${poi.osmId}`;
      const existing = findEntityByOsmId(extId)
        ?? (domain ? findEntityByCanon(undefined, domain) : undefined);
      // already processed on a previous sweep — free skip. Fix 2026-11-16: dupes
      // must NOT burn the maxPerRun budget, otherwise a re-sweep always re-hits
      // the same first-N POIs and the long tail of the city is never reached.
      if (existing?.research_note) continue;
      if (existing && existing.source === "osm" && domain) {
        addEvent("lead", `dup domain ${domain}: enriching entity ${existing.id}`);
      }
      const entityId = existing?.id
        ?? upsertEntity({
            kind: "org",
            name: poi.name,
            domain_canon: domain ?? null,
            phone_canon: poi.phone ? poi.phone.replace(/\D/g, "") : null,
            city: poi.city,
            source: "osm",
            external_id: `${poi.osmType}/${poi.osmId}`,
          });

      let emailCanon: string | null = null;
      if (existing?.email_canon) {
        emailCanon = existing.email_canon; // merge-keep semantics
      } else if (poi.website) {
        const crawled = await crawlEmails(poi.website);
        if (crawled) emailCanon = canonicalizeEmail(crawled);
      }
      const country = CITY_COUNTRY[poi.city.toLowerCase()] ?? null;

      upsertEntity({
        kind: "org",
        name: poi.name,
        domain_canon: domain ?? null,
        email_canon: emailCanon,
        phone_canon: poi.phone ? poi.phone.replace(/\D/g, "") : null,
        city: poi.city,
        source: "osm",
        external_id: `${poi.osmType}/${poi.osmId}`,
      });

      let mxOk = false;
      if (emailCanon) {
        mxOk = await hasMx(emailCanon.split("@")[1]);
        if (!mxOk) {
          addEvent("lead", `entity ${entityId}: MX fail ${emailCanon} → unusable`);
          emailCanon = null;
        }
      }
      const note = await generateResearchNote({
        name: poi.name,
        city: poi.city,
        category: poi.category ?? "accommodation",
        website: poi.website ?? null,
        hasEmail: !!emailCanon,
        hasPhone: !!poi.phone,
      });
      setEntityResearch(
        entityId,
        poi.category ?? "accommodation",
        country ?? "",
        (note ?? "").slice(0, 400),
        emailCanon ? "crawler" : "none",
        !!emailCanon
      );

      const state = emailCanon ? "contactable" : poi.phone ? "enriched" : "new";
      upsertContact(entityId, "email", state);
      total++;
    }
    addEvent("lead", `city sweep ${city}: ${pois.length} POIs, cumulative ${total}`);
  }
  addEvent("lead", `sweep complete: ${total} leads this run`);
}

/** Contacts that CAN be emailed today under per-day caps (caller computes caps). */
export function contactableToday(limit: number): Array<{ entity_id: number; name: string; email: string | null }> {
  const rows = db
    .prepare(
      `SELECT e.id AS entity_id, e.name, e.email_canon AS email
       FROM entities e JOIN contacts c ON c.entity_id = e.id
       WHERE e.email_canon IS NOT NULL AND c.state = 'contactable'
       ORDER BY c.created_at DESC LIMIT ?`
    )
    .all(limit) as Array<{ entity_id: number; name: string; email: string | null }>;
  return rows.filter((r) => r.email && !isContactBlocked(r.entity_id, "email"));
}
