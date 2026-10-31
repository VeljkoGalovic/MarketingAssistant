import { config } from "../config.ts";
import {
  addEvent,
  canonicalizeEmail,
  canonicalizeDomain,
  db,
  isContactBlocked,
  upsertContact,
  upsertEntity,
} from "../db.ts";

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

export interface Poi {
  osmType: string;
  osmId: number;
  name: string;
  website?: string;
  phone?: string;
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

/** Run one full sweep across the configured cities. Threshold-controlled. */
export async function sweepCities(): Promise<void> {
  if (!config.leadfinder.enabled) {
    addEvent("lead", "leadfinder disabled (SCOUT_LEADFINDER_ENABLED)");
    return;
  }
  const cities = config.leadfinder.cities.split(",").map((c) => c.trim()).filter(Boolean);
  let total = 0;
  for (const city of cities) {
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

      const entityId = upsertEntity({
        kind: "org",
        name: poi.name,
        domain_canon: domain ?? null,
        phone_canon: poi.phone ? poi.phone.replace(/\D/g, "") : null,
        city: poi.city,
        source: "osm",
        external_id: `${poi.osmType}/${poi.osmId}`,
      });

      let state = "new";
      if (poi.website) {
        const enriched = await enrichWebsite(poi.website);
        let emailCanon: string | null = null;
        if (enriched.email) emailCanon = canonicalizeEmail(enriched.email);
        upsertEntity({
          kind: "org",
          name: poi.name,
          domain_canon: domain ?? null,
          email_canon: emailCanon,
          city: poi.city,
          source: "osm",
          external_id: `${poi.osmType}/${poi.osmId}`,
        });
        state = emailCanon ? "contactable" : "enriched";
      } else {
        state = "enriched";
      }

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
