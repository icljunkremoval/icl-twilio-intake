const BASE_COORD = { lat: 33.9776848, lng: -118.3523303 };

const TIER_RANK = {
  primary: 0,
  nearby: 1,
  regional: 2,
  far: 3,
  restricted: 4,
  closed: 5
};

const SITES = [
  {
    id: "south_gate_lacsd",
    name: "South Gate Transfer Station (LACSD)",
    kind: "transfer",
    tier: "primary",
    status: "open",
    address: "9530 S Garfield Ave, South Gate, CA 90280",
    phone: "(562) 927-0146",
    lat: 33.9441529,
    lng: -118.1663537,
    msw: true,
    accepts: "MSW, inert waste",
    hours_text: "Mon-Sat 6:00 AM-4:30 PM · Sun closed",
    schedule: { 1: [[360, 990]], 2: [[360, 990]], 3: [[360, 990]], 4: [[360, 990]], 5: [[360, 990]], 6: [[360, 990]] },
    notes: "ICL default site. Hard unload cutoff around 4:50 PM. Tarp loads to avoid surcharges."
  },
  {
    id: "compton_republic",
    name: "Republic Compton Transfer",
    kind: "transfer",
    tier: "primary",
    status: "open",
    address: "2509 W Rosecrans Ave, Compton, CA 90059",
    phone: "(310) 327-8461",
    lat: 33.9033397,
    lng: -118.2443543,
    msw: true,
    accepts: "MSW, recyclables",
    hours_text: "Mon-Fri 6:00 AM-5:30 PM · Sat/Sun closed",
    schedule: { 1: [[360, 1050]], 2: [[360, 1050]], 3: [[360, 1050]], 4: [[360, 1050]], 5: [[360, 1050]] },
    notes: "Weekday-only primary backup near ICL territory."
  },
  {
    id: "waste_resources_gardena",
    name: "Waste Resources Recovery",
    kind: "transfer",
    tier: "primary",
    status: "call",
    address: "357 W Compton Blvd, Gardena, CA 90247",
    phone: "(310) 366-7600",
    lat: 33.8961185,
    lng: -118.1966994,
    msw: true,
    accepts: "MSW, recyclables",
    hours_text: "Call to confirm current commercial hours",
    schedule: {},
    notes: "Very close. Call ahead for commercial access/rates."
  },
  {
    id: "american_waste_gardena",
    name: "American Waste Transfer (Republic)",
    kind: "transfer",
    tier: "nearby",
    status: "open",
    address: "1449 W Rosecrans Ave, Gardena, CA 90249",
    phone: "(310) 527-6980",
    lat: 33.9020035,
    lng: -118.301722,
    msw: true,
    accepts: "MSW, recyclables",
    hours_text: "Mon 5:00 AM-5:30 PM · Sat 5:00 AM-4:00 PM · Tue-Fri/Sun closed",
    schedule: { 1: [[300, 1050]], 6: [[300, 960]] },
    notes: "Limited schedule. No tires, paint, or HHW."
  },
  {
    id: "culver_city_transfer",
    name: "Culver City Transfer & Recycling",
    kind: "transfer",
    tier: "nearby",
    status: "call",
    address: "9255 W Jefferson Blvd, Culver City, CA 90232",
    phone: "(310) 253-5635",
    lat: 33.9836,
    lng: -118.3907,
    msw: true,
    accepts: "MSW, recyclables, e-waste (Sat)",
    hours_text: "Call to confirm commercial access and current hours",
    schedule: {},
    notes: "City-operated. Jurisdiction/access rules may apply."
  },
  {
    id: "dart_downey",
    name: "DART / Athens Downey Transfer",
    kind: "transfer",
    tier: "nearby",
    status: "open",
    address: "9770 Washburn Rd, Downey, CA 90241",
    phone: "(562) 622-3503",
    lat: 33.924255,
    lng: -118.113248,
    msw: true,
    accepts: "MSW, recyclables",
    hours_text: "Mon-Fri 6:00 AM-5:30 PM · Sat 6:00 AM-1:30 PM · Sun closed",
    schedule: { 1: [[360, 1050]], 2: [[360, 1050]], 3: [[360, 1050]], 4: [[360, 1050]], 5: [[360, 1050]], 6: [[360, 810]] },
    notes: "Nearby secondary option. Confirm Athens commercial policy."
  },
  {
    id: "carson_wm",
    name: "WM Carson Transfer & MRF",
    kind: "transfer",
    tier: "nearby",
    status: "call",
    address: "321 W Francisco St, Carson, CA 90745",
    phone: "(310) 217-6300",
    lat: 33.8503778,
    lng: -118.282476,
    msw: true,
    accepts: "MSW, recyclables",
    hours_text: "Call to confirm",
    schedule: {},
    notes: "WM facility; verify rates and access before first run."
  },
  {
    id: "puente_hills_mrf",
    name: "Puente Hills MRF (LACSD)",
    kind: "transfer",
    tier: "regional",
    status: "open",
    address: "13130 Crossroads Pkwy S, City of Industry, CA 91746",
    phone: "(562) 908-4288 ext. 6074",
    lat: 34.0310902,
    lng: -118.0114286,
    msw: true,
    accepts: "MSW, food/green waste, recyclables",
    hours_text: "Mon-Sat 4:00 AM-5:00 PM · Sun closed",
    schedule: { 1: [[240, 1020]], 2: [[240, 1020]], 3: [[240, 1020]], 4: [[240, 1020]], 5: [[240, 1020]], 6: [[240, 1020]] },
    notes: "Best pre-dawn run option. Safety vest required."
  },
  {
    id: "wm_south_gate",
    name: "WM South Gate Transfer",
    kind: "transfer",
    tier: "regional",
    status: "open",
    address: "4489 Ardine St, South Gate, CA 90280",
    phone: "(323) 560-8488",
    lat: 33.9577384,
    lng: -118.1904151,
    msw: true,
    accepts: "MSW, recyclables",
    hours_text: "Mon-Sat 8:00 AM-5:00 PM",
    schedule: { 1: [[480, 1020]], 2: [[480, 1020]], 3: [[480, 1020]], 4: [[480, 1020]], 5: [[480, 1020]], 6: [[480, 1020]] },
    notes: "Secondary South Gate option with later start time."
  },
  {
    id: "sunshine_canyon",
    name: "Sunshine Canyon Landfill",
    kind: "landfill",
    tier: "regional",
    status: "open",
    address: "14747 San Fernando Rd, Sylmar, CA 91342",
    phone: "(818) 362-2124",
    lat: 34.3032234,
    lng: -118.4644237,
    msw: true,
    accepts: "MSW, C&D, green waste, tires, dirt",
    hours_text: "Mon-Fri 6:00 AM-6:00 PM · Sat 7:00 AM-12:00 PM · Sun closed",
    schedule: { 1: [[360, 1080]], 2: [[360, 1080]], 3: [[360, 1080]], 4: [[360, 1080]], 5: [[360, 1080]], 6: [[420, 720]] },
    notes: "Large open-access landfill. Hand-unload cutoffs apply."
  },
  {
    id: "calabasas_landfill",
    name: "Calabasas Landfill",
    kind: "landfill",
    tier: "regional",
    status: "open",
    address: "5300 Lost Hills Rd, Agoura Hills, CA 91301",
    phone: "(818) 889-0363",
    lat: 34.1455,
    lng: -118.7052,
    msw: true,
    accepts: "MSW, inert, green waste, manifested tires",
    hours_text: "Mon-Fri 8:00 AM-5:00 PM · Sat 8:00 AM-2:30 PM · Sun closed",
    schedule: { 1: [[480, 1020]], 2: [[480, 1020]], 3: [[480, 1020]], 4: [[480, 1020]], 5: [[480, 1020]], 6: [[480, 870]] },
    notes: "Use for west-of-405 jobs where wasteshed qualifies."
  },
  {
    id: "scholl_canyon",
    name: "Scholl Canyon Landfill",
    kind: "landfill",
    tier: "restricted",
    status: "restricted",
    address: "3001 Scholl Canyon Rd, Glendale, CA 91206",
    phone: "(818) 243-9779",
    lat: 34.1491881,
    lng: -118.1901798,
    msw: true,
    accepts: "MSW",
    hours_text: "Mon-Fri 8:00 AM-5:00 PM · Sat 8:00 AM-3:30 PM · Sun closed",
    schedule: { 1: [[480, 1020]], 2: [[480, 1020]], 3: [[480, 1020]], 4: [[480, 1020]], 5: [[480, 1020]], 6: [[480, 930]] },
    notes: "Wasteshed-restricted to Glendale/Pasadena area. Do NOT use for standard ICL jobs."
  },
  {
    id: "chiquita_canyon",
    name: "Chiquita Canyon Landfill",
    kind: "landfill",
    tier: "closed",
    status: "closed",
    address: "29201 Henry Mayo Dr, Castaic, CA 91384",
    phone: "—",
    lat: 34.432,
    lng: -118.646,
    msw: true,
    accepts: "N/A",
    hours_text: "Permanently closed (Jan 1, 2025)",
    schedule: {},
    notes: "Remove from routing tools and dispatch playbooks."
  }
];

function haversineMiles(lat1, lng1, lat2, lng2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 3958.7613;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function getPacificParts(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(now);
  const map = {};
  parts.forEach((p) => { if (p.type !== "literal") map[p.type] = p.value; });
  const dayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { day: dayMap[String(map.weekday || "Sun")] ?? 0, mins: Number(map.hour || 0) * 60 + Number(map.minute || 0) };
}

function fmtClock(mins) {
  const m = ((mins % 1440) + 1440) % 1440;
  const h24 = Math.floor(m / 60);
  const mm = String(m % 60).padStart(2, "0");
  const h12 = ((h24 + 11) % 12) + 1;
  const ap = h24 >= 12 ? "PM" : "AM";
  return `${h12}:${mm} ${ap}`;
}

function nextOpenWindow(site, pt) {
  const sched = site?.schedule || {};
  for (let i = 0; i < 7; i += 1) {
    const d = (pt.day + i) % 7;
    const wins = Array.isArray(sched[d]) ? sched[d] : [];
    if (!wins.length) continue;
    if (i === 0) {
      const f = wins.find((w) => pt.mins < Number(w[0]));
      if (f) return { day: d, start: Number(f[0]) };
      continue;
    }
    return { day: d, start: Number(wins[0][0]) };
  }
  return null;
}

function baseAvailability(site, now = new Date()) {
  const st = String(site?.status || "").toLowerCase();
  if (st === "closed") return { state: "closed", label: "Closed", source: "baseline" };
  if (st === "restricted") return { state: "restricted", label: "Restricted", source: "baseline" };
  if (st === "call") return { state: "call", label: "Call ahead", source: "baseline" };
  const pt = getPacificParts(now);
  const wins = Array.isArray(site?.schedule?.[pt.day]) ? site.schedule[pt.day] : [];
  for (const w of wins) {
    const s = Number(w[0]);
    const e = Number(w[1]);
    if (pt.mins >= s && pt.mins < e) return { state: "open", label: `Open now · until ${fmtClock(e)}`, source: "schedule" };
  }
  const nxt = nextOpenWindow(site, pt);
  if (nxt) {
    const dayLbl = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][nxt.day];
    return { state: "closed_now", label: `Closed · opens ${dayLbl} ${fmtClock(nxt.start)}`, source: "schedule" };
  }
  return { state: "unknown", label: "Hours unavailable", source: "schedule" };
}

function applyOverride(base, override, now = new Date()) {
  if (!override) return base;
  const until = override.active_until ? new Date(override.active_until) : null;
  if (until && Number.isFinite(until.getTime()) && until.getTime() <= now.getTime()) return base;
  const st = String(override.override_state || "").toLowerCase();
  if (!st || st === "clear") return base;
  const reason = String(override.reason || "").trim();
  const suffix = reason ? ` · ${reason}` : "";
  const labelMap = {
    open: "Open (override)",
    closed: "Closed (override)",
    outage: "Outage (override)",
    call: "Call ahead (override)",
    restricted: "Restricted (override)"
  };
  return {
    state: st,
    label: `${labelMap[st] || "Override"}${suffix}`,
    source: "override",
    updated_at: override.updated_at || null,
    updated_by: override.updated_by || null
  };
}

function enrichSite(site, overridesMap, now) {
  const ov = overridesMap.get(String(site.id || ""));
  const availability = applyOverride(baseAvailability(site, now), ov, now);
  const dist = haversineMiles(BASE_COORD.lat, BASE_COORD.lng, Number(site.lat), Number(site.lng));
  return {
    ...site,
    availability,
    distance_to_base_mi: Number.isFinite(dist) ? Number(dist.toFixed(2)) : null,
    status_source: availability.source || "baseline"
  };
}

function listDumpSites({ filter = "all", now = new Date(), overrides = [] } = {}) {
  const map = new Map((Array.isArray(overrides) ? overrides : []).map((o) => [String(o.site_id || ""), o]));
  let sites = SITES.map((s) => enrichSite(s, map, now));
  const f = String(filter || "all").toLowerCase();
  if (f === "msw") sites = sites.filter((s) => !!s.msw && !["closed", "restricted"].includes(String(s.availability?.state || "")));
  if (f === "open") sites = sites.filter((s) => String(s.availability?.state || "") === "open");
  sites.sort((a, b) => {
    const ta = TIER_RANK[a.tier] ?? 9;
    const tb = TIER_RANK[b.tier] ?? 9;
    if (ta !== tb) return ta - tb;
    return Number(a.distance_to_base_mi || 999) - Number(b.distance_to_base_mi || 999);
  });
  return sites;
}

function recommendDumpSites({ lat = BASE_COORD.lat, lng = BASE_COORD.lng, now = new Date(), overrides = [], requireMsw = true, limit = 2 } = {}) {
  const map = new Map((Array.isArray(overrides) ? overrides : []).map((o) => [String(o.site_id || ""), o]));
  const rankings = SITES
    .map((s) => enrichSite(s, map, now))
    .filter((s) => !requireMsw || !!s.msw)
    .filter((s) => !["closed", "restricted"].includes(String(s.availability?.state || "")))
    .map((s) => {
      const d = haversineMiles(Number(lat), Number(lng), Number(s.lat), Number(s.lng));
      const tierPenalty = { primary: 0, nearby: 6, regional: 12, far: 20, restricted: 40, closed: 60 }[String(s.tier || "regional")] ?? 10;
      const statePenalty = { open: 0, closed_now: 2.5, call: 4, outage: 10, unknown: 5 }[String(s.availability?.state || "unknown")] ?? 5;
      return { ...s, distance_mi: Number(d.toFixed(2)), score: Number((d + tierPenalty + statePenalty).toFixed(3)) };
    })
    .sort((a, b) => a.score - b.score);
  return rankings.slice(0, Math.max(1, Number(limit || 2)));
}

module.exports = {
  BASE_COORD,
  DUMP_SITES: SITES,
  listDumpSites,
  recommendDumpSites
};
