/* Astrarium web GUI.
 * Rendering: server supplies apparent-of-date RA/Dec (full DE+ERFA chain);
 * the client performs only the rigid LST/latitude rotation to alt-az
 * (no refraction in the moving view — standard for charts) so that time
 * playback stays smooth at 30+ fps; data is re-fetched when the
 * simulated clock drifts > 20 min from the last server solution.
 * Accessibility: aria-live regions, all controls are native elements.
 *
 * Layers (back to front): background/twilight, moon glow, Milky Way,
 * coordinate grids (alt-az / equatorial / ecliptic / galactic),
 * constellation lines, deep (Tycho-2) stars, bright stars, names, DSO,
 * planets, comets/asteroids.  All drawing goes through render() so the
 * same code paints the screen and the white-background PNG/PDF export.
 */
"use strict";

const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

/* Stored satellite settings from before the defaults changed: drop the
 * groups and the magnitude limit so the new ones apply, keep everything
 * the observer set since. */
const SAT_SETTINGS_V = 2;
function migrateSatSettings(saved) {
  if (!saved) return {};
  if (saved.v >= SAT_SETTINGS_V) return saved;
  const { groups, maxmag, ...rest } = saved;
  return rest;
}

const state = {
  lang: localStorage.getItem("lang") || "ja",
  site: localStorage.getItem("site") || "jp-tokyo",
  nv: localStorage.getItem("nv") === "1",
  simOffsetMs: 0,          // simulated - real
  playing: false,
  playDir: 1,              // +1 forward, -1 backward (speed = magnitude)
  speed: 600,
  lastFetchSim: 0,
  sky: null,               // /api/sky payload
  i18n: {},
  sites: [],
  siteGroups: [],
  siteRegions: [],
  events: [],
  view: { mode: "allsky", azCenter: 180, fov: 120, zoom: 1.0,
          follow: null,    // {ra,dec,name}: object held at the centre
          altOffset: 0,    // altOffset [deg]: vertical pan in horizon mode
          // all-sky pan center (azimuthal equidistant); alt 90 = zenith.
          // az defaults to 180 so the zenith-centered formula reduces
          // exactly to the historical north-up chart.
          allskyCenter: { az: 180, alt: 90 } },
  opts: JSON.parse(localStorage.getItem("opts") || "null") || {
    lines: true, connames: true, starnames: true, planets: true,
    // only the horizon grid to begin with: the ecliptic and equatorial
    // grids answer a question the observer has not asked yet
    dso: false, grid_altaz: true, grid_eq: false, grid_ecl: false,
    grid_gal: false, milkyway: false, skyglow: true, moonglow: true,
    line_equator: false, line_ecliptic: false, line_meridian: false,
    conart: false,
    mirror: false, maglimit: 6.5,
  },
  selectedSB: JSON.parse(localStorage.getItem("selectedSB") || "[]"),
  sbCatalog: [],           // /api/smallbodies listing (current search)
  sbFetched: null,         // {comets: iso, asteroids: iso}
  deepStars: null,         // /api/deepstars rows for the current view
  selected: null,
  fovFrames: JSON.parse(localStorage.getItem("fovFrames") || "[]"),
  fovSelected: null,       // id of the last-touched FOV frame
  horizonMask: null,       // /api/horizon_mask payload for current site
  conInfo: null,           // /api/constellations_info map (or null)
  dsoPhotos: null,         // /api/dso_photos index (or null)
  // 人工衛星: TLE/SGP4 tracks streamed from /api/satellites
  // Out of the box: the space stations and the naked-eye list, down to
  // magnitude 4 — what an observer without a telescope can actually
  // follow.  `v` marks settings written since that became the default,
  // so a phone that stored the old 6.0 before it existed is moved on
  // once instead of showing a limit nobody chose.
  sat: Object.assign({
    on: false, groups: ["stations", "visual"], maxmag: 4.0,
    sunlitOnly: true,
  }, migrateSatSettings(JSON.parse(localStorage.getItem("sat") || "null")), {
    data: null, t0: 0, step: 5, n: 25, fetching: false,
    available: false, loaded: 0, groupMeta: [],
  }),
};
if (!Array.isArray(state.sat.groups)) state.sat.groups = ["stations"];
if (!Array.isArray(state.fovFrames)) state.fovFrames = [];
/* 2026-07-26: Four Thirds and the two fixed telescope+eyepiece presets
 * were dropped.  Saved frames that used them are converted to an
 * equivalent custom frame so no stored composition silently changes
 * size (an unknown preset id would fall back to 36x24 @ 50 mm). */
(function migrateFovPresets(frames) {
  const gone = {
    m43_300: { kind: "rect", w: 17.3, h: 13, f: 300 },
    t10f6e25: { kind: "circle", afov: 52, mag: 600 / 25 },
    t20f10e25: { kind: "circle", afov: 52, mag: 2000 / 25 },
    t20f10e10: { kind: "circle", afov: 62, mag: 2000 / 10 },
  };
  for (const fr of frames) {
    const sub = gone[fr.preset];
    if (!sub) continue;
    fr.custom = Object.assign({ w: 36, h: 24, f: 50, afov: 52, mag: 40 },
                              fr.custom, sub);
    fr.preset = "custom";
  }
})(state.fovFrames);
if (state.fovFrames.length)
  state.fovSelected = state.fovFrames[state.fovFrames.length - 1].id;

/* migrate old persisted opts (grid/ecliptic/equator) to the four
 * independent grid toggles; fill defaults for keys added later */
(function migrateOpts(o) {
  if (o.grid_altaz === undefined)
    o.grid_altaz = o.grid !== undefined ? o.grid : true;
  if (o.grid_ecl === undefined)
    o.grid_ecl = o.ecliptic !== undefined ? o.ecliptic : false;
  if (o.grid_eq === undefined)
    o.grid_eq = o.equator !== undefined ? o.equator : false;
  if (o.grid_gal === undefined) o.grid_gal = false;
  if (o.milkyway === undefined) o.milkyway = false;
  if (o.skyglow === undefined) o.skyglow = true;
  if (o.moonglow === undefined) o.moonglow = true;
  for (const k of ["line_equator", "line_ecliptic", "line_meridian"])
    if (o[k] === undefined) o[k] = false;
  // 2026-07-19: default limiting magnitude changed 5.5 -> 6.5
  if (o._magDefault65 === undefined) {
    if (o.maglimit === 5.5) o.maglimit = 6.5;
    o._magDefault65 = 1;
  }
  // 2026-07-24: user request — reset any stored value to 6.5 once
  // (the slider itself still allows 1..12)
  if (o._magReset65 === undefined) {
    o.maglimit = 6.5;
    o._magReset65 = 1;
  }
  // 2026-07-24: slider maximum is now 6.5 mag (user request) —
  // clamp any stored deeper value
  if (o.maglimit > 6.5) o.maglimit = 6.5;
  if (o.trails === undefined) o.trails = false;
  if (o.conart === undefined) o.conart = false;
  // 2026-07-26: the realistic photograph became opt-in; the default is
  // the monochrome star-density map
})(state.opts);

function saveOpts() { localStorage.setItem("opts", JSON.stringify(state.opts)); }
function simNow() { return new Date(Date.now() + state.simOffsetMs); }
function t(key, vars) {
  let s = state.i18n[key] || key;
  if (vars) for (const [k, v] of Object.entries(vars))
    s = s.replace(new RegExp(`\\{${k}\\}`, "g"), v);
  return s;
}

/* ---------------- API ---------------- */
async function api(path, params = {}) {
  const q = new URLSearchParams(params);
  const r = await fetch(`/api/${path}?${q}`);
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json();
}

/* Every visible string comes from data/i18n/<lang>.json.  Besides element
 * text (data-i18n) the loader also fills the attributes that carry user
 * text — tooltips, input placeholders and accessible names — so nothing
 * is left in the authoring language when the UI is switched. */
async function loadI18n() {
  state.i18n = await api("i18n", { lang: state.lang });
  $$("[data-i18n]").forEach((el) => {
    el.textContent = t(el.dataset.i18n);
  });
  $$("[data-i18n-title]").forEach((el) => {
    el.title = t(el.dataset.i18nTitle);
  });
  $$("[data-i18n-placeholder]").forEach((el) => {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  });
  $$("[data-i18n-aria]").forEach((el) => {
    el.setAttribute("aria-label", t(el.dataset.i18nAria));
  });
  $("#lang-toggle").textContent = state.lang === "ja" ? "EN" : "日本語";
  document.title = `Astrarium ${t("ui.app_title")}`;
  document.documentElement.lang = state.lang;
  // the native datetime picker takes its field order and placeholder
  // from the element's own lang, not from the browser locale
  $("#t-input").lang = state.lang === "ja" ? "ja-JP" : "en-GB";
  state._altazLines = null;        // cardinal labels are language-bound
  state._circCache = null;         // so are the named-circle labels
}

/* ---------------- 観測地の階層メニュー ------------------------------
 * The register runs to ~3000 entries once the MPC observatory codes are
 * loaded, which is far too many for one <select>.  It is presented as a
 * hierarchy instead: a category menu (日本 / 国内星見スポット / 国内
 * 天文台 / 海外天文台 / 海外主要都市 / continents) drives a site menu,
 * and inside the observatory categories the sites are further grouped by
 * region with <optgroup>.  Only the category being shown is fetched.
 *
 * Observatory entries are labelled "code · name" so the browser's
 * type-ahead finds a station by its MPC code.
 */
function siteLabel(s) {
  const name = (state.lang === "ja" ? s.name_ja : s.name_en) ||
    s.name_en || s.name_ja || s.id;
  if (s.mpc_code) return `${s.mpc_code} · ${name}`;
  // A capital on its own is a guessing game — Tirana, Vientiane, Asunción
  // are not names most people can place.  The country is what the
  // observer is actually choosing by.
  const country = state.lang === "ja" ? s.country_ja : s.country_en;
  if (country && (s.category === "capital" || s.category === "world_city")
      && s.region !== "japan")
    return `${name}（${country}）`;
  return name;
}

/* An observing position typed in by hand, encoded as a site id the
 * server understands (@lat,lon,elev,tz).  This is what keeps the app
 * fully usable when location services are refused. */
function customSiteSpec(lat, lon, elev) {
  const tz = (Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  return `@${lat.toFixed(6)},${lon.toFixed(6)},` +
         `${(elev || 0).toFixed(1)},${tz}`;
}
function customSiteLabel(id) {
  const p = id.slice(1).split(",");
  const lat = parseFloat(p[0]), lon = parseFloat(p[1]);
  if (!isFinite(lat) || !isFinite(lon)) return id;
  return `${Math.abs(lat).toFixed(4)}\u00b0${lat >= 0 ? "N" : "S"} ` +
         `${Math.abs(lon).toFixed(4)}\u00b0${lon >= 0 ? "E" : "W"}`;
}

function fillSiteSelect(sites, grouped) {
  const sel = $("#site-select");
  sel.innerHTML = "";
  // the hand-entered position is not in any group, so it is added here
  if (state.site && state.site.startsWith("@")) {
    const o = document.createElement("option");
    o.value = state.site;
    o.textContent = `\u{1F4CD} ${customSiteLabel(state.site)}`;
    sel.appendChild(o);
  }
  const mk = (s) => {
    const o = document.createElement("option");
    o.value = s.id;
    o.textContent = siteLabel(s);
    return o;
  };
  if (grouped && state.siteRegions.length) {
    for (const r of state.siteRegions) {
      const members = sites.filter((s) => s.region === r.key);
      if (!members.length) continue;
      const og = document.createElement("optgroup");
      og.label = state.lang === "ja" ? r.ja : r.en;
      for (const s of members) og.appendChild(mk(s));
      sel.appendChild(og);
    }
    const rest = sites.filter(
      (s) => !state.siteRegions.some((r) => r.key === s.region));
    for (const s of rest) sel.appendChild(mk(s));
  } else {
    for (const s of sites) sel.appendChild(mk(s));
  }
  state.sites = sites;
  if (sites.find((s) => s.id === state.site)) sel.value = state.site;
}

function fillGroupSelect() {
  const sel = $("#site-group");
  const keep = sel.value;
  sel.innerHTML = "";
  for (const g of state.siteGroups) {
    const o = document.createElement("option");
    o.value = g.key;
    o.textContent = (state.lang === "ja" ? g.ja : g.en) +
      (g.count ? ` (${g.count})` : "");
    sel.appendChild(o);
  }
  if (keep) sel.value = keep;
}

/* load one category (or the search hits) into the site menu */
/* The Japanese menus keep their customary north-to-south order; the
 * rest are lists of places with nothing else to order them by, so they
 * are sorted by the name actually on screen — alphabetically in
 * English, by kana in Japanese, rather than by a name the reader
 * cannot see. */
const SITE_GROUPS_IN_ORDER = new Set(["japan", "jp_obs"]);
/* The dark-sky spots are a Japanese list and read north to south, like
 * the prefectures above them; the server sends them that way. */
const SITE_GROUPS_BY_LATITUDE = new Set(["jp_dark"]);
/* What a Japanese menu is alphabetised on: the reading, where the data
 * carries one — 北京 belongs under ペ.  Latin names are compared as
 * they are written. */
function siteSortKey(s) {
  return state.lang === "ja"
    ? (s.name_kana || s.name_ja || s.name_en || "")
    : (s.name_en || s.name_ja || "");
}
function sortSitesForMenu(sites, group) {
  if (SITE_GROUPS_IN_ORDER.has(group)) return sites;
  if (SITE_GROUPS_BY_LATITUDE.has(group))
    return sites.slice().sort((a, b) => b.lat_deg - a.lat_deg);
  const lang = state.lang === "ja" ? "ja" : "en";
  return sites.slice().sort(
    (a, b) => siteSortKey(a).localeCompare(siteSortKey(b), lang));
}

/* The overseas observatory list is three thousand entries long — the
 * whole MPC register — so it gets a menu of its own between the
 * category and the site: continent first, then the observatory.  A flat
 * list of that length is not a menu, it is a scroll. */
const REGION_MENU_GROUPS = new Set(["obs"]);

function fillRegionSelect(sites, group) {
  const sel = $("#site-region");
  if (!sel) return null;
  if (!REGION_MENU_GROUPS.has(group)) {
    sel.hidden = true;
    sel.innerHTML = "";
    return null;
  }
  const present = state.siteRegions.filter(
    (r) => sites.some((s) => s.region === r.key));
  const other = sites.some(
    (s) => !state.siteRegions.some((r) => r.key === s.region));
  sel.innerHTML = present.map((r) =>
    `<option value="${esc(r.key)}">${esc(state.lang === "ja" ? r.ja : r.en)}` +
    ` (${sites.filter((s) => s.region === r.key).length})</option>`).join("") +
    (other ? `<option value="__other">${esc(t("ui.other"))}</option>` : "");
  sel.hidden = !sel.options.length;
  // stay on the region the current site is in, if it is one of these
  const cur = sites.find((x) => x.id === state.site);
  const want = cur && cur.region ? cur.region : (present[0] && present[0].key);
  if (want) sel.value = want;
  if (!sel.value && sel.options.length) sel.value = sel.options[0].value;
  return sel.value;
}

function showRegion(region) {
  const all = state._siteGroupCache || [];
  const shown = region == null ? all
    : region === "__other"
      ? all.filter((s) => !state.siteRegions.some((r) => r.key === s.region))
      : all.filter((s) => s.region === region);
  fillSiteSelect(sortSitesForMenu(shown, state._siteGroupKey),
                 false);
}

async function loadSiteGroup(group) {
  const data = await api("sites", { group, limit: 3000 });
  state.siteGroups = data.groups || state.siteGroups;
  state.siteRegions = data.regions || state.siteRegions;
  fillGroupSelect();
  $("#site-group").value = group;
  state._siteGroupCache = data.sites || [];
  state._siteGroupKey = group;
  const region = fillRegionSelect(state._siteGroupCache, group);
  if (REGION_MENU_GROUPS.has(group)) {
    showRegion(region);
  } else {
    const obs = group === "jp_obs";
    fillSiteSelect(sortSitesForMenu(state._siteGroupCache, group), obs);
  }
}

async function loadSites() {
  // the category menu is the only way in now, so it always shows the
  // category the current site lives in
  const data = await api("sites", { id: state.site });
  state.siteGroups = data.groups || [];
  state.siteRegions = data.regions || [];
  const group = (data.current && data.current.group) ||
    (state.siteGroups[0] && state.siteGroups[0].key) || "japan";
  await loadSiteGroup(group);
}

/* Sky payloads must be applied in the order they were asked for.
 *
 * While the clock is running the tick loop asks for a new sky every time
 * the simulated time has drifted twenty minutes, which at x600 is every
 * couple of seconds — faster than the compute core answers on a phone.
 * Several requests are then in flight at once, and whichever finishes
 * last used to win: an older sky installed after a newer one made the
 * whole chart jump backwards in time, then forwards again.  A sequence
 * number fixes the order, and `_skyInFlight` keeps the tick loop from
 * queueing requests the device cannot keep up with. */
let _skySeq = 0, _skyApplied = 0;
async function fetchSky() {
  const askedFor = simNow().getTime();
  const seq = ++_skySeq;
  const params = {
    site: state.site, time: new Date(askedFor).toISOString(),
    mag: 6.6, lang: state.lang,
  };
  if (state.selectedSB.length)
    params.sb = state.selectedSB.map((s) => s.id).join(",");
  if (!state._skyInFlight) state._skyInFlightSince = performance.now();
  state._skyInFlight = (state._skyInFlight || 0) + 1;
  let sky;
  try {
    sky = await api("sky", params);
  } finally {
    state._skyInFlight -= 1;
  }
  if (seq < _skyApplied) return;         // a newer sky is already up
  _skyApplied = seq;
  state.sky = sky;
  // the moment this payload describes, not the moment it arrived: a
  // slow answer would otherwise make the app think it is up to date
  // when it is already minutes behind
  state.lastFetchSim = askedFor;
  state.skyEpochMs = new Date(state.sky.time.utc_iso + "Z").getTime();
  state._gridCache = null;         // frame matrices are of-date
  // NB: the periodic drift-refetch must NOT clear the trail layer —
  // resetTrails() is called from the user-initiated handlers instead
  updateMilkywayUI();
  updateHints();
  if (state.opts.milkyway) loadMilkyway();
}

async function refreshInfo() {
  const data = await api("tonight", { site: state.site, lang: state.lang,
                                     time: new Date(simNow()).toISOString() });
  const tbl = data.rows.map(
    (r) => `<tr><td>${r[0]}</td><td>${r[1]}</td></tr>`).join("");
  $("#tonight-summary").innerHTML =
    `<b>${t("ui.tonight")}</b><table>${tbl}</table>`;
  state.tonightVoice = data.voice_text;
}

/* label for one lunar-occultation row, e.g. "μ Gem 潜入(暗縁) V3.0" */
function occLabel(o) {
  const kind = t(o.kind === "immersion" ? "event.immersion"
                                        : "event.emersion");
  const limb = t(o.dark_limb ? "ui.dark_limb" : "ui.bright_limb");
  const mag = o.vmag != null ? ` V${(+o.vmag).toFixed(1)}` : "";
  return `${o.star} ${kind}(${limb})${mag}`;
}

const ECLIPSE_KINDS = new Set(["solar_eclipse", "lunar_eclipse"]);
let _eventsPoll = null;

/* second line of an eclipse row: what this observing site actually sees
 * (a geocentric eclipse is often invisible from a given place) */
function eclipseLocalHtml(ev) {
  const e = ev.eclipse;
  if (!e) {
    return ev.value != null
      ? ` <span class="pop-dim">${t("ui.eclipse_magnitude")} ` +
        `${ev.value}</span>` : "";
  }
  if (!e.visible)
    return `<span class="ev-local ev-invisible">` +
      `${t("ui.ecl_not_visible")}</span>`;
  const bits = [];
  if (e.magnitude != null)
    bits.push(`${t("ui.eclipse_magnitude")} ${e.magnitude.toFixed(2)}`);
  else if (ev.value != null)
    bits.push(`${t("ui.eclipse_magnitude")} ${ev.value}`);
  if (e.start_local && e.end_local)
    bits.push(`${e.start_local}–${e.end_local}`);
  else if (e.max_local)
    bits.push(`${t("ui.ecl_max")} ${e.max_local}`);
  if (e.partial_view) bits.push(t("ui.ecl_partial_view"));
  else if (e.alt != null)
    bits.push(`${t("ui.altitude")} ${e.alt.toFixed(0)}°`);
  return `<span class="ev-local">${bits.join(" · ")}</span>`;
}

/* The window is anchored on the real present: `past` days before now,
 * `days` after, so the same control covers 今後 / 過去 / 前後.  Stellar
 * occultations are a separate (slow) scan and only exist forward. */
async function refreshEvents() {
  clearTimeout(_eventsPoll);
  const span = parseFloat($("#events-days").value);
  const dir = $("#events-dir").value;
  const days = dir === "past" ? 0 : span;
  const back = dir === "future" ? 0 : span;
  // the occultation scan only runs forward from now
  const occBox = $("#show-occultations");
  occBox.disabled = days <= 0;
  occBox.parentElement.classList.toggle("disabled", days <= 0);
  const wantOcc = occBox.checked && days > 0;
  const onlyEclipses = $("#only-eclipses").checked;
  const wantSat = $("#show-satpasses").checked && days > 0;
  const loadEl = $("#events-loading");
  loadEl.textContent = t("ui.loading");   // first scan of a window: 5-30 s
  const pOcc = wantOcc
    ? api("occultations", { site: state.site,
        days: Math.min(days, 60), maxmag: 6.0 })
        .catch(() => null)
    : Promise.resolve(null);
  const pSat = wantSat
    ? api("satellite_events",
          { site: state.site, days: Math.min(days, 14), minalt: 20 })
        .catch(() => null)
    : Promise.resolve(null);
  let res, occ, sat;
  try {
    [res, occ, sat] = await Promise.all([
      api("events", { site: state.site, days, back, lang: state.lang }),
      pOcc, pSat]);
  } catch (e) {
    loadEl.textContent = t("ui.update_failed");
    throw e;
  }
  // multi-year windows are scanned in the background; poll until ready
  if (res.pending) {
    loadEl.textContent =
      t("ui.ev_scanning", { done: res.done, total: res.total }) +
      (res.total > 2 ? ` — ${t("ui.ev_long_hint")}` : "");
    clearTimeout(_eventsPoll);
    _eventsPoll = setTimeout(() => refreshEvents().catch(() => {}), 2000);
    return;
  }
  if (res.error) { loadEl.textContent = t("ui.update_failed"); return; }
  const events = res.events || [];
  loadEl.textContent = (wantOcc && !occ) ? t("ui.update_failed") : "";
  state.events = events;
  // merge chronologically (both lists carry ISO time_utc)
  let rows = events.map((ev) => ({ t: ev.time_utc, ev }));
  if (occ && !onlyEclipses)
    for (const o of occ.events) rows.push({ t: o.time_utc, occ: o });
  if (sat && !onlyEclipses)
    for (const p of sat.events) rows.push({ t: p.time_utc, sat: p });
  if (onlyEclipses)
    rows = rows.filter((r) => r.ev && ECLIPSE_KINDS.has(r.ev.kind));
  rows.sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
  const ul = $("#events-list");
  ul.innerHTML = "";
  if (!rows.length) {
    loadEl.textContent = t("ui.ev_none");
    return;
  }
  const now = Date.now();
  for (const r of rows) {
    const li = document.createElement("li");
    // every row jumps the simulated clock to its instant (keyboard too)
    li.className = "ev-jump";
    if (new Date(r.t).getTime() < now) li.className += " ev-past";
    li.tabIndex = 0;
    li.setAttribute("role", "button");
    li.title = t("ui.jump_click_hint");
    const go = () => {
      if (state.demo) stopDemo(false);   // the user has taken the wheel
      jumpToTime(r.t);
      // a meteor-shower row also switches the shower on; a satellite
      // pass draws its track across the sky
      if (r.ev && r.ev.shower) setMeteorShower(r.ev.shower);
      if (r.sat) {
        setSatPass(r.sat);
        setViewMode("horizon");
        state.view.azCenter = r.sat.max_az;
        state.view.fov = 110;
        state.view.altOffset = 0;
        state.view.follow = null;
      } else if (state.satPass) setSatPass(null);
    };
    li.addEventListener("click", go);
    li.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); }
    });
    if (r.sat) {
      const sv = r.sat;
      li.className += " ev-satpass";
      li.innerHTML =
        `<span class="ev-time">${sv.time_local}</span>` +
        `<span class="ev-label">${sv.kind === "iss" ? "🛰 " : "⛓ "}` +
        `${satPassLabel(sv)}</span>`;
      ul.appendChild(li);
      continue;
    }
    if (r.ev) {
      const ev = r.ev;
      const ecl = ECLIPSE_KINDS.has(ev.kind);
      if (ecl) li.className += " ev-eclipse";
      li.innerHTML = `<span class="ev-time">${ev.time_local}</span>` +
        `${ecl ? (ev.kind === "solar_eclipse" ? "🌒 " : "🌕 ") : ""}` +
        `${ev.label}` +
        (!ecl && ev.value != null ? ` (${ev.value})` : "") +
        (ecl ? eclipseLocalHtml(ev) : "");
    } else {
      const oc = r.occ;
      const day = oc.sun_alt > -6;                 // twilight / daytime
      const label = occLabel(oc);
      li.className += " ev-occ" + (day ? " ev-day" : "");
      li.innerHTML =
        `<span class="ev-time">${oc.time_local}</span>` +
        `<span class="ev-label">${day ? "☀ " : ""}${label} ` +
        `${t("ui.illumination")}${Math.round(oc.moon_illum * 100)}% ` +
        `${t("ui.altitude")}${oc.alt.toFixed(0)}°</span>`;
    }
    ul.appendChild(li);
  }
}

/* move the simulated clock to an ISO instant (event list rows) */
function jumpToTime(iso) {
  const when = new Date(iso);
  if (isNaN(when)) return;
  state.simOffsetMs = when - new Date();
  state.playing = false;
  updatePlayButtons();
  resetTrails();
  showScrubOverlay(2500);
  fetchSky().catch(() => {});
  // which showers are running, and which maximum is nearest, both
  // follow the date on screen
  if (state.showers) loadShowers().catch(() => {});
}

/* ---------------- Milky Way texture (mesh-warped panorama) ---------- */
/* /milkyway.png is a 1440x720 grayscale equirectangular panorama
 * (x = ra/360*W with ra 0 at the LEFT edge increasing rightward,
 * y = (90-dec)/180*H, dec +90 at the top).  The image is tinted once
 * per palette at load time; per frame the sphere is drawn as ra/dec
 * quads of two texture-mapped (clip + affine transform) triangles each
 * — see drawMilkywayTex(). */
function loadMilkyway() {
  if (state._mwImg) return;
  if (state._mwLoading) return;
  state._mwLoading = true;
  state._mwImg = null;
  state._mwHi = undefined;
  state._mwBuf = null;
  const img = new Image();
  img.onload = () => {
    try {
      state._mwRaw = img;            // kept for the high-resolution pass
      // Working copy for wide fields, capped at 4.4 px per degree —
      // the rate the drawing samples at anyway (see srcPxPerDeg).  The
      // full-resolution image is kept for the zoomed-in pass, where the
      // buffer is small and the detail is what matters.
      const w = Math.min(img.naturalWidth, 1600);
      const h = Math.round(w / 2);
      const cv = document.createElement("canvas");
      cv.width = w; cv.height = h;
      const x = cv.getContext("2d", { willReadFrequently: true });
      x.drawImage(img, 0, 0, w, h);
      const d = x.getImageData(0, 0, w, h).data;
      const rgb = new Uint8Array(w * h * 3);
      for (let i = 0, j = 0; j < rgb.length; i += 4, j += 3) {
        rgb[j] = d[i]; rgb[j + 1] = d[i + 1]; rgb[j + 2] = d[i + 2];
      }
      state._mwImg = { w, h, rgb };
    } finally { state._mwLoading = false; }
  };
  img.onerror = () => { state._mwLoading = false; };  // retried next toggle
  img.src = "milkyway.png";      // relative: subpath/dist friendly
}

/* The Milky Way is the Tycho-2 star-density map, drawn in neutral
 * monochrome: it is derived from this package's own catalogue, so it is
 * registered to the chart exactly and shows the whole band without
 * pretending to be a photograph. */

/* ---------------- constellation artwork (星座絵) ----------------
 * Stellarium "modern" sky-culture illustrations by Johan Meuris
 * (Free Art License 1.3).  Each image carries 3 anchor stars
 * (pixel <-> ICRS J2000); the affine map that sends the three anchor
 * pixels onto the three projected star positions places the drawing.
 */
let _artIndex = null, _artLoading = false;
const _artImages = {};

async function loadConstellationArt() {
  if (_artIndex || _artLoading) return;
  _artLoading = true;
  try {
    const d = await api("constellation_art");
    const idx = d.available ? d.constellations : {};
    for (const e of Object.values(idx)) {
      e.vec = e.anchors.map((an) => {
        const ra = an.ra * D2R, de = an.dec * D2R;
        return [Math.cos(de) * Math.cos(ra),
                Math.cos(de) * Math.sin(ra), Math.sin(de)];
      });
    }
    _artIndex = idx;
  } catch (_) { _artIndex = {}; }
  finally { _artLoading = false; }
}

function artImage(abbr, file) {
  let im = _artImages[abbr];
  if (im === undefined) {
    im = _artImages[abbr] = new Image();
    im.src = "art/" + file;          // relative: subpath/dist friendly
  }
  return im.complete && im.naturalWidth ? im : null;
}

/* A coarse alpha map of one figure, so a click can be tested against
 * the drawing rather than against its bounding box — the boxes of
 * neighbouring figures overlap heavily (Leo reaches well into Virgo),
 * and picking by box would answer with the wrong constellation. */
const ART_MASK = 64;
const _artMasks = {};
function artMask(abbr, im) {
  let m = _artMasks[abbr];
  if (m) return m;
  const cv = document.createElement("canvas");
  cv.width = cv.height = ART_MASK;
  const cx = cv.getContext("2d", { willReadFrequently: true });
  cx.drawImage(im, 0, 0, ART_MASK, ART_MASK);
  try {
    const d = cx.getImageData(0, 0, ART_MASK, ART_MASK).data;
    m = _artMasks[abbr] = new Uint8Array(ART_MASK * ART_MASK);
    for (let i = 0; i < m.length; i++) m[i] = d[i * 4 + 3];
  } catch (_) { m = _artMasks[abbr] = null; }   // tainted canvas: skip
  return m;
}

/* screen point -> alpha of the figure there, 0 if outside */
function artAlphaAt(r, x, y) {
  const det = r.A * r.D - r.B * r.C;
  if (!det) return 0;
  const dx = x - r.E, dy = y - r.F;
  const u = (r.D * dx - r.C * dy) / det;
  const v = (-r.B * dx + r.A * dy) / det;
  if (u < 0 || v < 0 || u >= r.w || v >= r.h) return 0;
  if (!r.mask) return 1;
  const i = Math.min(ART_MASK - 1, Math.floor(v / r.h * ART_MASK)) * ART_MASK
          + Math.min(ART_MASK - 1, Math.floor(u / r.w * ART_MASK));
  return r.mask[i];
}

/* Which figure is drawn at this canvas point.
 *
 * Several answers can be true at once — the figures overlap freely, and
 * the Little Lion is painted across the Lion's back — so opacity alone
 * picks arbitrarily.  A solid part of a drawing beats a faint one, and
 * between equally solid candidates the one whose own drawing is centred
 * nearest the tap wins: a tap in the middle of Leo means Leo, however
 * many smaller figures are laid over it. */
function artHitAt(x, y) {
  if (!state.opts.conart) return null;
  let best = null, bestSolid = false, bd = Infinity;
  for (const r of state._artHits || []) {
    const a = artAlphaAt(r, x, y);
    if (a <= 24) continue;                    // outside the drawing
    const solid = a >= 128;
    if (bestSolid && !solid) continue;
    const cx = r.A * r.w / 2 + r.C * r.h / 2 + r.E;
    const cy = r.B * r.w / 2 + r.D * r.h / 2 + r.F;
    const d = Math.hypot(cx - x, cy - y);
    if (solid !== bestSolid || d < bd) {
      best = r.abbr; bd = d; bestSolid = solid;
    }
  }
  return best;
}

function drawConstellationArt(c, W, H, pal, lst, lat) {
  const M = state.sky.matrices && state.sky.matrices.j2eq;
  if (!M) return;
  // only the on-screen pass records where the figures landed; an export
  // renders at another size and must not overwrite it
  const hits = c.canvas === canvas ? [] : null;
  const maxSpan = Math.min(W, H) * 1.6;
  c.save();
  c.globalAlpha = pal.nv ? 0.26 : 0.40;
  if (pal.nv)
    c.filter = "sepia(1) saturate(5) hue-rotate(-50deg) brightness(0.7)";
  for (const [abbr, e] of Object.entries(_artIndex)) {
    const pts = [];
    let anyVisible = false;
    for (const v of e.vec) {
      // ICRS anchor -> true equator of date (aberration ~20" ignored)
      const x = M[0][0] * v[0] + M[0][1] * v[1] + M[0][2] * v[2];
      const y = M[1][0] * v[0] + M[1][1] * v[1] + M[1][2] * v[2];
      const z = M[2][0] * v[0] + M[2][1] * v[1] + M[2][2] * v[2];
      const ra = Math.atan2(y, x) / D2R;
      const dec = Math.asin(Math.max(-1, Math.min(1, z))) / D2R;
      const [az, alt] = altaz(ra, dec, lst, lat);
      pts.push(projectRaw(az, alt, W, H));
      if (alt > -3 && project(az, alt, W, H)) anyVisible = true;
    }
    if (!anyVisible) continue;
    // reject wrap-around / behind-view degeneracies
    let span = 0;
    for (let i = 0; i < 3; i++)
      for (let j = i + 1; j < 3; j++)
        span = Math.max(span, Math.hypot(pts[i][0] - pts[j][0],
                                         pts[i][1] - pts[j][1]));
    if (!isFinite(span) || span < 4 || span > maxSpan) continue;
    const im = artImage(abbr, e.file);
    if (!im) continue;
    const an = e.anchors;
    const den = an[0].x * (an[1].y - an[2].y)
              + an[1].x * (an[2].y - an[0].y)
              + an[2].x * (an[0].y - an[1].y);
    if (!den) continue;
    const A = (pts[0][0] * (an[1].y - an[2].y) + pts[1][0] * (an[2].y - an[0].y) + pts[2][0] * (an[0].y - an[1].y)) / den;
    const B = (pts[0][1] * (an[1].y - an[2].y) + pts[1][1] * (an[2].y - an[0].y) + pts[2][1] * (an[0].y - an[1].y)) / den;
    const C = (pts[0][0] * (an[2].x - an[1].x) + pts[1][0] * (an[0].x - an[2].x) + pts[2][0] * (an[1].x - an[0].x)) / den;
    const D = (pts[0][1] * (an[2].x - an[1].x) + pts[1][1] * (an[0].x - an[2].x) + pts[2][1] * (an[1].x - an[0].x)) / den;
    const E = pts[0][0] - A * an[0].x - C * an[0].y;
    const F = pts[0][1] - B * an[0].x - D * an[0].y;
    c.save();
    c.transform(A, B, C, D, E, F);
    c.drawImage(im, 0, 0);
    c.restore();
    if (hits)
      hits.push({ abbr, A, B, C, D, E, F,
                  w: im.naturalWidth, h: im.naturalHeight,
                  mask: artMask(abbr, im) });
  }
  c.restore();
  if (hits) state._artHits = hits;
}

/* static per-mesh texture coordinates, cached per quad step */
/* ---------------- 天の川 (per-pixel resampling) --------------------
 * The panorama used to be laid down as 10-degree texture-mapped quads.
 * That produced two artefacts the eye picks up immediately: the affine
 * map inside each quad faceted the band, and quads were kept or dropped
 * whole at the horizon, so the lower edge came out as a 10-degree
 * staircase instead of a boundary.
 *
 * It is now resampled by inverse mapping.  For every pixel of a small
 * working buffer the screen -> sky transform is interpolated from a
 * coarse grid, the panorama is sampled bilinearly, and the horizon is a
 * smooth alpha ramp.  The buffer is sized to roughly the panorama's own
 * resolution (4 px/deg), so the cost is bounded by the source map, not
 * by the canvas: a 120-degree view resamples ~480x310 pixels whatever
 * the display size, and the result is then scaled up with smoothing —
 * which is right for a diffuse object with no sharp edges.
 */
const MW_GRID = 8;            // sky transform evaluated every 8 buffer px
const MW_GRID_LOW = 5;        // ...but finer where the projection stretches
/* The band is drawn all the way down to the horizon.
 *
 * It is dimmed by the air it is seen through — that is what the sky
 * does — but not switched off: the shape of the band low in the south
 * is exactly what an observer is trying to match against the sky, so a
 * floor keeps it visible instead of fading it to nothing.  The earlier
 * hard cut at 1.5° was there to hide a sampling artefact; the fix for
 * that is the finer grid above, not hiding the band.
 *
 * k = 0.18 mag per air mass, Pickering's air mass (finite at the
 * horizon, unlike 1/sin). */
const MW_MIN_ALT = 0.0;
const MW_EXT_FLOOR = 0.30;    // never dimmer than this
const MW_ZENITH_FADE = 86;    // horizon view: start fading here
const MW_ZENITH_STOP = 89;    // and draw nothing above this
function mwExtinction(altDeg) {
  if (altDeg <= 0) return MW_EXT_FLOOR;
  const a = altDeg * D2R;
  const X = 1 / (Math.sin(a) + 0.025 * Math.exp(-11 * Math.sin(a)));
  return Math.max(MW_EXT_FLOOR,
                  Math.min(1, Math.pow(10, -0.4 * 0.18 * (X - 1))));
}

function mwBuffer(bw, bh) {
  let b = state._mwBuf;
  if (!b || b.cv.width !== bw || b.cv.height !== bh) {
    const cv = document.createElement("canvas");
    cv.width = bw; cv.height = bh;
    b = state._mwBuf = { cv, ctx: cv.getContext("2d"),
                         img: cv.getContext("2d").createImageData(bw, bh) };
  }
  return b;
}

/* Zooming in past the point where the 2048-wide sample buffer runs out
 * of detail, resample from the source panorama at its full resolution
 * (4000 px = 11 px/deg).  Built once, on demand, because it costs ~24 MB.
 * Below MW_FADE_DEG even that has nothing left to show, so the layer
 * fades out rather than smearing a few pixels across the screen. */
/* The panorama holds ~11 px/deg, so past a ten-degree field it has no
 * detail left to give and would only smear.  That is also the scale at
 * which the Tycho-2 layer switches on and starts resolving the band into
 * stars — which is what a telescope actually shows — so the diffuse
 * layer hands over to them instead of being stretched. */
const MW_FADE_FULL_DEG = 12.0;   // full strength above this
const MW_FADE_ZERO_DEG = 2.5;    // gone below this
function mwHiRes() {
  if (state._mwHi !== undefined) return state._mwHi;
  const img = state._mwRaw;
  if (!img || img.naturalWidth <= 2048) { state._mwHi = null; return null; }
  const w = img.naturalWidth, h = Math.round(w / 2);
  const cv = document.createElement("canvas");
  cv.width = w; cv.height = h;
  const x = cv.getContext("2d", { willReadFrequently: true });
  x.drawImage(img, 0, 0, w, h);
  const d = x.getImageData(0, 0, w, h).data;
  const rgb = new Uint8Array(w * h * 3);
  for (let i = 0, j = 0; j < rgb.length; i += 4, j += 3) {
    rgb[j] = d[i]; rgb[j + 1] = d[i + 1]; rgb[j + 2] = d[i + 2];
  }
  state._mwHi = { w, h, rgb };
  return state._mwHi;
}

/* The band is not one colour.  Its faint outer light is the blue-white
 * of the disc population, while the star clouds towards the centre are
 * reddened by the dust in front of them — which is why photographs of
 * Sagittarius come out warm and those of Cygnus cool.  The tint ramps
 * between the two with brightness, through a 256-entry table. */
const MW_COOL = [206, 216, 236], MW_WARM = [252, 238, 208];
function mwTintTable() {
  if (state._mwTint) return state._mwTint;
  const t = new Float32Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    const w = Math.min(1, i / 190);
    t[i * 3] = MW_COOL[0] + (MW_WARM[0] - MW_COOL[0]) * w;
    t[i * 3 + 1] = MW_COOL[1] + (MW_WARM[1] - MW_COOL[1]) * w;
    t[i * 3 + 2] = MW_COOL[2] + (MW_WARM[2] - MW_COOL[2]) * w;
  }
  state._mwTint = t;
  return t;
}

function drawMilkywayTex(c, W, H, pal, lst, lat) {
  const allskyView = state.view.mode === "allsky";
  let src = state._mwImg;
  if (!src || !src.rgb) return;
  const deg = fieldWidthDeg();
  if (deg < 60) src = mwHiRes() || src;
  const zoomFade = Math.max(0, Math.min(1,
    (deg - MW_FADE_ZERO_DEG) / (MW_FADE_FULL_DEG - MW_FADE_ZERO_DEG)));
  if (zoomFade <= 0) return;
  const coarse = state._dragging || (state.playing &&
                                     Math.abs(state.speed) > 600);
  // The panorama is finer than any phone screen at a wide field: a
  // 400 pt display shows about 3.3 px per degree of a whole-sky view,
  // so sampling it at more than 4.5 costs time and shows nothing.  The
  // cap lifts itself naturally when the field narrows, because the
  // buffer is sized from the field width.
  const srcPxPerDeg = Math.min(src.w / 360, 4.0);
  const bw = Math.max(120, Math.min(coarse ? 700 : 1400, W,
    Math.round(deg * srcPxPerDeg / (coarse ? 1.8 : 1))));
  const bh = Math.max(80, Math.round(bw * H / W));
  const buf = mwBuffer(bw, bh);
  const out = buf.img.data;
  out.fill(0);
  // On paper the band is drawn as contours rather than as a wash: ink
  // is expensive, a grey rectangle prints badly, and the shape is what
  // the chart is for.  The tone of every buffer pixel is kept and the
  // level curves are traced once the buffer is complete.
  const outline = !!state._mwOutline;
  const tone = outline ? new Float32Array(bw * bh) : null;
  // −1 marks "no sky here": the edge of the horizon disc must not be
  // traced as if it were a level curve of the band
  if (tone) tone.fill(-1);

  const tw = src.w, th = src.h, rgb = src.rgb;
  // Tone curve: a power law to hold the sky background down, then a
  // Reinhard roll-off so the Sagittarius star cloud compresses instead of
  // clipping to white.  The density map has far less dynamic range than
  // the photograph and only needs the power law.
  const GAMMA = 1.25;
  const gain = 1.0;
  // The band is not one colour.  Its faint outer light is the blue-white
  // of the disc population, while the star clouds towards the centre are
  // reddened by the dust in front of them — which is why photographs of
  // Sagittarius come out warm and those of Cygnus cool.  The tint is
  // therefore a ramp between the two, taken with the brightness.
  const [tr, tg, tb] = pal.print ? [0, 0, 0]
    : pal.nv ? [220, 60, 60] : MW_COOL;
  // the ramp as a table: three interpolations per pixel cost more than
  // the resampling itself on a phone
  const tint = pal.print || pal.nv ? null : mwTintTable();

  // 1) sky transform on a grid, in texture coordinates.  The grid is
  // finer when the horizon is on screen: that is where one texture
  // pixel covers the most sky, and where a coarse interpolation smears.
  const MW_G = state.view.mode === "horizon" || !allskyView
    ? MW_GRID_LOW : (state.view.zoom > 1.5 ? MW_GRID : MW_GRID_LOW);
  const gx = Math.ceil(bw / MW_G) + 1, gy = Math.ceil(bh / MW_G) + 1;
  const gu = new Float64Array(gx * gy), gv = new Float64Array(gx * gy);
  const ga = new Float64Array(gx * gy);
  for (let j = 0; j < gy; j++) {
    const by = Math.min(bh, j * MW_G);
    for (let i = 0; i < gx; i++) {
      const bx = Math.min(bw, i * MW_G);
      const q = screenToRaDec(bx / bw * W, by / bh * H, true, W, H);
      const k = j * gx + i;
      if (!q) { ga[k] = -99; continue; }
      gu[k] = q.ra / 360 * tw;          // density map: ra 0 at the left
      gv[k] = (90 - q.dec) / 180 * th;
      ga[k] = q.alt;
    }
  }

  // 2) per-pixel bilinear resample inside each grid cell
  for (let j = 0; j + 1 < gy; j++) {
    const y0 = j * MW_G, y1 = Math.min(bh, y0 + MW_G);
    for (let i = 0; i + 1 < gx; i++) {
      const k00 = j * gx + i, k10 = k00 + 1;
      const k01 = k00 + gx, k11 = k01 + 1;
      if (ga[k00] < -90 || ga[k10] < -90 ||
          ga[k01] < -90 || ga[k11] < -90) continue;
      // unwrap the RA seam inside this cell before interpolating
      const u00 = gu[k00];
      const un = (u) => {
        let d = u - u00;
        if (d > tw / 2) d -= tw; else if (d < -tw / 2) d += tw;
        return u00 + d;
      };
      const a00 = u00, a10 = un(gu[k10]), a01 = un(gu[k01]),
            a11 = un(gu[k11]);
      const b00 = gv[k00], b10 = gv[k10], b01 = gv[k01], b11 = gv[k11];
      const h00 = ga[k00], h10 = ga[k10], h01 = ga[k01], h11 = ga[k11];
      const x0 = i * MW_G, x1 = Math.min(bw, x0 + MW_G);
      for (let y = y0; y < y1; y++) {
        const fy = (y - y0) / MW_G;
        const uA = a00 + (a01 - a00) * fy, uB = a10 + (a11 - a10) * fy;
        const vA = b00 + (b01 - b00) * fy, vB = b10 + (b11 - b10) * fy;
        const hA = h00 + (h01 - h00) * fy, hB = h10 + (h11 - h10) * fy;
        let o = (y * bw + x0) * 4;
        for (let x = x0; x < x1; x++, o += 4) {
          const fx = (x - x0) / MW_G;
          const alt = hA + (hB - hA) * fx;
          // Extinction, which doubles as the horizon boundary: the last
          // degrees above the horizon are where the projection stretches
          // one texture pixel across half the screen, and the smear that
          // produced was the most conspicuous artefact of the layer.
          // Dimming by the air mass removes it and is what the sky does
          // anyway — the band is two magnitudes down at 8° and gone by
          // the time it reaches the trees.
          if (alt < MW_MIN_ALT) continue;
          // The horizon view has a second place where one texture pixel
          // covers half the screen: the zenith, where every azimuth
          // meets.  The band is dropped in the few degrees around it
          // rather than smeared across the top of the chart.
          if (!allskyView && alt > MW_ZENITH_STOP) continue;
          const fade = mwExtinction(alt) *
            (allskyView || alt < MW_ZENITH_FADE ? 1
              : (MW_ZENITH_STOP - alt) /
                (MW_ZENITH_STOP - MW_ZENITH_FADE));
          let u = uA + (uB - uA) * fx;
          const v = vA + (vB - vA) * fx;
          u = ((u % tw) + tw) % tw;
          const vv = v < 0 ? 0 : v > th - 1.001 ? th - 1.001 : v;
          // bilinear sample of the panorama
          const iu = u | 0, iv = vv | 0;
          const du = u - iu, dv = vv - iv;
          const iu1 = iu + 1 >= tw ? 0 : iu + 1;
          const r0 = iv * tw, r1 = r0 + tw;
          const p00 = (r0 + iu) * 3, p01 = (r0 + iu1) * 3;
          const p10 = (r1 + iu) * 3, p11 = (r1 + iu1) * 3;
          const w00 = (1 - du) * (1 - dv), w01 = du * (1 - dv);
          const w10 = (1 - du) * dv, w11 = du * dv;
          let sr = rgb[p00] * w00 + rgb[p01] * w01 +
                   rgb[p10] * w10 + rgb[p11] * w11;
          let sg = rgb[p00 + 1] * w00 + rgb[p01 + 1] * w01 +
                   rgb[p10 + 1] * w10 + rgb[p11 + 1] * w11;
          let sb = rgb[p00 + 2] * w00 + rgb[p01 + 2] * w01 +
                   rgb[p10 + 2] * w10 + rgb[p11 + 2] * w11;
          const luma = 0.30 * sr + 0.59 * sg + 0.11 * sb;
          if (luma <= 1) continue;
          // tone curve: hold back the sky background so the star clouds
          // and dust lanes carry the picture instead of a grey wash
          let k = Math.pow(luma / 255, GAMMA) * gain;
          // on paper the band keeps its true shape: no extinction, no
          // horizon fade, just where it is
          k *= outline ? 1 : fade;
          if (outline) { tone[y * bw + x] = k; continue; }
          if (pal.print) {
            out[o] = out[o + 1] = out[o + 2] = 0;
            out[o + 3] = 255 * Math.min(1, k) * 0.55;
          } else if (pal.nv) {
            out[o] = tr * k; out[o + 1] = tg * k; out[o + 2] = tb * k;
            out[o + 3] = 255;
          } else {
            const ti = (luma < 255 ? luma : 255) | 0;
            const t3 = ti * 3;
            out[o] = tint[t3] * k;
            out[o + 1] = tint[t3 + 1] * k;
            out[o + 2] = tint[t3 + 2] * k;
            out[o + 3] = 255;
          }
        }
      }
    }
  }
  if (outline) {
    // two level curves: the outer edge of the band and the bright
    // clouds inside it.  A pixel is on a curve when it and one of its
    // neighbours sit on opposite sides of the level.
    const LEVELS = [0.16, 0.42];
    const ink = pal.print ? [0, 0, 0] : [226, 230, 238];
    for (let y = 1; y < bh - 1; y++) {
      for (let x = 1; x < bw - 1; x++) {
        const i = y * bw + x, v = tone[i];
        const rt = tone[i + 1], dn = tone[i + bw];
        if (v < 0 || rt < 0 || dn < 0) continue;   // off the sky
        let on = false;
        for (const L of LEVELS) {
          if ((v >= L) !== (rt >= L) || (v >= L) !== (dn >= L)) {
            on = true; break;
          }
        }
        if (!on) continue;
        const o = i * 4;
        out[o] = ink[0]; out[o + 1] = ink[1]; out[o + 2] = ink[2];
        out[o + 3] = 235;
      }
    }
  }
  buf.ctx.putImageData(buf.img, 0, 0);
  c.save();
  c.globalAlpha = (pal.print ? 0.85 : 0.62) *
    zoomFade * (state._skyDim != null ? state._skyDim : 1);
  c.globalCompositeOperation = pal.print ? "source-over" : "lighter";
  c.imageSmoothingEnabled = true;
  c.imageSmoothingQuality = "high";
  c.drawImage(buf.cv, 0, 0, bw, bh, 0, 0, W, H);
  c.restore();
}

function updateMilkywayUI() {
  const el = $("#opt-milkyway");
  if (!el || !state.sky) return;
  const avail = !!state.sky.milkyway_available;
  el.disabled = !avail;
  el.parentElement.title = avail ? "" : t("ui.milkyway_hint");
}

/* ---------------- astronomy on the client ---------------- */
const D2R = Math.PI / 180;

/* The ESO panorama is a hand-assembled mosaic and sits 3.85 deg away
 * from the true galactic frame: measured on five isolated, unambiguous
 * features (LMC, SMC, M42, M45, M31) the offsets were a consistent
 * dl ~ -2.5 to -3.6 deg, db ~ +1.9 to -1.9 deg, which a single rotation
 * fits with residuals of 0.04-0.13 deg.  Without it every nebula and
 * cluster the chart plots lands a few degrees off the nebulosity in the
 * image.  This matrix maps a TRUE galactic direction onto the image's
 * frame and is applied only to the photographic source. */
function eqToGalactic(ra, dec) {
  const M = state.sky && state.sky.matrices && state.sky.matrices.gal2eq;
  if (!M) return null;
  const cd = Math.cos(dec * D2R);
  const v = [cd * Math.cos(ra * D2R), cd * Math.sin(ra * D2R),
             Math.sin(dec * D2R)];
  const x = M[0][0] * v[0] + M[1][0] * v[1] + M[2][0] * v[2];
  const y = M[0][1] * v[0] + M[1][1] * v[1] + M[2][1] * v[2];
  const z = M[0][2] * v[0] + M[1][2] * v[1] + M[2][2] * v[2];
  return [((Math.atan2(y, x) / D2R) + 360) % 360,
          Math.asin(Math.max(-1, Math.min(1, z))) / D2R];
}
function altaz(raDeg, decDeg, lstHours, latDeg) {
  const H = (lstHours * 15 - raDeg) * D2R;
  const phi = latDeg * D2R, dec = decDeg * D2R;
  const sa = Math.sin(phi) * Math.sin(dec) +
    Math.cos(phi) * Math.cos(dec) * Math.cos(H);
  const alt = Math.asin(Math.max(-1, Math.min(1, sa)));
  const az = Math.atan2(Math.sin(H),
    Math.cos(H) * Math.sin(phi) - Math.tan(dec) * Math.cos(phi)) / D2R + 180;
  return [((az % 360) + 360) % 360, alt / D2R];
}
function currentLst() {
  // advance the server LST by elapsed simulated time (sidereal rate)
  if (!state.sky) return 0;
  const dtH = (simNow().getTime() - state.lastFetchSim) / 3.6e6;
  return (state.sky.time.lst_hours + dtH * 1.0027379093) % 24;
}
/* unit vector (lon,lat in frame) through M -> of-date [ra,dec] deg.
 * M rows are output components: v_eq = M @ v_frame. */
function frameToEq(M, lonDeg, latDeg) {
  const l = lonDeg * D2R, b = latDeg * D2R;
  const v = [Math.cos(b) * Math.cos(l), Math.cos(b) * Math.sin(l),
             Math.sin(b)];
  const x = M[0][0] * v[0] + M[0][1] * v[1] + M[0][2] * v[2];
  const y = M[1][0] * v[0] + M[1][1] * v[1] + M[1][2] * v[2];
  const z = M[2][0] * v[0] + M[2][1] * v[1] + M[2][2] * v[2];
  return [((Math.atan2(y, x) / D2R) + 360) % 360,
          Math.asin(Math.max(-1, Math.min(1, z))) / D2R];
}

/* the same rotation the other way: the matrices are orthogonal, so the
 * transpose is the inverse */
function eqToFrame(M, raDeg, decDeg) {
  const a = raDeg * D2R, d = decDeg * D2R;
  const v = [Math.cos(d) * Math.cos(a), Math.cos(d) * Math.sin(a),
             Math.sin(d)];
  const x = M[0][0] * v[0] + M[1][0] * v[1] + M[2][0] * v[2];
  const y = M[0][1] * v[0] + M[1][1] * v[1] + M[2][1] * v[2];
  const z = M[0][2] * v[0] + M[1][2] * v[1] + M[2][2] * v[2];
  return [((Math.atan2(y, x) / D2R) + 360) % 360,
          Math.asin(Math.max(-1, Math.min(1, z))) / D2R];
}

/* ---------------- projection ---------------- */
const canvas = $("#sky");
const ctx = canvas.getContext("2d");

/* all-sky: azimuthal equidistant centered on state.view.allskyCenter
 * (az0, alt0); screen-up points along the great circle toward the
 * zenith.  With the default center (az 180, alt 90) this reduces
 * exactly to the historical north-up zenith chart
 *   x = W/2 - mir*r*sin(az), y = H/2 - r*cos(az), r = (90-alt)/90*R.
 * Returns [x, y, greatCircleDistDeg]; never null. */
function allskyXY(az, alt, W, H) {
  const v = state.view, ctr = v.allskyCenter;
  const mir = state.opts.mirror ? -1 : 1;
  const R = Math.min(W, H) / 2 * ALLSKY_FILL * v.zoom;
  const a = alt * D2R, a0 = ctr.alt * D2R, dz = (az - ctr.az) * D2R;
  const sA = Math.sin(a), cA = Math.cos(a);
  const sA0 = Math.sin(a0), cA0 = Math.cos(a0);
  const cdz = Math.cos(dz);
  const xt = cA * Math.sin(dz);              // toward +az on the sky
  const yt = cA0 * sA - sA0 * cA * cdz;      // toward the zenith
  const cd = sA0 * sA + cA0 * cA * cdz;      // cos(great-circle dist)
  const n = Math.hypot(xt, yt);              // sin(great-circle dist)
  const d = Math.atan2(n, cd) / D2R;
  // Stereographic (conformal): r = R·tan(d/2), normalized so the
  // horizon ring at zenith center sits at r = R exactly like before.
  // Being conformal, LOCAL SHAPES ARE PRESERVED for every view center,
  // so constellations no longer deform while dragging the all-sky view
  // (the previous equidistant mapping stretched shapes tangentially by
  // d/sin d, which changed as the center moved).
  const s = R * Math.tan(Math.min(d, 165) * D2R / 2);
  const ux = n > 1e-12 ? xt / n : 0, uy = n > 1e-12 ? yt / n : 1;
  return [W / 2 + mir * s * ux, H / 2 - s * uy, d];
}
const ALLSKY_MAXDIST = 110;   // deg shown, keeps horizon ring when panned
/* Zoom range.  The narrow end is one ARCSECOND across the canvas, which
 * is what it takes to fill the screen with a planet: the disks run from
 * Neptune at 2.3″ and Uranus at 3.5″ up to Jupiter near 50″, so an
 * arcminute-wide field (the old limit) still left Neptune as a speck.
 * ALLSKY_MAX_ZOOM gives the all-sky projection the same reach. */
const MIN_FOV = 1 / 3600;
const MAX_FOV = 160;
const ALLSKY_MIN_ZOOM = 0.6;
const ALLSKY_MAX_ZOOM = 2.0e6;

/* Horizon mode is a cylindrical projection: y linear in altitude, x
 * linear in azimuth.  With the scale referred to the horizon (the
 * conventional panorama) the sky is stretched horizontally by 1/cos(alt)
 * — unnoticeable across a 100° panorama, but a 2:1 distortion at 60°
 * altitude once the field is a degree wide, which would misdraw every
 * FOV frame.  Below 30° the standard parallel therefore blends to the
 * altitude at the centre of the screen, so a telescopic field is drawn
 * to the correct aspect ratio while wide views keep the familiar
 * horizon-referenced panorama.  `fov` is the true angular width. */
let _azScaleCache = { key: null, v: 1 };
function horizonAzScale(W, H) {
  const v = state.view;
  if (v.fov >= 60) return 1;
  const key = `${v.fov}|${v.altOffset}|${H}|${W}`;
  if (_azScaleCache.key === key) return _azScaleCache.v;
  const altRef = v.altOffset + (H * 0.92 - H / 2) / (W / v.fov);
  // full correction at 30° and below (where shapes must be right),
  // fading out to the plain panorama by 60° so there is no visible jump
  const w = Math.min(1, (60 - v.fov) / 30);
  const c = Math.cos(Math.max(-89, Math.min(89, altRef)) * D2R);
  _azScaleCache = { key, v: 1 - w * (1 - c) };
  return _azScaleCache.v;
}

function project(az, alt, W, H) {
  const v = state.view;
  const mir = state.opts.mirror ? -1 : 1;
  if (v.mode === "allsky") {
    if (alt < -1) return null;
    const p = allskyXY(az, alt, W, H);
    return p[2] > ALLSKY_MAXDIST ? null : [p[0], p[1]];
  }
  const sc = horizonAzScale(W, H);
  let da = ((az - v.azCenter + 540) % 360) - 180;
  if (Math.abs(da) * sc > v.fov / 2 + 8) return null;
  if (alt < -25 || alt > 90) return null;
  const pxPerDeg = W / v.fov;
  const y = H * 0.92 - (alt - v.altOffset) * pxPerDeg;
  if (y < -0.12 * H || y > 1.15 * H) return null;
  return [W / 2 + mir * da * sc * pxPerDeg, y];
}
/* like project() but never returns null — used only to get a direction
 * on screen (e.g. comet tails point away from the sun even when the sun
 * is below the horizon) */
function projectRaw(az, alt, W, H) {
  const v = state.view;
  const mir = state.opts.mirror ? -1 : 1;
  if (v.mode === "allsky") {
    const p = allskyXY(az, alt, W, H);
    return [p[0], p[1]];
  }
  const da = ((az - v.azCenter + 540) % 360) - 180;
  const pxPerDeg = W / v.fov;
  return [W / 2 + mir * da * horizonAzScale(W, H) * pxPerDeg,
          H * 0.92 - (alt - v.altOffset) * pxPerDeg];
}

/* screen (canvas px) -> az/alt -> apparent-of-date ra/dec.
 * Horizon mode: closed-form inverse of project().  All-sky: closed-form
 * spherical destination around allskyCenter (azimuthal equidistant:
 * screen distance is proportional to great-circle distance, screen
 * bearing = bearing from the zenith direction toward +az). */
/* Inverse of the projection.  `Wo`/`Ho` name the surface the coordinates
 * belong to: everything interactive works on the visible canvas and lets
 * them default, but the export renders into an offscreen canvas of quite
 * another size, and reading it back against the screen's dimensions put
 * the Milky Way — the one layer that inverts the projection per pixel —
 * in the wrong part of the sky. */
function screenToRaDec(xs, ys, raw, Wo, Ho) {
  if (!state.sky) return null;
  const W = Wo || canvas.width, H = Ho || canvas.height;
  const v = state.view, mir = state.opts.mirror ? -1 : 1;
  let az, alt;
  if (v.mode === "horizon") {
    const pxPerDeg = W / v.fov;
    const sc = horizonAzScale(W, H);
    az = ((v.azCenter + mir * (xs - W / 2) / (pxPerDeg * sc)) % 360 + 360)
      % 360;
    alt = v.altOffset + (H * 0.92 - ys) / pxPerDeg;
    // Nothing lies above the zenith.  On a tall screen — a phone in
    // portrait — the horizon view reaches well past it (the top of an
    // iPhone frame sits near alt 138 deg at a 110 deg field), and
    // mapping those pixels back gives the sky *behind* the observer.
    // The per-pixel Milky Way, which is the only caller passing `raw`,
    // then painted that as a grey smear over the top of the chart, so
    // this rejection cannot be part of what `raw` skips.
    if (alt > 90) return null;
  } else {
    const R = Math.min(W, H) / 2 * ALLSKY_FILL * v.zoom;
    const dx = mir * (xs - W / 2), dy = H / 2 - ys;
    // inverse stereographic: d = 2·atan(r/R)
    const d = 2 * Math.atan(Math.hypot(dx, dy) / R) / D2R;
    if (d > ALLSKY_MAXDIST && !raw) return null;
    const beta = Math.atan2(dx, dy);             // from zenith-dir to +az
    const ctr = v.allskyCenter;
    if (ctr.alt >= 89.99) {                      // exact-zenith degeneracy
      az = ((ctr.az + 180 - beta / D2R) % 360 + 360) % 360;
      alt = 90 - d;
    } else {
      const dr = d * D2R, la0 = ctr.alt * D2R;
      const sa = Math.sin(la0) * Math.cos(dr) +
        Math.cos(la0) * Math.sin(dr) * Math.cos(beta);
      alt = Math.asin(Math.max(-1, Math.min(1, sa))) / D2R;
      az = ((ctr.az + Math.atan2(
        Math.sin(beta) * Math.sin(dr) * Math.cos(la0),
        Math.cos(dr) - Math.sin(la0) * sa) / D2R) % 360 + 360) % 360;
    }
  }
  // az/alt -> ha/dec -> ra (inverse of altaz(); A measured from south)
  const lat = state.sky.site.lat_deg * D2R;
  const A = (az - 180) * D2R, al = alt * D2R;
  const sd = Math.sin(lat) * Math.sin(al) -
    Math.cos(lat) * Math.cos(al) * Math.cos(A);
  const dec = Math.asin(Math.max(-1, Math.min(1, sd))) / D2R;
  const ha = Math.atan2(Math.sin(A),
    Math.cos(A) * Math.sin(lat) + Math.tan(al) * Math.cos(lat)) / D2R;
  const ra = ((currentLst() * 15 - ha) % 360 + 360) % 360;
  return { ra, dec, az, alt };
}

/* How much of the canvas the whole-sky disc fills.
 *
 * The compass labels are drawn at the horizon circle, so the disc has to
 * stop short of the edge or E and W are cut off the sides of a phone in
 * portrait — where the width, not the height, is what limits it. 0.95
 * left ten pixels; this leaves room for the label. */
const ALLSKY_FILL = 0.87;

/* ---------------- zoom, centring and object following ---------------
 * `fov` (horizon) and `zoom` (all-sky) both express magnification; these
 * helpers convert between them and a plain "how many degrees across the
 * canvas", so the same call can frame a star, a FOV frame or a planet in
 * either mode.  Wheel zoom keeps the sky point under the pointer fixed;
 * with a follow target set, the target stays at the centre instead —
 * which is what makes zooming in on a selected star behave. */
function fieldWidthDeg() {
  const v = state.view;
  if (v.mode === "horizon") return v.fov;
  const W = canvas.width, H = canvas.height;
  const base = Math.min(W, H) / 2 * ALLSKY_FILL * v.zoom;
  // stereographic can map more than a hemisphere onto a wide canvas;
  // cap the reported field at the whole sky
  return Math.min(180, 4 * Math.atan(W / 2 / base) / D2R);
}

function setFieldWidth(deg) {
  const v = state.view;
  if (v.mode === "horizon") {
    v.fov = Math.min(MAX_FOV, Math.max(MIN_FOV, deg));
    updateHints();
    return;
  }
  const W = canvas.width, H = canvas.height;
  const base = Math.min(W, H) / 2 * ALLSKY_FILL;
  const half = Math.max(MIN_FOV, Math.min(179, deg)) / 4 * D2R;
  v.zoom = Math.min(ALLSKY_MAX_ZOOM, Math.max(ALLSKY_MIN_ZOOM,
    W / 2 / (base * Math.tan(half))));
}

/* put an az/alt at the centre of the canvas */
function centerView(az, alt) {
  const v = state.view;
  const W = canvas.width, H = canvas.height;
  if (v.mode === "allsky") {
    v.allskyCenter = { az, alt: Math.max(-5, Math.min(90, alt)) };
    return;
  }
  v.azCenter = ((az % 360) + 360) % 360;
  // altOffset is the altitude drawn at y = 0.92H; solve for the centre
  for (let i = 0; i < 3; i++)          // sc depends on altOffset: iterate
    v.altOffset = alt - (H * 0.92 - H / 2) / (W / v.fov);
}

function zoomBy(factor, mx, my) {
  const v = state.view;
  const anchor = (v.follow || mx == null) ? null : screenToRaDec(mx, my);
  if (v.mode === "allsky")
    v.zoom = Math.min(ALLSKY_MAX_ZOOM,
                      Math.max(ALLSKY_MIN_ZOOM, v.zoom / factor));
  else
    v.fov = Math.min(MAX_FOV, Math.max(MIN_FOV, v.fov * factor));
  updateHints();
  if (v.follow) { applyFollow(); return; }
  if (!anchor || v.mode !== "horizon") return;
  // keep the sky point that was under the pointer under the pointer
  const W = canvas.width, H = canvas.height;
  const mir = state.opts.mirror ? -1 : 1;
  for (let i = 0; i < 3; i++) {        // sc depends on altOffset
    const pxPerDeg = W / v.fov, sc = horizonAzScale(W, H);
    v.altOffset = anchor.alt - (H * 0.92 - my) / pxPerDeg;
    v.azCenter = ((anchor.az - mir * (mx - W / 2) / (pxPerDeg * sc))
                  % 360 + 360) % 360;
  }
}

/* Field width to zoom to when centring on an object.  A body with a
 * resolved disk is framed at a few of its own diameters, so one press
 * fills the screen with the planet instead of stepping down to it;
 * anything else just quarters the current field. */
function zoomTargetFor(o) {
  const pl = o && o.key && state.sky &&
    state.sky.planets.find((p) => p.key === o.key);
  if (pl && pl.diam) {
    const wide = pl.key === "saturn" ? 3.0 : 2.5;   // room for the rings
    return Math.max(MIN_FOV, pl.diam / 3600 * wide);
  }
  return Math.max(MIN_FOV * 4, Math.min(fieldWidthDeg(), 10) / 4);
}

/* Switch between the whole-sky and horizon views.
 *
 * "全天" means the whole sky: the zoom belongs to the view rather than
 * to the mode, so a magnification left over from inspecting a planet
 * used to survive the switch and leave that planet filling the
 * background.  Going back to the whole sky resets it. */
function setViewMode(mode) {
  state.view.mode = mode;
  // the compass menu only means anything in the horizon view, so it
  // appears with it instead of sitting on the bar unused
  document.body.classList.toggle("horizon-mode", mode === "horizon");
  if (mode === "allsky") {
    state.view.allskyCenter = { az: 180, alt: 90 };   // back to the zenith
    state.view.zoom = 1.0;
    if (state.view.follow) setFollow(null);
  }
  $("#view-allsky").classList.toggle("active", mode === "allsky");
  $("#view-horizon").classList.toggle("active", mode === "horizon");
  resetTrails();
  updateHints();
}

/* The view options with a tick box of their own.  The demo tour turns
 * several of them on as it goes, so the panel has to be told to catch
 * up whenever the tour hands control back. */
const VIEW_OPT_IDS = ["lines", "connames", "starnames", "planets", "dso",
                      "grid_altaz", "grid_eq", "grid_ecl", "grid_gal",
                      "milkyway", "skyglow", "moonglow", "mirror", "trails",
                      "line_equator", "line_ecliptic", "line_meridian",
                      "conart"];
function syncViewOptionUI() {
  for (const id of VIEW_OPT_IDS) {
    const el = $(`#opt-${id}`);
    if (el) el.checked = !!state.opts[id];
  }
  const ml = $("#opt-maglimit");
  if (ml) {
    ml.value = state.opts.maglimit;
    $("#maglimit-out").textContent = state.opts.maglimit;
  }
  syncQuickBar();
}

/* the phone's quick controls mirror the panel */
function syncSatButton() {
  const b = $("#sat-btn");
  if (!b) return;
  b.classList.toggle("on", !!state.sat.on);
  b.setAttribute("aria-pressed", String(!!state.sat.on));
}

/* The four coordinate grids behind one control.
 *
 * They are rarely all wanted at once but any combination is legitimate —
 * the ecliptic against the equator is the whole point of some questions
 * — so this is a menu of tick boxes rather than a cycle. */
const GRID_OPTS = ["grid_altaz", "grid_eq", "grid_ecl", "grid_gal",
                   "line_equator", "line_ecliptic", "line_meridian"];

function syncGridMenu() {
  const btn = $("#grid-btn");
  if (!btn) return;
  const n = GRID_OPTS.filter((k) => state.opts[k]).length;
  btn.classList.toggle("on", n > 0);
  btn.setAttribute("aria-pressed", String(n > 0));
  for (const k of GRID_OPTS) {
    const el = $(`#qg-${k}`);
    if (el) el.checked = !!state.opts[k];
  }
}

function syncQuickBar() {
  const q = $("#qb-maglimit");
  if (!q) return;
  q.value = state.opts.maglimit;
  $("#qb-magout").textContent = state.opts.maglimit;
  $$("#qb-toggles button[data-opt]").forEach((b) => {
    const on = !!state.opts[b.dataset.opt];
    b.classList.toggle("on", on);
    b.setAttribute("aria-pressed", String(on));
  });
  syncSatButton();
  syncCometButton();
  syncShowerButton();
  syncGridMenu();
}

/* --- follow: hold an object at a fixed place in the view ---
 *
 * `off` is where the view sits relative to the target, in degrees.  It
 * is zero for a plain "centre on this", but panning writes into it
 * instead of dropping the target: after magnifying a planet the observer
 * usually wants to shift it off centre — to look at a moon, or to bring
 * a neighbouring star in — and losing the tracking there means the
 * planet drifts straight back out of a narrow field. */
function setFollow(obj, fovDeg) {
  state.view.follow = obj
    ? { ra: obj.ra, dec: obj.dec, name: obj.name, off: { az: 0, alt: 0 } }
    : null;
  if (obj && fovDeg) setFieldWidth(fovDeg);
  applyFollow();
  renderSelected();
}

function targetAzAlt() {
  const f = state.view.follow;
  if (!f || !state.sky) return null;
  const [az, alt] = altaz(f.ra, f.dec, currentLst(),
                          state.sky.site.lat_deg);
  return { az, alt };
}

/* the view was moved by hand: remember the new offset, keep tracking */
function syncFollowOffset() {
  const f = state.view.follow, tgt = targetAzAlt();
  if (!f || !tgt) return;
  const [caz, calt] = viewCenterAzAlt();   // defined with the sky helpers
  f.off = { az: (((caz - tgt.az) % 360) + 540) % 360 - 180,
            alt: calt - tgt.alt };
}

function applyFollow() {
  const f = state.view.follow, tgt = targetAzAlt();
  if (!tgt) return;
  const off = f.off || { az: 0, alt: 0 };
  centerView(tgt.az + off.az, tgt.alt + off.alt);
}

/* ---------------- 写野角 (FOV frame) presets & geometry -------------- */
/* Sensor sizes are the physical active area in mm.  Smart-telescope
 * frames are derived from the sensor and the telephoto focal length,
 * and every one below reproduces the manufacturer's published field:
 *   Seestar S30      30 mm f/5,  fl 150, IMX662 1/2.8"  -> 2.13 x 1.20°
 *   Seestar S30 Pro  30 mm,      fl 160, IMX585 1/1.2"  -> 4.00 x 2.26°
 *   Seestar S50      50 mm f/5,  fl 250, IMX462 1/2.8"  -> 1.28 x 0.72°
 *   DWARF mini       30 mm f/5,  fl 150, IMX662 1/2.8"  -> 2.13 x 1.20°
 *   DWARF 3          35 mm,      fl 150, IMX678 1/1.8"  -> 2.93 x 1.65°
 * (wide-angle secondary lenses are not represented). */
const SENSOR_IMX662 = { w: 5.57, h: 3.13 };   // 1/2.8", 1920x1080, 2.9 µm
const SENSOR_IMX585 = { w: 11.18, h: 6.32 };  // 1/1.2", 3856x2180, 2.9 µm
const SENSOR_IMX678 = { w: 7.68, h: 4.32 };   // 1/1.8", 3840x2160, 2.0 µm
const SENSOR_IMX462 = SENSOR_IMX662;   // IMX462: same 1/2.8" 1920x1080 format
const FOV_PRESETS = [
  // smart telescopes first: these are the frames most users reach for
  { id: "seestar_s30", ja: "Seestar S30 (150mm)",
    en: "Seestar S30 (150mm)", type: "rect",
    w: SENSOR_IMX662.w, h: SENSOR_IMX662.h, f: 150 },
  { id: "seestar_s30pro", ja: "Seestar S30 Pro (160mm)",
    en: "Seestar S30 Pro (160mm)", type: "rect",
    w: SENSOR_IMX585.w, h: SENSOR_IMX585.h, f: 160 },
  { id: "seestar_s50", ja: "Seestar S50 (250mm)",
    en: "Seestar S50 (250mm)", type: "rect",
    w: SENSOR_IMX462.w, h: SENSOR_IMX462.h, f: 250 },
  { id: "dwarf_mini", ja: "DWARF mini (150mm)",
    en: "DWARF mini (150mm)", type: "rect",
    w: SENSOR_IMX662.w, h: SENSOR_IMX662.h, f: 150 },
  { id: "dwarf3", ja: "DWARF 3 (150mm)", en: "DWARF 3 (150mm)",
    type: "rect", w: SENSOR_IMX678.w, h: SENSOR_IMX678.h, f: 150 },
  // cameras
  { id: "ff21",  ja: "フルサイズ+21mm",
    en: "Full-frame + 21mm", type: "rect", w: 36, h: 24, f: 21 },
  { id: "ff24",  ja: "フルサイズ+24mm",
    en: "Full-frame + 24mm", type: "rect", w: 36, h: 24, f: 24 },
  { id: "ff35",  ja: "フルサイズ+35mm",
    en: "Full-frame + 35mm", type: "rect", w: 36, h: 24, f: 35 },
  { id: "ff50",  ja: "フルサイズ+50mm",
    en: "Full-frame + 50mm", type: "rect", w: 36, h: 24, f: 50 },
  { id: "ff135", ja: "フルサイズ+135mm",
    en: "Full-frame + 135mm", type: "rect", w: 36, h: 24, f: 135 },
  { id: "ff200", ja: "フルサイズ+200mm",
    en: "Full-frame + 200mm", type: "rect", w: 36, h: 24, f: 200 },
  { id: "ff300", ja: "フルサイズ+300mm",
    en: "Full-frame + 300mm", type: "rect", w: 36, h: 24, f: 300 },
  { id: "apsc24",  ja: "APS-C+24mm",  en: "APS-C + 24mm",
    type: "rect", w: 23.5, h: 15.6, f: 24 },
  { id: "apsc50",  ja: "APS-C+50mm",  en: "APS-C + 50mm",
    type: "rect", w: 23.5, h: 15.6, f: 50 },
  { id: "apsc135", ja: "APS-C+135mm", en: "APS-C + 135mm",
    type: "rect", w: 23.5, h: 15.6, f: 135 },
  { id: "apsc300", ja: "APS-C+300mm", en: "APS-C + 300mm",
    type: "rect", w: 23.5, h: 15.6, f: 300 },
  // plain circular fields — a ruler for judging separations and for
  // matching an eyepiece/instrument quoted only by its true field
  { id: "deg10", ja: "円 10°", en: "Circle 10°",
    type: "circle", fov: 10 },
  { id: "deg5", ja: "円 5°", en: "Circle 5°",
    type: "circle", fov: 5 },
  { id: "deg1", ja: "円 1°", en: "Circle 1°",
    type: "circle", fov: 1 },
  { id: "min30", ja: "円 30′", en: "Circle 30′",
    type: "circle", fov: 0.5 },
  { id: "min10", ja: "円 10′", en: "Circle 10′",
    type: "circle", fov: 10 / 60 },
  { id: "min1", ja: "円 1′", en: "Circle 1′",
    type: "circle", fov: 1 / 60 },
  { id: "custom", ja: "カスタム", en: "Custom" },
];
function fovDegOf(mm, f) { return 2 * Math.atan(mm / (2 * f)) / D2R; }
function fovPresetName(p) { return state.lang === "ja" ? p.ja : p.en; }
/* -> {type:"rect", w,h [deg]} | {type:"circle", fov [deg]} */
function frameDims(fr) {
  const p = FOV_PRESETS.find((x) => x.id === fr.preset);
  if (p && p.id !== "custom") {
    if (p.type === "rect")
      return { type: "rect", w: fovDegOf(p.w, p.f), h: fovDegOf(p.h, p.f) };
    // fov given directly (plain circles) or via eyepiece/telescope
    return { type: "circle",
             fov: p.fov != null ? p.fov : p.afov / (p.fl / p.ep) };
  }
  const c = fr.custom || {};
  if ((c.kind || "rect") === "rect")
    return { type: "rect", w: fovDegOf(c.w || 36, c.f || 50),
             h: fovDegOf(c.h || 24, c.f || 50) };
  return { type: "circle", fov: (c.afov || 52) / (c.mag || 40) };
}
/* degrees -> "1.28°" / "12.0′" / "36″", whichever reads best */
function angleLabel(deg) {
  if (deg >= 1) return `${deg.toFixed(deg < 3 ? 2 : 1)}°`;
  const min = deg * 60;
  if (min >= 1) return `${min.toFixed(min < 10 ? 1 : 0)}′`;
  return `${(min * 60).toFixed(0)}″`;
}
function frameSizeLabel(fr) {
  const d = frameDims(fr);
  return d.type === "rect"
    ? `${angleLabel(d.w)}×${angleLabel(d.h)}`
    : `⌀${angleLabel(d.fov)}`;
}
/* frame outline as of-date [ra,dec] samples (small-angle tangent plane:
 * offsets rotated by the frame angle, dra scaled by 1/cos(dec)) */
function frameOutline(fr) {
  const d = frameDims(fr);
  const th = (fr.rotation || 0) * D2R;
  const off = [];
  if (d.type === "rect") {
    const hw = d.w / 2, hh = d.h / 2;
    const cor = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]];
    for (let e = 0; e < 4; e++) {
      const [x0, y0] = cor[e], [x1, y1] = cor[(e + 1) % 4];
      for (let s = 0; s < 8; s++) {
        const f = s / 8;
        off.push([x0 + (x1 - x0) * f, y0 + (y1 - y0) * f]);
      }
    }
  } else {
    const r = d.fov / 2;
    for (let a = 0; a < 360; a += 10)
      off.push([r * Math.cos(a * D2R), r * Math.sin(a * D2R)]);
  }
  const cosd = Math.max(0.02, Math.cos(fr.dec * D2R));
  const ct = Math.cos(th), st = Math.sin(th);
  return off.map(([x, y]) => [
    fr.ra + (x * ct - y * st) / cosd,
    Math.max(-89.9, Math.min(89.9, fr.dec + x * st + y * ct))]);
}
function saveFov() {
  localStorage.setItem("fovFrames", JSON.stringify(state.fovFrames));
}
function selectedFovFrame() {
  return state.fovFrames.find((f) => f.id === state.fovSelected) ||
    state.fovFrames[state.fovFrames.length - 1] || null;
}

/* ---------------- toast, GPS, horizon mask ---------------- */
let _toastTimer = null;
function toast(msg, ms = 4000) {
  const el = $("#toast");
  el.textContent = msg;
  el.hidden = false;
  el.classList.add("show");
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => {
    el.classList.remove("show");
    _toastTimer = setTimeout(() => { el.hidden = true; }, 400);
  }, ms);
}
function haversineKm(la1, lo1, la2, lo2) {
  const s1 = Math.sin((la2 - la1) * D2R / 2),
        s2 = Math.sin((lo2 - lo1) * D2R / 2);
  const h = s1 * s1 + Math.cos(la1 * D2R) * Math.cos(la2 * D2R) * s2 * s2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}
async function loadHorizonMask() {
  state.horizonMask = null;
  try {
    const d = await api("horizon_mask", { site: state.site });
    state.horizonMask = d.defined ? d : null;
  } catch (_) { /* keep null: flat horizon */ }
}
/* terrain altitude at azimuth (linear interp over the 2° profile) */
function maskAlt(mask, az) {
  const a = ((az % 360) + 360) % 360;
  const i = Math.min(mask.alt.length - 2, Math.floor(a / 2));
  const f = a / 2 - i;
  return mask.alt[i] * (1 - f) + mask.alt[i + 1] * f;
}

function bvColor(bv) {
  if (document.body.classList.contains("nv")) return "#e03030";
  if (bv == null) return "#ffffff";
  if (bv < 0.0) return "#aabfff";
  if (bv < 0.4) return "#f8f7ff";
  if (bv < 0.9) return "#fff4ea";
  if (bv < 1.4) return "#ffd2a1";
  return "#ffb56c";
}

/* ---------------- palettes (screen / print) ---------------- */
function screenPal() {
  const nv = document.body.classList.contains("nv");
  return {
    print: false, nv,
    // equatorial in green, galactic in blue — swapped from the first
    // arrangement, which had the equatorial grid in nearly the same
    // blue as the horizontal one
    grid: { altaz: nv ? "#3a0d0d" : "#1c2c4f",
            eq:    nv ? "#4a1414" : "#3f6e46",
            ecl:   nv ? "#5a1515" : "#8a6d2a",
            gal:   nv ? "#4a1010" : "#24506e" },
    gridStrong: null,                 // strong lines: same color, thicker
    gridLabel: nv ? "#802020" : "#5a6a94",
    conLine: nv ? "#571414" : "#31548c",
    starLabel: nv ? "#a02020" : "#9fb4d8",
    conName: nv ? "#7a1a1a" : "#44608f",
    dso: nv ? "#903030" : "#4fae9d",
    planetLabel: nv ? "#e04040" : "#ffe9b0",
    comet: nv ? "#e04040" : "#7fe6ee",
    asteroid: nv ? "#e04040" : "#e8d060",
    satellite: nv ? "#e04040" : "#9df0a4",
    satelliteDark: nv ? "#6a1818" : "#4f7d59",
    star: bvColor,
    planetColor: (key) => nv ? "#ff5050" :
      ({ sun: "#ffd76e", moon: "#e8e8de", mars: "#ff8560",
         jupiter: "#ffd9a0", saturn: "#f0e0a8", venus: "#fffdf0",
       }[key] || "#c8e0ff"),
    glow: !nv, twilight: true,
  };
}
function printPal() {
  return {
    print: true, nv: false,
    grid: { altaz: "#999", eq: "#999", ecl: "#999", gal: "#999" },
    gridStrong: "#666",
    gridLabel: "#555",
    conLine: "#666",
    starLabel: "#000",
    conName: "#444",
    dso: "#333",
    planetLabel: "#000",
    comet: "#000", asteroid: "#000",
    satellite: "#000", satelliteDark: "#777",
    star: () => "#000",
    planetColor: () => "#000",
    glow: false, twilight: false,
  };
}

/* Twilight colour of the zenith, interpolated over the Sun's depression
 * (the same anchors as before, but continuous). */
const TWILIGHT_SKY = [
  [6, [40, 96, 168], [48, 0, 0]],
  [0, [28, 74, 138], [32, 0, 0]],
  [-6, [18, 48, 89], [24, 0, 0]],
  [-12, [10, 26, 51], [16, 0, 0]],
  [-18, [5, 13, 29], [8, 0, 0]],
  [-30, [0, 0, 5], [0, 0, 0]],
];
function twilightColour(sunAlt, nv) {
  const idx = nv ? 2 : 1;
  const pick = (row) => row[idx];
  let c;
  if (sunAlt >= TWILIGHT_SKY[0][0]) c = pick(TWILIGHT_SKY[0]);
  else if (sunAlt <= TWILIGHT_SKY[TWILIGHT_SKY.length - 1][0])
    c = pick(TWILIGHT_SKY[TWILIGHT_SKY.length - 1]);
  else {
    let i = 0;
    while (i < TWILIGHT_SKY.length - 1 &&
           sunAlt < TWILIGHT_SKY[i + 1][0]) i++;
    const a = TWILIGHT_SKY[i][0], b = TWILIGHT_SKY[i + 1][0];
    const f = (a - sunAlt) / (a - b);
    const p = pick(TWILIGHT_SKY[i]), q = pick(TWILIGHT_SKY[i + 1]);
    c = [p[0] + (q[0] - p[0]) * f, p[1] + (q[1] - p[1]) * f,
         p[2] + (q[2] - p[2]) * f];
  }
  return `rgb(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])})`;
}

/* ---------------- sky-glow magnitude limit (spec: 太陽光・月光) ------- */
/* Limiting magnitude of the sky, as a CONTINUOUS function of the Sun's
 * depression.  The old version stepped between the twilight bands, so
 * whole populations of stars appeared at once when the Sun crossed -6,
 * -12 or -18 degrees.  Outdoors the sky fills in steadily, so the same
 * anchor values are now interpolated between:
 *
 *    Sun altitude   +6    0    -6   -12   -18 and below
 *    limit         -4.0  -1.0  2.0   4.5   the user's naked-eye limit
 */
const TWILIGHT_LADDER = [[6, -4.0], [0, -1.0], [-6, 2.0], [-12, 4.5],
                         [-18, null]];

function effectiveLimit(sunAlt, moonAlt, moonIllum, userLimit) {
  const user = userLimit != null ? userLimit : state.opts.maglimit;
  if (!state.opts.skyglow) return user;
  const val = (i) => TWILIGHT_LADDER[i][1] == null ? user
    : TWILIGHT_LADDER[i][1];
  let lim;
  if (sunAlt >= TWILIGHT_LADDER[0][0]) lim = val(0);
  else if (sunAlt <= TWILIGHT_LADDER[TWILIGHT_LADDER.length - 1][0])
    lim = user;
  else {
    let i = 0;
    while (i < TWILIGHT_LADDER.length - 1 &&
           sunAlt < TWILIGHT_LADDER[i + 1][0]) i++;
    const a = TWILIGHT_LADDER[i][0], b = TWILIGHT_LADDER[i + 1][0];
    const f = (a - sunAlt) / (a - b);
    lim = val(i) + (val(i + 1) - val(i)) * f;
  }
  if (state.opts.moonglow && moonAlt > 0 && moonIllum > 0 && lim > 3)
    lim = Math.max(3, lim - moonIllum * 2.5 * Math.sin(moonAlt * D2R));
  return Math.min(lim, user);
}

/* A star at the limiting magnitude is not switched on — it is at the
 * edge of detection.  Objects are therefore drawn fading over a
 * magnitude either side of the limit, so that as twilight deepens the
 * sky fills in gradually instead of in populations. */
const FADE_MAG = 1.3;
function skyFade(vmag, effLimit) {
  if (vmag == null) return 1;
  return Math.max(0, Math.min(1,
    (effLimit + FADE_MAG / 2 - vmag) / FADE_MAG));
}

/* how much of a diffuse layer (Milky Way, constellation art) the sky
 * brightness still allows: gone in daylight, full under a dark sky */
function diffuseFade(effLimit) {
  return Math.max(0, Math.min(1, (effLimit - 3.0) / 2.5));
}

/* ---------------- coordinate grid polylines ----------------
 * The grids follow the zoom.  Twelve meridians and nine parallels are
 * the right density for the whole sky and meaningless at a one-degree
 * field, where every line but one has left the screen — so the spacing
 * is chosen to keep roughly half a dozen lines across whatever is being
 * looked at, and the labels gain minutes and arcminutes as the steps
 * shrink past a degree.
 *
 * Samples are cached per (frame matrices, spacing): the matrices change
 * on each sky fetch, the spacing only when the zoom crosses a step. */
const GRID_STEPS_DEG = [30, 20, 10, 5, 2, 1, 0.5, 0.25, 0.1];
const GRID_STEPS_HOUR = [4, 2, 1, 0.5, 1 / 3, 1 / 6, 1 / 12, 1 / 30,
                         1 / 60];

function pickStep(ladder, want) {
  for (const v of ladder) if (v <= want) return v;
  return ladder[ladder.length - 1];
}

function gridSteps() {
  const field = fieldWidthDeg();
  const lat = pickStep(GRID_STEPS_DEG, field / 6);
  const lon = pickStep(GRID_STEPS_HOUR, field / 15 / 6);
  return { lat, lon, span: Math.min(180, field * 0.9),
           samp: Math.max(0.2, Math.min(3, lat / 3)) };
}

/* Where the chart is looking, in equatorial coordinates.  Past a field
 * of about 60° the grids are built whole; inside it only the lines that
 * can reach the screen are built, or a one-degree field would generate
 * every meridian on the sky to draw the two that are visible. */
function viewCentreRaDec() {
  const q = screenToRaDec(canvas.width / 2, canvas.height / 2);
  return q ? [q.ra, q.dec] : null;
}

/* lines of `frame` coordinates that lie within `span` of (l0, b0) */
function bandRange(l0, b0, span, step, wholeSky) {
  const out = { lon: [], lat: [] };
  if (wholeSky) {
    for (let l = 0; l < 360 - 1e-9; l += step.lonDeg) out.lon.push(l);
    for (let b = -90 + step.lat; b <= 90 - step.lat + 1e-9; b += step.lat)
      out.lat.push(b);
    return out;
  }
  const bLo = Math.max(-89.5, b0 - span), bHi = Math.min(89.5, b0 + span);
  const cosb = Math.max(0.05, Math.cos(b0 * D2R));
  const lSpan = Math.min(180, span / cosb);
  const n0 = Math.floor((l0 - lSpan) / step.lonDeg);
  const n1 = Math.ceil((l0 + lSpan) / step.lonDeg);
  for (let n = n0; n <= n1; n++)
    out.lon.push(((n * step.lonDeg % 360) + 360) % 360);
  const m0 = Math.ceil(bLo / step.lat), m1 = Math.floor(bHi / step.lat);
  for (let m = m0; m <= m1; m++) {
    const b = m * step.lat;
    if (Math.abs(b) <= 89.5) out.lat.push(b);
  }
  return out;
}

/* ±dd°mm′, dropping the minutes when the step does not need them */
function decLabel(d, step) {
  const fine = step != null && step < 1;
  const a = Math.abs(d);
  const deg = Math.floor(a + 1e-9);
  const min = Math.round((a - deg) * 60);
  const body = fine
    ? `${deg}°${String(min).padStart(2, "0")}′`
    : `${Math.round(a)}°`;
  if (Math.abs(d) < 1e-9) return fine ? "0°00′" : "0°";
  return (d > 0 ? "+" : "−") + body;
}

/* RA in hours, with minutes once the step is finer than an hour */
function raLabel(hours, step) {
  const h = ((hours % 24) + 24) % 24;
  if (step >= 1) return `${Math.round(h)}h`;
  const hh = Math.floor(h + 1e-9);
  const mm = Math.round((h - hh) * 60);
  return mm === 60 ? `${(hh + 1) % 24}h` : `${hh}h${String(mm).padStart(2, "0")}m`;
}

function lonLabel(deg, step) {
  if (step >= 1) return `${Math.round(((deg % 360) + 360) % 360)}°`;
  return decLabel(((deg % 360) + 360) % 360, step).replace(/^[+−]/, "");
}

function gridLinesEq() {
  const M = state.sky.matrices;
  const st = gridSteps();
  const centre = st.span >= 60 ? null : viewCentreRaDec();
  const whole = !centre;
  const [ra0, dec0] = centre || [0, 0];
  // quantised so panning does not rebuild the samples every frame
  const key = whole ? "all"
    : `${Math.round(ra0 / st.lon / 15)}|${Math.round(dec0 / st.lat)}`;
  if (state._gridCache && state._gridCache.m === M &&
      state._gridCache.lat === st.lat && state._gridCache.lon === st.lon &&
      state._gridCache.key === key)
    return state._gridCache;
  const cache = { m: M, lat: st.lat, lon: st.lon, key,
                  eq: [], ecl: [], gal: [] };
  const step = { lat: st.lat, lonDeg: st.lon * 15 };

  const mk = (Mx, arr, lonFmt) => {
    const [l0, b0] = Mx ? eqToFrame(Mx, ra0, dec0) : [ra0, dec0];
    const r = bandRange(l0, b0, st.span, step, whole);
    const bLo = whole ? -(90 - st.lat) : Math.max(-89.5, b0 - st.span);
    const bHi = whole ? 90 - st.lat : Math.min(89.5, b0 + st.span);
    for (const l of r.lon) {
      const pts = [];
      for (let b = bLo; b <= bHi + 1e-9; b += st.samp)
        pts.push(Mx ? frameToEq(Mx, l, b) : [l, b]);
      arr.push({ pts, label: lonFmt(l) });
    }
    const lLo = whole ? 0 : l0 - Math.min(180, st.span /
      Math.max(0.05, Math.cos(b0 * D2R)));
    const lHi = whole ? 360 : l0 + Math.min(180, st.span /
      Math.max(0.05, Math.cos(b0 * D2R)));
    for (const b of r.lat) {
      const pts = [];
      for (let l = lLo; l <= lHi + 1e-9; l += st.samp)
        pts.push(Mx ? frameToEq(Mx, ((l % 360) + 360) % 360, b)
                    : [((l % 360) + 360) % 360, b]);
      arr.push({ pts, label: decLabel(b, st.lat),
                 strong: Math.abs(b) < 1e-9 });
    }
  };
  mk(null, cache.eq, (l) => raLabel(l / 15, st.lon));
  mk(M.ecl2eq, cache.ecl, (l) => lonLabel(l, step.lonDeg));
  mk(M.gal2eq, cache.gal, (l) => lonLabel(l, step.lonDeg));
  state._gridCache = cache;
  return cache;
}

/* The three circles people name rather than count: the celestial
 * equator, the ecliptic and the local meridian.  They are lines of the
 * grids above — dec 0, ecliptic latitude 0, azimuth 0/180 — but an
 * observer wants any of them without the twenty other lines that come
 * with a grid, so each is its own switch and is drawn emphasised.
 *
 * The first two are fixed on the sky and cached with the frame
 * matrices; the meridian is fixed to the observer and is built in
 * horizontal coordinates, which is why it is kept apart. */
function specialCircles() {
  const M = state.sky.matrices;
  if (state._circCache && state._circCache.m === M)
    return state._circCache;
  const eq = [], ecl = [];
  for (let r = 0; r <= 360; r += 2) {
    eq.push([r, 0]);
    ecl.push(frameToEq(M.ecl2eq, r, 0));
  }
  const cache = {
    m: M,
    equator: [{ pts: eq, strong: true, labelFrac: [0.3, 0.8],
                label: t("ui.line_equator") }],
    ecliptic: [{ pts: ecl, strong: true, labelFrac: [0.3, 0.8],
                 label: t("ui.line_ecliptic") }],
  };
  state._circCache = cache;
  return cache;
}

function meridianLine() {
  const pts = [];
  for (let a = 0; a <= 90; a += 2) pts.push([0, a]);      // north half
  for (let a = 88; a >= 0; a -= 2) pts.push([180, a]);    // south half
  return [{ pts, azLine: true, strong: true, labelFrac: [0.15, 0.85],
            label: t("ui.line_meridian") }];
}

function altazWholeSky(st) {
  const saved = state._altazLines;
  state._altazLines = null;
  const lines = [];
  for (let az = 0; az < 360; az += 30) {
    const pts = [];
    for (let a = 0; a <= 88; a += 2) pts.push([az, a]);
    lines.push({ pts, azLine: true, labelFrac: [0.06],
                 label: `${az}°` });
  }
  state._altazLines = saved;
  return lines;
}

function altazGridLines() {
  const st = gridSteps();
  const whole = st.span >= 60;
  const [az0, alt0] = whole ? [0, 0] : viewCenterAzAlt();
  if (!whole && !isFinite(az0)) return altazWholeSky(st);
  const key = whole ? "all"
    : `${Math.round(az0 / st.lat)}|${Math.round(alt0 / st.lat)}`;
  if (state._altazLines && state._altazLines.lat === st.lat &&
      state._altazLines.lon === st.lon && state._altazLines.key === key)
    return state._altazLines.lines;
  const dirs = state.lang === "ja" ? ["北", "東", "南", "西"]
                                   : ["N", "E", "S", "W"];
  const lines = [];
  // the compass points always keep a line of their own, whatever the
  // spacing works out to: they are the frame the view is read against
  const azStep = Math.min(30, st.lat);
  const rng = bandRange(az0, alt0, st.span, { lat: st.lat, lonDeg: azStep },
                        whole);
  const aLo = whole ? 0 : Math.max(0, alt0 - st.span);
  const aHi = whole ? Math.min(88, 90 - st.lat / 2)
                    : Math.min(89.5, alt0 + st.span);
  for (const az of rng.lon) {
    const pts = [];
    for (let a = aLo; a <= aHi + 1e-9; a += st.samp) pts.push([az, a]);
    const card = Math.abs(az % 90) < 1e-9;
    lines.push({ pts, azLine: true, labelFrac: [0.06],
                 label: card ? dirs[Math.round(az / 90) % 4]
                             : lonLabel(az, azStep) });
  }
  const zLo = whole ? 0 : az0 - Math.min(180, st.span /
    Math.max(0.05, Math.cos(alt0 * D2R)));
  const zHi = whole ? 360 : az0 + Math.min(180, st.span /
    Math.max(0.05, Math.cos(alt0 * D2R)));
  const alts = whole
    ? rng.lat.filter((a) => a >= 0)
    : rng.lat.filter((a) => a >= 0 && a <= 89.5);
  if (whole && !alts.includes(0)) alts.unshift(0);
  for (const a of alts) {
    const pts = [];                                // altitude circles
    for (let z = zLo; z <= zHi + 1e-9; z += st.samp)
      pts.push([((z % 360) + 360) % 360, a]);
    lines.push({ pts, label: a === 0 ? null : decLabel(a, st.lat)
                   .replace(/^\+/, ""),
                 strong: a === 0, labelFrac: [0.52] });
  }
  state._altazLines = { lat: st.lat, lon: st.lon, key, lines };
  return lines;
}

/* draw one family of grid polylines with clipping (skip null projections
 * and jumps > W/3) and 1-2 low-alpha labels per line.
 *
 * `rim` puts each line's number where the line leaves the chart instead
 * of somewhere along it: read round the edge, 0h 2h 4h … is a scale,
 * while the same numbers scattered over the sky are clutter on top of
 * the stars.  Lines that never reach the edge keep their inline label. */
function drawGridSet(c, lines, toScreen, color, strongColor, labelColor,
                     px, W, skipAzLabels, rim) {
  const jump = W / 3;
  c.font = `${10 * px}px sans-serif`;
  c.textAlign = "left";
  c.textBaseline = "bottom";
  for (const ln of lines) {
    c.strokeStyle = ln.strong && strongColor ? strongColor : color;
    c.lineWidth = (ln.strong ? 1.8 : 1) * px;
    c.beginPath();
    let prev = null;
    const vis = [];
    for (const q of ln.pts) {
      const p = toScreen(q[0], q[1]);
      if (!p) { prev = null; continue; }
      if (prev && Math.hypot(p[0] - prev[0], p[1] - prev[1]) < jump)
        c.lineTo(p[0], p[1]);
      else c.moveTo(p[0], p[1]);
      prev = p;
      vis.push(p);
    }
    c.stroke();
    if (!ln.label || vis.length < 6) continue;
    if (skipAzLabels && ln.azLine) continue;      // allsky: rim labels used
    c.fillStyle = labelColor;
    if (rim) {
      const edge = rimLabelSpot(vis, rim, px);
      if (edge) {
        c.globalAlpha = 0.85;
        c.textAlign = edge.align;
        c.textBaseline = edge.baseline;
        c.fillText(ln.label, edge.x, edge.y);
        c.globalAlpha = 1;
        c.textAlign = "left";
        c.textBaseline = "bottom";
        continue;
      }
    }
    c.globalAlpha = 0.45;
    const fr = ln.labelFrac || [0.33, 0.75];
    const used = vis.length >= 40 ? fr : fr.slice(0, 1);
    for (const f of used) {
      const p = vis[Math.min(vis.length - 1, Math.floor(vis.length * f))];
      c.fillText(ln.label, p[0] + 2 * px, p[1] - 2 * px);
    }
    c.globalAlpha = 1;
  }
}

/* Where a grid line meets the edge of the chart, and how the number
 * should sit there.  In the whole-sky view the edge is the horizon
 * circle, so the label goes just outside it, radially; in the horizon
 * view it is the frame of the canvas. */
function rimLabelSpot(vis, rim, px) {
  const pad = 3 * px;
  if (rim.allsky) {
    const { cx, cy, r } = rim;
    let best = null, bd = Infinity;
    for (const p of vis) {
      const d = Math.abs(Math.hypot(p[0] - cx, p[1] - cy) - r);
      if (d < bd) { bd = d; best = p; }
    }
    if (!best || bd > 12 * px) return null;       // never reaches the rim
    // just inside the horizon circle: the ring outside it is the
    // azimuth scale, and two sets of numbers on the same ring read as
    // one muddled scale
    const a = Math.atan2(best[1] - cy, best[0] - cx);
    const x = cx + (r - 13 * px) * Math.cos(a);
    const y = cy + (r - 13 * px) * Math.sin(a);
    if (x < pad || y < pad || x > rim.W - pad || y > rim.H - pad)
      return null;
    return { x, y,
             align: Math.cos(a) > 0.3 ? "right"
                  : Math.cos(a) < -0.3 ? "left" : "center",
             baseline: Math.sin(a) > 0.3 ? "bottom"
                     : Math.sin(a) < -0.3 ? "top" : "middle" };
  }
  // horizon view: the topmost point still inside the frame
  let best = null;
  for (const p of vis)
    if (p[1] > 14 * px && (!best || p[1] < best[1])) best = p;
  if (!best || best[1] > rim.H * 0.5) return null;
  return { x: best[0], y: best[1] - 2 * px,
           align: "center", baseline: "bottom" };
}

/* ---------------- rendering ---------------- */
/* render() paints the whole chart into any 2d context; draw() uses it for
 * the screen, exportChart() for the offscreen print canvas. */
function render(c, W, H, pal, px, collectHit, ropts = {}) {
  if (!state.sky) return;
  const trail = !!ropts.trail;   // 光跡残し: plot-only frame, no bg/labels
  const v = state.view;
  const lst = currentLst();
  const lat = state.sky.site.lat_deg;
  const P = (ra, dec) => {
    const [az, alt] = altaz(ra, dec, lst, lat);
    const p = project(az, alt, W, H);
    return p ? [p[0], p[1], az, alt] : null;
  };
  const hits = collectHit ? [] : null;
  // Point markers are sized for legibility at the scale of the chart.
  // The dot that reads well across a 1100 px desktop chart is a blob
  // when the whole sky is squeezed into a 400 px phone screen, so the
  // markers shrink with the chart — and stop at half size, below which
  // the faint end would disappear rather than merely look smaller.
  const dotScale = Math.max(0.5, Math.min(1.0,
    Math.min(W, H) / px / 700));
  // Labels shrink with the chart too — a phone shows the same number of
  // names in a third of the width, so they collide — but they stop at
  // three quarters, below which they stop being readable rather than
  // merely being small.
  const labelScale = Math.max(0.75, dotScale);
  const allsky = v.mode === "allsky";
  const R = Math.min(W, H) / 2 * ALLSKY_FILL * v.zoom;
  const zenithCentered = !allsky || v.allskyCenter.alt >= 89.99;
  // panned all-sky shows up to ALLSKY_MAXDIST°, so the disc is larger
  // stereographic radius of the drawn sky disc, clamped: at high zoom it
  // runs to millions of pixels and only its on-canvas part can matter
  const Rbg = Math.min(zenithCentered ? R
    : R * Math.tan(ALLSKY_MAXDIST / 2 * D2R), 4 * Math.hypot(W, H));

  // sun/moon state drives twilight background + sky-glow mag limit
  const sun = state.sky.planets.find((p) => p.key === "sun");
  const moon = state.sky.planets.find((p) => p.key === "moon");
  let sunAlt = -30, moonAlt = -30, moonAz = 0, moonIllum = 0;
  if (sun) sunAlt = altaz(sun.ra, sun.dec, lst, lat)[1];
  if (moon) {
    [moonAz, moonAlt] = altaz(moon.ra, moon.dec, lst, lat);
    moonIllum = moon.illum || 0;
  }
  const effLimit = effectiveLimit(sunAlt, moonAlt, moonIllum);
  state._effLimit = effLimit;

  // --- background
  if (trail) { /* trailing: previous frame kept, faded by draw() */ }
  else if (pal.print) {
    c.fillStyle = "#fff";
    c.fillRect(0, 0, W, H);
    if (allsky) {                                 // chart rim
      c.strokeStyle = "#666"; c.lineWidth = px;
      c.beginPath(); c.arc(W / 2, H / 2, Rbg, 0, 7); c.stroke();
    }
  } else {
    // twilight background, interpolated rather than stepped so the sky
    // darkens smoothly through the three twilights
    let bgTop = "#000005";
    if (state.opts.skyglow && pal.twilight)
      bgTop = twilightColour(sunAlt, pal.nv);
    else bgTop = "#000000";                       // sky glow off: plain
    const g = c.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, bgTop);
    g.addColorStop(1, "#000000");
    c.fillStyle = g;
    if (allsky) {
      c.beginPath(); c.arc(W / 2, H / 2, Rbg, 0, 7); c.fill();
    } else c.fillRect(0, 0, W, H);
  }

  // The whole sky is a disc in the all-sky view, and anything painted
  // over an area rather than at a projected point has to stop at its
  // rim: a Moon near the horizon projects to the edge, so its halo used
  // to spill onto the black surround as a bright crescent outside the
  // chart (which video compression then banded into a white ring).
  const clipToSky = () => {
    if (!allsky) return;
    c.beginPath(); c.arc(W / 2, H / 2, Rbg, 0, 7); c.clip();
  };

  // --- moon glow (screen + sky glow on only; skipped in night vision)
  if (!trail && state.opts.skyglow && state.opts.moonglow &&
      pal.glow && moon && moonAlt > -2) {
    const mp = project(moonAz, moonAlt, W, H);
    if (mp) {
      const rad = (60 + 140 * moonIllum) * px;
      const peak = 0.10 + 0.20 * moonIllum;
      const gg = c.createRadialGradient(mp[0], mp[1], 0,
                                        mp[0], mp[1], rad);
      gg.addColorStop(0, `rgba(200,210,230,${peak})`);
      gg.addColorStop(1, "rgba(200,210,230,0)");
      c.save();
      clipToSky();
      c.fillStyle = gg;
      c.fillRect(mp[0] - rad, mp[1] - rad, rad * 2, rad * 2);
      c.restore();
    }
  }

  // --- Milky Way (before stars); hidden when sky glow washes it out
  const skyDim = state.opts.skyglow ? diffuseFade(effLimit) : 1;
  state._skyDim = skyDim;
  // Whole-sky only.  In the horizon view the projection stretches the
  // panorama badly at both the horizon and the zenith, and what is left
  // in between is a grey wash across a view whose point is the stars.
  if (!trail && state.opts.milkyway && state.view.mode === "allsky" &&
      state._mwImg && skyDim > 0.02) {
    const t0 = performance.now();
    drawMilkywayTex(c, W, H, pal, lst, lat);
    state._mwMs = performance.now() - t0;
  }

  // --- constellation artwork (星座絵, under lines/stars),
  // clipped to the sky disc in all-sky mode.
  //
  // Unlike the Milky Way, the figures are an annotation rather than
  // something in the sky: they are what the observer asked to be shown,
  // so they are drawn whatever the limiting magnitude.  Fading them out
  // with the naked-eye limit meant that lowering the slider — exactly
  // what someone does under a city sky — quietly deleted them.
  if (!trail && state.opts.conart && _artIndex && !pal.print) {
    c.save();
    if (allsky) {
      c.beginPath(); c.arc(W / 2, H / 2, Rbg, 0, 7); c.clip();
    }
    drawConstellationArt(c, W, H, pal, lst, lat);
    c.restore();
  }

  // --- all-sky ground: when panned off the zenith the region outside
  // the horizon ring (alt<0, up to ALLSKY_MAXDIST) is filled as ground
  if (!trail && allsky && !zenithCentered && !pal.print) {
    const groundCol = pal.nv ? "#1c0606" : "#141c0c";
    c.save();
    c.beginPath(); c.arc(W / 2, H / 2, Rbg + px, 0, 7); c.clip();
    c.beginPath();
    c.rect(-2, -2, W + 4, H + 4);
    for (let az = 0; az <= 360; az += 2) {
      const p = allskyXY(az, 0, W, H);
      if (az === 0) c.moveTo(p[0], p[1]); else c.lineTo(p[0], p[1]);
    }
    c.closePath();
    c.fillStyle = groundCol;
    c.fill("evenodd");
    c.restore();
  }

  // --- coordinate grids (4 independent families, spec §1)
  const gset = state.sky.matrices ? gridLinesEq() : null;
  if (!trail && state.opts.grid_altaz) {
    drawGridSet(c, altazGridLines(),
      (az, alt) => project(az, alt, W, H),
      pal.grid.altaz, pal.gridStrong, pal.gridLabel, px, W, allsky);
    if (allsky) {                                 // direction labels
      c.fillStyle = pal.gridLabel;
      c.font = `${12 * px}px sans-serif`;
      c.textAlign = "center"; c.textBaseline = "middle";
      const dirs = state.lang === "ja" ? ["北", "東", "南", "西"]
                                       : ["N", "E", "S", "W"];
      const mir = state.opts.mirror ? -1 : 1;
      for (let az = 0; az < 360; az += 30) {
        const card = az % 90 === 0;
        let lx, ly;
        if (zenithCentered) {                     // historical rim labels
          lx = W / 2 - mir * (R + 14 * px) * Math.sin(az * D2R);
          ly = H / 2 - (R + 14 * px) * Math.cos(az * D2R);
        } else {                                  // panned: on the horizon
          const p = project(az, 0, W, H);
          if (!p) continue;
          lx = p[0]; ly = p[1];
        }
        if (!card) c.globalAlpha = 0.45;
        c.fillText(card ? dirs[az / 90] : `${az}°`, lx, ly);
        c.globalAlpha = 1;
      }
    }
  }
  const eqScreen = (ra, dec) => {
    const [az, alt] = altaz(ra, dec, lst, lat);
    return project(az, alt, W, H);
  };
  // numbers round the edge of the chart rather than across the stars
  const rim = allsky && zenithCentered
    ? { allsky: true, cx: W / 2, cy: H / 2, r: R, W, H }
    : { allsky: false, W, H };
  if (gset && !trail) {
    if (state.opts.grid_eq)
      drawGridSet(c, gset.eq, eqScreen, pal.grid.eq, pal.gridStrong,
                  pal.gridLabel, px, W, false, rim);
    if (state.opts.grid_ecl)
      drawGridSet(c, gset.ecl, eqScreen, pal.grid.ecl, pal.gridStrong,
                  pal.gridLabel, px, W, false, rim);
    if (state.opts.grid_gal)
      drawGridSet(c, gset.gal, eqScreen, pal.grid.gal, pal.gridStrong,
                  pal.gridLabel, px, W, false, rim);
    // the named circles, in the colour of the family they belong to
    const circ = specialCircles();
    if (state.opts.line_equator)
      drawGridSet(c, circ.equator, eqScreen, pal.grid.eq, pal.grid.eq,
                  pal.gridLabel, px, W);
    if (state.opts.line_ecliptic)
      drawGridSet(c, circ.ecliptic, eqScreen, pal.grid.ecl, pal.grid.ecl,
                  pal.gridLabel, px, W);
  }
  if (!trail && state.opts.line_meridian)
    drawGridSet(c, meridianLine(), (az, alt) => project(az, alt, W, H),
                pal.grid.altaz, pal.grid.altaz, pal.gridLabel, px, W,
                allsky);

  // --- a photograph laid on the sky (the demo's field-of-view scene)
  if (state.photoOverlay && !trail) {
    c.save();
    clipToSky();
    drawSkyPhoto(c, state.photoOverlay, W, H, P);
    c.restore();
  }

  // --- constellation lines
  if (state.opts.lines && !trail) {
    c.strokeStyle = pal.conLine;
    c.lineWidth = px;
    c.beginPath();
    for (const [r1, d1, r2, d2] of state.sky.lines) {
      const p1 = P(r1, d1), p2 = P(r2, d2);
      if (p1 && p2 &&
          Math.hypot(p1[0] - p2[0], p1[1] - p2[1]) < W / 3) {
        c.moveTo(p1[0], p1[1]); c.lineTo(p2[0], p2[1]);
      }
    }
    c.stroke();
  }

  // --- deep (Tycho-2) stars: horizon mode, maglimit > 6.5.  They may
  // overplot the bright catalog near mag 6-6.5 — acceptable, no dedupe.
  const deepLim = deepMagLimit();
  if (state.deepStars && deepLim > 6.5) {
    const effDeep = effectiveLimit(sunAlt, moonAlt, moonIllum, deepLim);
    let deepAlpha = 1;
    for (const s of state.deepStars) {
      const vm = s[2];
      if (vm > deepLim) continue;
      const fd = skyFade(vm, effDeep);
      if (fd <= 0.02) continue;
      const p = P(s[0], s[1]);
      if (!p || p[3] < 0) continue;
      const r = Math.max(0.3, (13 - vm) * 0.22) * px * dotScale;
      if (fd !== deepAlpha) { c.globalAlpha = fd; deepAlpha = fd; }
      c.fillStyle = pal.print ? "#000" : bvColor(s[3]);
      if (r < 0.9 * px) c.fillRect(p[0] - r, p[1] - r, r * 2, r * 2);
      else { c.beginPath(); c.arc(p[0], p[1], r, 0, 7); c.fill(); }
    }
    if (deepAlpha !== 1) c.globalAlpha = 1;
  }

  // --- bright stars (faded near the limiting magnitude, so twilight
  // brings them out gradually instead of in populations)
  let starAlpha = 1;
  for (const s of state.sky.stars) {
    const [ra, dec, vmag, bv, name] = s;
    if (vmag > state.opts.maglimit) continue;
    const fade = vmag <= -1 ? 1 : skyFade(vmag, effLimit);
    if (fade <= 0.02) continue;
    const p = P(ra, dec);
    if (!p || p[3] < 0) continue;
    const r = Math.max(0.5, (6.8 - vmag) * 0.62) * px * dotScale *
      (0.75 + 0.25 * fade);
    if (fade !== starAlpha) { c.globalAlpha = fade; starAlpha = fade; }
    c.fillStyle = pal.star(bv);
    c.beginPath(); c.arc(p[0], p[1], r, 0, 7); c.fill();
    if (name) {
      if (hits) hits.push({ x: p[0], y: p[1], kind: "star", name, ra, dec,
                            vmag, az: p[2], alt: p[3] });
      if (state.opts.starnames && vmag < 1.6 && !trail) {
        c.fillStyle = pal.starLabel;
        c.font = `${11 * px * labelScale}px sans-serif`;
        c.textAlign = "left"; c.textBaseline = "alphabetic";
        c.fillText(name, p[0] + r + 3 * px, p[1]);
      }
    }
  }
  if (starAlpha !== 1) { c.globalAlpha = 1; starAlpha = 1; }

  // --- constellation names (clickable when 星座解説 data is loaded)
  if (state.opts.connames && !trail) {
    c.fillStyle = pal.conName;
    c.font = `${12 * px * labelScale}px sans-serif`;
    c.textAlign = "center"; c.textBaseline = "alphabetic";
    for (const cn of state.sky.connames) {
      const p = P(cn.ra, cn.dec);
      if (p && p[3] > 5) {
        const nm = state.lang === "ja" ? cn.ja : cn.en;
        c.fillText(nm, p[0], p[1]);
        if (hits && state.conInfo && state.conInfo[cn.abbr])
          hits.push({ x: p[0], y: p[1], kind: "constellation",
                      abbr: cn.abbr, name: nm, ra: cn.ra, dec: cn.dec,
                      az: p[2], alt: p[3] });
      }
    }
  }

  // --- DSO
  if (state.opts.dso && state.sky.dso && !trail) {
    c.strokeStyle = pal.dso;
    c.font = `${10 * px * labelScale}px sans-serif`;
    let dsoAlpha = 1;
    for (const d of state.sky.dso) {
      const fd = d.vmag != null ? skyFade(d.vmag, effLimit) : skyDim;
      if (fd <= 0.02) continue;
      const p = P(d.ra, d.dec);
      if (!p || p[3] < 0) continue;
      if (fd !== dsoAlpha) { c.globalAlpha = fd; dsoAlpha = fd; }
      c.lineWidth = px;
      const dr = 4 * px * dotScale;
      c.strokeRect(p[0] - dr, p[1] - dr, dr * 2, dr * 2);
      if (hits) hits.push({ x: p[0], y: p[1], kind: "dso",
        name: (state.lang === "ja" && d.name_ja) ? d.name_ja
              : (d.name_en || d.id),
        id: d.id, ra: d.ra, dec: d.dec, vmag: d.vmag,
        dso: d, az: p[2], alt: p[3] });
    }
    if (dsoAlpha !== 1) c.globalAlpha = 1;
  }

  // --- planets, sun, moon (never magnitude-limited)
  if (state.opts.planets) {
    for (const pl of state.sky.planets) {
      const p = P(pl.ra, pl.dec);
      if (!p || p[3] < -1) continue;
      const name = state.lang === "ja" ? pl.name_ja : pl.name_en;
      let r = 4 * px * dotScale;
      if (pl.key === "sun" || pl.key === "moon") r = 8 * px * dotScale;
      // true angular size once the field is narrow enough to show it;
      // beyond a few pixels the disk is rendered from the surface map
      let drawn = false;
      if (pl.diam) {
        const rpx = pl.diam / 7200 * (W / fieldWidthDeg());
        if (rpx > DISK_MIN_RADIUS_PX) {
          drawn = drawBodyDisk(c, p[0], p[1], rpx, pl, W, H, pal);
          if (drawn) r = rpx;
        }
      }
      if (!drawn) {
        c.fillStyle = pal.planetColor(pl.key);
        c.beginPath(); c.arc(p[0], p[1], r, 0, 7); c.fill();
      }
      // 衛星: drawn whatever the limiting magnitude, once the planet is
      // big enough on screen for them to be separable at all
      if (pl.moons && !trail) {
        const rp = pl.diam ? pl.diam / 7200 * (W / fieldWidthDeg()) : 0;
        if (rp > 0.8) drawPlanetMoons(c, pl, rp, W, H, pal, px, hits);
      }
      if (!drawn && pl.key === "moon" && pl.illum != null && !pal.nv &&
          !pal.print) {
        // Exact phase rendering: the night side is the anti-sunward
        // semicircle closed by the terminator, a half-ellipse whose
        // semi-axis is r·(1−2k) — so the drawn shape matches the
        // illuminated fraction k (and hence the moon age) exactly:
        // k=0 new (all dark), k=0.25 crescent, k=0.5 quarter (straight
        // terminator), k=0.75 gibbous, k→1 full (no shadow).
        // (The old code drew a dark circle centered on the disk, which
        // looked like a hole and ignored the phase geometry.)
        const k = Math.max(0, Math.min(1, pl.illum));
        if (k < 0.99) {
          let ang = Math.PI / 2;         // fallback: dark side below
          if (sun) {
            const saz = altaz(sun.ra, sun.dec, lst, lat);
            const sp = projectRaw(saz[0], saz[1], W, H);
            if (sp)                       // anti-sunward direction
              ang = Math.atan2(p[1] - sp[1], p[0] - sp[0]);
          }
          const e = r * (1 - 2 * k);      // signed terminator semi-axis
          c.save();
          c.translate(p[0], p[1]);
          c.rotate(ang);                  // +x now points away from sun
          c.fillStyle = "rgba(16,20,30,0.94)";
          c.beginPath();
          c.arc(0, 0, r, -Math.PI / 2, Math.PI / 2);   // anti-sun half
          if (e >= 0)                     // crescent: bulge toward sun
            c.ellipse(0, 0, Math.max(e, 0.01), r, 0,
                      Math.PI / 2, 3 * Math.PI / 2, false);
          else                            // gibbous: bulge anti-sunward
            c.ellipse(0, 0, -e, r, 0,
                      Math.PI / 2, 3 * Math.PI / 2, true);
          c.fill();
          c.restore();
        }
      }
      if (!trail) {
        c.fillStyle = pal.planetLabel;
        c.font = `bold ${11 * px * labelScale}px sans-serif`;
        c.textAlign = "center"; c.textBaseline = "alphabetic";
        c.fillText(name, p[0], p[1] - r - 4 * px);
      }
      if (hits) hits.push({ x: p[0], y: p[1], kind: "planet", key: pl.key,
        name, ra: pl.ra, dec: pl.dec, vmag: pl.mag,
        az: p[2], alt: p[3] });
    }
  }

  // --- comets & asteroids (selected in the 天体 tab)
  if (state.sky.smallbodies && state.sky.smallbodies.length) {
    const sunScr = sun ? projectRaw(
      ...altaz(sun.ra, sun.dec, lst, lat), W, H) : null;
    c.font = `${10 * px}px sans-serif`;
    c.textAlign = "left"; c.textBaseline = "alphabetic";
    for (const b of state.sky.smallbodies) {
      const p = P(b.ra, b.dec);
      if (!p || p[3] < -1) continue;
      if (b.kind === "comet") {
        const r = 2.2 * px;
        c.fillStyle = c.strokeStyle = pal.comet;
        c.beginPath(); c.arc(p[0], p[1], r, 0, 7); c.fill();
        if (sunScr && !trail) {       // short tail pointing away from sun
          let dx = p[0] - sunScr[0], dy = p[1] - sunScr[1];
          const n = Math.hypot(dx, dy) || 1;
          dx /= n; dy /= n;
          c.lineWidth = px;
          c.beginPath();
          c.moveTo(p[0] + dx * r, p[1] + dy * r);
          c.lineTo(p[0] + dx * (r + 4 * px), p[1] + dy * (r + 4 * px));
          c.stroke();
        }
        if (!trail) c.fillText(b.name, p[0] + 4 * px, p[1] - 3 * px);
      } else {
        const s2 = 2 * px;
        c.fillStyle = pal.asteroid;
        c.fillRect(p[0] - s2, p[1] - s2, s2 * 2, s2 * 2);
        if (!trail) c.fillText(b.name, p[0] + 4 * px, p[1] - 3 * px);
      }
      if (hits) hits.push({ x: p[0], y: p[1], kind: b.kind, name: b.name,
        id: b.id, ra: b.ra, dec: b.dec, vmag: b.mag,
        az: p[2], alt: p[3] });
    }
  }

  // --- 衛星パスの軌跡 (an event selection draws the pass)
  if (!trail && state.satPass) drawSatPass(c, W, H, pal, px);

  // --- 流星群 (an event selection animates the shower)
  if (!trail && state.shower) {
    drawMeteors(c, W, H, pal, px, effLimit);
    drawRadiant(c, W, H, pal, px, hits);
  }

  // --- 人工衛星 (TLE): interpolated inside the streamed track window
  if (state.sat.on) drawSatellites(c, W, H, pal, px, hits);

  // --- 選択中の天体: reticle around the object latched by the last
  // chart click (its data is shown in the 音声 tab)
  if (!trail && state.selected) {
    const p = P(state.selected.ra, state.selected.dec);
    if (p) {
      const r = 11 * px;
      c.strokeStyle = pal.print ? "#000"
        : pal.nv ? "#ff6060" : "#6ea8ff";
      c.lineWidth = 1.3 * px;
      c.beginPath();
      c.arc(p[0], p[1], r, 0, 7);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        c.moveTo(p[0] + dx * r * 1.25, p[1] + dy * r * 1.25);
        c.lineTo(p[0] + dx * r * 1.9, p[1] + dy * r * 1.9);
      }
      c.stroke();
    }
  }

  // --- 地平線・地面・方位: drawn AFTER the objects so anything below
  // the horizon (or the ridge line) is hidden — that is the point of
  // the horizon mask.  The bearing scale goes on top of both.
  if (v.mode === "horizon") {
    if (state.horizonMask && state.horizonMask.defined)
      drawTerrain(c, W, H, pal, px);
    else
      drawFlatGround(c, W, H, pal, px);
    drawHorizonRef(c, W, H, pal, px);
  }

  // --- 写野角 (FOV) frames — compositional overlay, on top of terrain
  if (!trail && state.fovFrames.length)
    drawFovFrames(c, W, H, pal, px, P);

  if (!trail && state.demo) drawDemoCaption(c, W, H, pal, px);

  // --- field-of-view readout: with a zoom range from 160° to 1′ the
  // scale is no longer obvious from the picture alone
  if (!trail && !pal.print) {
    // In the whole-sky view the number people expect is the sweep
    // around the horizon — the full circle at zoom 1 — not the 180
    // degrees from horizon to horizon across the dome.
    const w = v.mode === "allsky"
      ? Math.min(360, 360 / v.zoom) : fieldWidthDeg();
    let txt = `${t("ui.field")} ${angleLabel(w)}`;
    if (v.follow) txt += ` · ${t("ui.following")}: ${v.follow.name}`;
    c.font = `${11 * px}px sans-serif`;
    c.textAlign = "left"; c.textBaseline = "top";
    c.fillStyle = pal.nv ? "#a02020" : "#8fa4c8";
    c.fillText(txt, 8 * px, 6 * px);
  }

  if (hits) state.hit = hits;
}

/* ---------------- terrain silhouette (horizon mode) ---------------- */
function drawTerrain(c, W, H, pal, px) {
  const v = state.view, mask = state.horizonMask;
  const mir = state.opts.mirror ? -1 : 1;
  const pxPerDeg = W / v.fov;
  const sc = horizonAzScale(W, H);
  const yOf = (alt) => H * 0.92 - (alt - v.altOffset) * pxPerDeg;
  const ground = pal.print ? "#ddd" : pal.nv ? "#1c0606" : "#1a2410";
  const ridge = pal.print ? "#999" : pal.nv ? "#4a1010" : "#33481f";
  const half = v.fov / 2 / sc + 4;
  const a0 = -half, a1 = half, stepA = Math.max(0.02, (a1 - a0) / 400);
  const pts = [];
  for (let da = a0; da <= a1; da += stepA) {
    const alt = Math.max(0, maskAlt(mask, v.azCenter + da));
    pts.push([W / 2 + mir * da * sc * pxPerDeg, yOf(alt)]);
  }
  c.beginPath();
  for (let i = 0; i < pts.length; i++)
    i ? c.lineTo(pts[i][0], pts[i][1]) : c.moveTo(pts[i][0], pts[i][1]);
  c.lineTo(pts[pts.length - 1][0], H + 4 * px);
  c.lineTo(pts[0][0], H + 4 * px);
  c.closePath();
  c.fillStyle = ground;
  c.fill();
  c.beginPath();                       // subtle ridge line
  for (let i = 0; i < pts.length; i++)
    i ? c.lineTo(pts[i][0], pts[i][1]) : c.moveTo(pts[i][0], pts[i][1]);
  c.strokeStyle = ridge;
  c.lineWidth = 1.2 * px;
  c.stroke();
}

/* ---------------- 地平線と方位 (horizon mode) ----------------------
 * Horizon mode previously showed the ground only for the handful of
 * sites that carry a measured terrain profile, and the bearings only as
 * faint alt-az grid labels (which the user can switch off).  Both are
 * now unconditional in this mode: a flat ground fill where no profile
 * exists, the true astronomical horizon (alt = 0) as a line, and an
 * azimuth scale with 16-point compass names.
 * The scale is pinned inside the canvas when the view is panned in
 * altitude far enough to push alt = 0 off screen, so the bearings stay
 * readable while sweeping the sky. */
const COMPASS16_JA = ["北", "北北東", "北東", "東北東", "東", "東南東",
                      "南東", "南南東", "南", "南南西", "南西", "西南西",
                      "西", "西北西", "北西", "北北西"];
const COMPASS16_EN = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
                      "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];

/* flat ground fill for sites without a measured terrain profile */
function drawFlatGround(c, W, H, pal, px) {
  const v = state.view;
  const y0 = H * 0.92 + v.altOffset * (W / v.fov);
  if (y0 >= H) return;
  c.fillStyle = pal.print ? "#eeeeee" : pal.nv ? "#160404" : "#0c1207";
  c.fillRect(0, Math.max(0, y0), W, H - Math.max(0, y0));
}

function drawHorizonRef(c, W, H, pal, px) {
  const v = state.view;
  const mir = state.opts.mirror ? -1 : 1;
  const pxPerDeg = W / v.fov;
  const y0 = H * 0.92 + v.altOffset * pxPerDeg;
  const lineCol = pal.print ? "#555" : pal.nv ? "#a02020" : "#7d93b8";
  const textCol = pal.print ? "#222" : pal.nv ? "#e84040" : "#d3e0f6";

  if (y0 > -2 && y0 < H + 2) {                  // the horizon itself
    c.strokeStyle = lineCol;
    c.lineWidth = 1.5 * px;
    c.beginPath();
    c.moveTo(0, y0); c.lineTo(W, y0);
    c.stroke();
  }
  const yb = Math.max(26 * px, Math.min(H - 6 * px, y0));

  // label/tick density follows the zoom so the scale never crowds
  const sc = horizonAzScale(W, H);
  const azSpan = v.fov / sc;            // azimuth degrees across the view
  const nameStep = azSpan > 110 ? 90 : azSpan > 55 ? 45 : 22.5;
  const stepOf = (target) => {          // ~target labels across the view
    const raw = azSpan / target;
    for (const s of [0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2,
                     0.5, 1, 2, 5, 10, 20, 30, 45, 90])
      if (s >= raw) return s;
    return 90;
  };
  const tickStep = stepOf(24);
  const degStep = stepOf(6);
  const names = state.lang === "ja" ? COMPASS16_JA : COMPASS16_EN;
  const half = azSpan / 2 + 2;
  const a0 = v.azCenter - half, a1 = v.azCenter + half;
  const xOf = (az) => {
    const da = ((az - v.azCenter + 540) % 360) - 180;
    return W / 2 + mir * da * sc * pxPerDeg;
  };
  const eachAz = (step, fn) => {
    for (let az = Math.ceil(a0 / step) * step; az <= a1; az += step)
      fn(((az % 360) + 360) % 360, xOf(az));
  };

  c.strokeStyle = lineCol;
  c.lineWidth = px;
  c.beginPath();
  eachAz(tickStep, (az, x) => {
    c.moveTo(x, yb - 4 * px);
    c.lineTo(x, yb + 4 * px);
  });
  c.stroke();

  // Below the axis, degrees first and the compass names under them:
  // the numbers belong to the tick marks they label, so they sit next
  // to them, and the names read as the caption of the whole scale.
  const degY = yb + 5 * px, nameY = degY + 14 * px;
  c.fillStyle = textCol;                        // 16-point compass names
  c.textAlign = "center";
  c.textBaseline = "top";
  eachAz(nameStep, (az, x) => {
    const idx = Math.round(az / 22.5) % 16;
    const cardinal = idx % 4 === 0;
    c.font = `${cardinal ? "bold " : ""}` +
      `${(cardinal ? 15 : idx % 2 === 0 ? 12 : 10.5) * px}px sans-serif`;
    c.globalAlpha = cardinal ? 1 : idx % 2 === 0 ? 0.85 : 0.6;
    c.fillText(names[idx], x, nameY);
  });
  c.globalAlpha = 1;

  if (nameY + 16 * px < H) {                    // azimuth in degrees
    c.font = `${9.5 * px}px sans-serif`;
    c.textBaseline = "top";
    c.globalAlpha = 0.55;
    const dp = degStep >= 1 ? 0 : degStep >= 0.1 ? 1
      : degStep >= 0.01 ? 2 : 3;
    eachAz(degStep, (az, x) => {
      c.fillText(`${az.toFixed(dp)}°`, x, degY);
    });
    c.globalAlpha = 1;
    c.textBaseline = "alphabetic";
  }
}

/* ---------------- FOV frame overlay ----------------
 * Interaction handles are recorded here, in screen space, while the
 * frames are drawn: the centre cross (click = centre the frame on screen
 * and zoom to it) and the four corners (drag = rotate the frame).  See
 * the pointer handlers in bind(). */
function drawFovFrames(c, W, H, pal, px, P) {
  const col = pal.print ? "#000" : pal.nv ? "#e04040" : "#e8b84b";
  const jump = W / 3;
  const handles = [];
  c.font = `${10 * px}px sans-serif`;
  c.textAlign = "left"; c.textBaseline = "bottom";
  for (const fr of state.fovFrames) {
    if (!fr.enabled) continue;
    const sel = fr.id === state.fovSelected;
    const pts = frameOutline(fr).map(([ra, dec]) => P(ra, dec));
    c.save();
    c.strokeStyle = col;
    c.lineWidth = (sel ? 2 : 1.2) * px;
    c.globalAlpha = sel ? 1 : 0.8;
    if (pal.print) c.setLineDash([6 * px, 4 * px]);
    c.beginPath();
    let prev = null, label = null;
    const n = pts.length;
    for (let i = 0; i <= n; i++) {       // <=n closes the outline
      const p = pts[i % n];
      if (!p) { prev = null; continue; }
      if (prev && Math.hypot(p[0] - prev[0], p[1] - prev[1]) < jump)
        c.lineTo(p[0], p[1]);
      else c.moveTo(p[0], p[1]);
      prev = p;
      if (!label || p[1] < label[1]) label = p;   // topmost visible pt
    }
    c.stroke();
    // centre handle: a plain ring (drag = move, click = zoom to frame)
    const ctr = P(fr.ra, fr.dec);
    if (ctr) {
      c.beginPath();
      c.arc(ctr[0], ctr[1], 6 * px, 0, 7);
      c.lineWidth = px;
      c.stroke();
      c.beginPath();
      c.arc(ctr[0], ctr[1], 1.2 * px, 0, 7);
      c.fillStyle = col;
      c.fill();
    }
    // corner handles (drag = rotate); rectangles only — a circle has no
    // orientation to set
    const dims = frameDims(fr);
    let corners = null;
    if (dims.type === "rect" && !pal.print) {
      corners = [0, 8, 16, 24].map((i) => pts[i]).filter(Boolean);
      c.save();
      c.setLineDash([]);
      c.lineWidth = 1.4 * px;
      for (const q of corners) {
        c.beginPath();
        c.arc(q[0], q[1], 4.5 * px, 0, 7);
        c.stroke();
      }
      c.restore();
    }
    if (ctr || corners)
      handles.push({ id: fr.id, cx: ctr ? ctr[0] : null,
                     cy: ctr ? ctr[1] : null, corners: corners || [] });
    if (label) {
      const p = FOV_PRESETS.find((x) => x.id === fr.preset);
      c.fillStyle = col;
      c.fillText(`${p ? fovPresetName(p) : ""} ${frameSizeLabel(fr)}`,
                 label[0] + 3 * px, label[1] - 3 * px);
    }
    c.restore();
  }
  // the print/export pass renders at a different size — never let it
  // overwrite the handles the on-screen pointer logic hit-tests against
  if (!pal.print) state.fovHandles = handles;
}

/* nearest FOV handle to a canvas point, or null */
function fovHandleAt(x, y, px) {
  let best = null;
  for (const h of state.fovHandles || []) {
    if (h.cx != null) {
      const d = Math.hypot(h.cx - x, h.cy - y);
      if (d < 12 * px && (!best || d < best.d))
        best = { d, id: h.id, kind: "center" };
    }
    for (const q of h.corners) {
      const d = Math.hypot(q[0] - x, q[1] - y);
      if (d < 12 * px && (!best || d < best.d))
        best = { d, id: h.id, kind: "corner" };
    }
  }
  return best;
}

/* centre the frame on screen and zoom so it fills most of the canvas */
function zoomToFrame(fr) {
  if (!state.sky) return;
  const d = frameDims(fr);
  const width = d.type === "rect"
    ? Math.max(d.w, d.h * canvas.width / canvas.height) : d.fov;
  state.view.follow = null;
  setFieldWidth(Math.max(MIN_FOV, width * 1.6));
  const [az, alt] = altaz(fr.ra, fr.dec, currentLst(),
                          state.sky.site.lat_deg);
  centerView(az, alt);
  state.fovSelected = fr.id;
  renderFOVList();
  resetTrails();
}

function draw() {
  const W = canvas.clientWidth * devicePixelRatio;
  const H = canvas.clientHeight * devicePixelRatio;
  // setting width/height clears the canvas — only on resize, so that
  // the 光跡残し (trail) mode can accumulate on the previous frame
  if (canvas.width !== W || canvas.height !== H) {
    canvas.width = W; canvas.height = H;
    state._trailPrimed = false;
  }
  const t0 = performance.now();
  const trailing = state.opts.trails && state.playing;
  if (trailing && state._trailPrimed) {
    // long-exposure simulation: fade the previous frame very slightly
    // and plot only the moving lights (no bg/grids/labels — they smear)
    ctx.fillStyle = "rgba(0,0,5,0.02)";
    ctx.fillRect(0, 0, W, H);
    render(ctx, W, H, screenPal(), devicePixelRatio, false,
           { trail: true });
  } else {
    ctx.clearRect(0, 0, W, H);
    render(ctx, W, H, screenPal(), devicePixelRatio, true);
    state._trailPrimed = trailing;   // next frame accumulates
  }
  // dev frame-time probe: set window._perfLog = true in the console
  if (window._perfLog) console.log("frame ms", performance.now() - t0);
}
function resetTrails() { state._trailPrimed = false; }

/* ---------------- デモモードと録画 ---------------------------------
 * A scripted tour of what the chart can actually show, and a recorder
 * that writes the canvas to a video file.
 *
 * Each scene sets up a view and then lets the simulated clock run, so
 * nothing is faked for the camera: the twilight scene really is the
 * twilight model, the planet scene really is the textured disk at its
 * true angular size, the pass scene really is the SGP4 solution.  A
 * scene that has no data to show (no TLEs downloaded, no Milky Way
 * fetched) removes itself rather than showing an empty sky.
 *
 * Recording uses MediaRecorder over canvas.captureStream().  MP4/H.264
 * is requested first and WebM is the fallback; the file is named after
 * the container actually used, because writing .mp4 on a WebM stream
 * would just produce a file nothing can open.
 */
const DEMO_FPS = 30;
const REC_BPS = 12e6;

function ease(f) {                       // smoothstep
  return f <= 0 ? 0 : f >= 1 ? 1 : f * f * (3 - 2 * f);
}
function lerp(a, b, f) { return a + (b - a) * f; }

/* The night a superior planet comes to opposition, from the geometry
 * the sky payload already carries: it culminates at local midnight when
 * its right ascension is opposite the Sun's, and the Sun's RA advances
 * 0.98565 deg/day.  The planet moves too, so this is good to a few days
 * over a year — ample for picking a night on which to show it off.
 *
 * Counted from the payload's own instant, not from the clock: a scene
 * that has just handed the clock back is still holding the sky it was
 * given, and mixing the two would be off by however far it travelled. */
function demoMidnightDate(raDeg) {
  if (!state.sky) return null;
  const sun = state.sky.planets.find((p) => p.key === "sun");
  if (!sun) return null;
  const days = ((((raDeg - sun.ra - 180) % 360) + 360) % 360) / 0.98565;
  const base = new Date(state.sky.time.utc_iso + "Z");
  if (isNaN(base)) return null;
  return new Date(base.getTime() + days * 86400e3);
}

function demoOppositionDate(key) {
  const b = state.sky && state.sky.planets.find((p) => p.key === key);
  return b ? demoMidnightDate(b.ra) : null;
}

/* A close-up of one planet: zoom in from the current field until the
 * disk fills the frame.  ``pick()`` chooses the body at the moment the
 * scene actually starts — minutes of simulated time after the tour was
 * assembled, by which point a planet picked up front may have set — and
 * when nothing is up the scene travels to the night ``travelTo`` comes
 * to opposition, handing the clock back on the way out. */
function demoPlanetScene(spec) {
  return {
    key: spec.key, secs: spec.secs, caption: spec.caption, skip: spec.skip,
    enter() {
      this._wide = fieldWidthDeg();
      this._off = state.simOffsetMs;
      this._f0 = null;
      this._target = null;
      state.playing = true; state.speed = spec.speed || 60;
      const follow = (p) => {
        this._target = p;
        setFollow({ ra: p.ra, dec: p.dec, key: p.key,
                    name: state.lang === "ja" ? p.name_ja : p.name_en },
                  null);
      };
      const up = spec.pick();
      if (up) { follow(up); return; }
      if (!spec.travelTo) return;
      const t = demoOppositionDate(spec.travelTo);
      if (!t) return;
      t.setHours(0, 0, 0, 0);          // it then culminates at midnight
      state.simOffsetMs = t.getTime() - Date.now();
      fetchSky().then(() => {
        const p = state.sky.planets.find((q) => q.key === spec.travelTo);
        if (p) follow(p);
      }).catch(() => {});
    },
    update(f) {
      // hold the wide view until the (possibly re-fetched) sky has the
      // target centred, then run the zoom over whatever time is left
      if (!this._target) return;
      if (this._f0 === null) this._f0 = f;
      const g = this._f0 >= 1 ? 1 : (f - this._f0) / (1 - this._f0);
      setFieldWidth(Math.exp(lerp(Math.log(Math.min(this._wide, 30)),
                                  Math.log(zoomTargetFor(this._target)),
                                  ease(g))));
    },
    exit() {
      if (state.demo && state.demo.takeover) return;   // the user has it
      if (state.simOffsetMs !== this._off) {
        state.simOffsetMs = this._off;           // give the clock back
        fetchSky().catch(() => {});
      }
    },
  };
}

/* the object best placed for a close-up right now */
function demoBestPlanet(exclude) {
  if (!state.sky) return null;
  const lst = currentLst(), lat = state.sky.site.lat_deg;
  let best = null;
  for (const p of state.sky.planets) {
    if (p.key === "sun" || p.key === "moon" || !p.diam) continue;
    if (exclude && exclude.includes(p.key)) continue;
    const alt = altaz(p.ra, p.dec, lst, lat)[1];
    if (alt < 15) continue;
    const score = p.diam * (1 + alt / 90);
    if (!best || score > best.score) best = { pl: p, score };
  }
  return best && best.pl;
}

function demoScenes() {
  const out = [];
  const site = state.sky && state.sky.site;
  if (!site) return out;

  // 1. twilight: the sky filling in as the Sun goes down
  out.push({
    key: "twilight", secs: 12,
    caption: { ja: "薄明 — 空が暗くなるにつれて星が現れる",
               en: "Twilight — stars emerging as the sky darkens" },
    enter() {
      state.opts.skyglow = true;
      setViewMode("horizon");
      state.view.follow = null;
      state.view.azCenter = 270; state.view.altOffset = 6;
      setFieldWidth(110);
      const t = demoSunsetTime();
      state.simOffsetMs = t - Date.now() - 20 * 60e3;
      state.playing = true; state.speed = 600;
      fetchSky().catch(() => {});
    },
  });

  // 2. the Milky Way, and what moonlight does to it
  //
  // The galactic centre in Sagittarius is the brightest piece of sky
  // there is to lose, so it is where the 月光 switch is worth showing:
  // the first half of the scene has the moonlight on and the band
  // washed out, the second half turns it off and the band comes back.
  if (state.sky.milkyway_available)
    out.push({
      key: "milkyway", secs: 14,
      caption: { ja: "天の川と月光 — いて座の銀河中心方向",
                 en: "The Milky Way and moonlight (galactic centre)" },
      enter() {
        this._moon = state.opts.moonglow;
        this._glow = state.opts.skyglow;
        this._art = state.opts.conart;
        this._off = state.simOffsetMs;
        // the figures are painted over the whole sky and turn the
        // background grey, which is the one thing this scene is about
        state.opts.conart = false;
        state.opts.milkyway = true;
        state.opts.skyglow = true;
        state.opts.moonglow = true;
        setViewMode("allsky");
        state.view.zoom = 1;
        setFollow(null);
        state.playing = false;
        syncViewOptionUI();
        // A daylit sky has no Milky Way in it and no moonlight to take
        // away: the scene moves to the night the galactic centre stands
        // due south at midnight, which is also when it is highest.
        // zenith-centred: the whole disc stays on screen and the band
        // runs across it from Cassiopeia to Sagittarius
        const centre = () => {
          state.view.allskyCenter = { az: 180, alt: 90 };
        };
        const night = demoMidnightDate(266.4);   // RA of the centre
        if (night) {
          night.setHours(0, 20, 0, 0);
          state.simOffsetMs = night.getTime() - Date.now();
          fetchSky().then(centre).catch(centre);
        } else {
          centre();
        }
      },
      update(f) {
        const on = f < 0.5;
        if (state.opts.moonglow !== on) {
          state.opts.moonglow = on;
          syncViewOptionUI();
        }
        this.subtitle = state.lang === "ja"
          ? (on ? "月光 ON — 月明かりが淡い光を消してしまう"
                : "月光 OFF — 同じ空から月明かりを取り除いた姿")
          : (on ? "Moonlight on — it drowns the faint band"
                : "Moonlight off — the same sky without it");
      },
      exit() {
        state.opts.moonglow = this._moon;
        state.opts.skyglow = this._glow;
        state.opts.conart = this._art;
        if (!(state.demo && state.demo.takeover) && this._off != null)
          state.simOffsetMs = this._off;
        syncViewOptionUI();
      },
    });

  // 3. a planet, zoomed until it fills the frame
  out.push(demoPlanetScene({
    key: "planet", secs: 12,
    caption: { ja: "惑星 — 実際の視直径と表面模様",
               en: "A planet at its true angular size" },
    pick: () => demoBestPlanet(["saturn"]),   // Saturn has its own scene
    travelTo: "jupiter",
  }));

  // 4. Saturn — the rings earn it a scene of its own, and one worth
  // travelling for: if it is not up tonight the tour visits the night
  // of its opposition and gives the clock back afterwards.
  out.push(demoPlanetScene({
    key: "saturn", secs: 13,
    caption: { ja: "土星 — 環の傾きと衛星",
               en: "Saturn: the tilt of the rings, and its moons" },
    pick() {
      const p = state.sky.planets.find((q) => q.key === "saturn");
      return p && altaz(p.ra, p.dec, currentLst(),
                        state.sky.site.lat_deg)[1] >= 25 ? p : null;
    },
    travelTo: "saturn",
    skip: () => !state.sky.planets.find((p) => p.key === "saturn"),
  }));

  // 5. what a smart telescope would actually capture.  M42 is the
  // subject: it is the object people buy these telescopes for, it is
  // comfortably inside one frame, and there is a photograph of it to
  // lay on the sky at the same scale so the comparison is visible
  // rather than asserted.
  out.push({
    key: "fov", secs: 15, noWrap: true, subtitleY: 58,
    caption: { ja: "写野角 — Seestar S30 Pro で M42 はこう写る",
               en: "Field of view: M42 through a Seestar S30 Pro" },
    enter() {
      // the tour borrows the frame list and gives it back untouched:
      // these frames are the user's saved compositions
      this._frames = JSON.parse(JSON.stringify(state.fovFrames));
      this._sel = state.fovSelected;
      this._off = state.simOffsetMs;
      this._wide = fieldWidthDeg();
      const tgt = (state.sky.dso || []).find((d) => d.id === "M42");
      if (!tgt) return;
      const fr = { id: "demo-fov", enabled: true, preset: "seestar_s30pro",
                   rotation: 0, ra: tgt.ra, dec: tgt.dec };
      const d = frameDims(fr);
      this._dims = d;
      state.opts.dso = true;
      state.opts.maglimit = Math.max(state.opts.maglimit, 9);
      syncViewOptionUI();
      openTab("view");
      this._box = $("#fov-box").open;
      $("#fov-box").open = true;
      state.fovFrames = [...state.fovFrames, fr];
      state.fovSelected = fr.id;
      renderFOVList();
      const size = (tgt.size_arcmin || 60) / 60;
      const name = state.lang === "ja" ? (tgt.name_ja || tgt.name_en)
                                       : tgt.name_en;
      // Two short lines: the point of this scene is the picture, and a
      // paragraph of subtitles covered the very frame it describes.
      // The photograph is credited because the licence asks for it.
      const credit = (state.dsoPhotos || {}).M42;
      const who = credit ? credit.author.split(",")[0] : "NASA/ESA";
      this.subtitle = state.lang === "ja"
        ? `Seestar S30 Pro の写野 ${angleLabel(d.w)}×${angleLabel(d.h)}` +
          `　${name} は約 ${angleLabel(size)}\n写真: ${who}`
        : `Seestar S30 Pro: ${angleLabel(d.w)}×${angleLabel(d.h)} frame` +
          `　${name} spans ${angleLabel(size)}\nPhoto: ${who}`;
      const show = (o) => {
        setFollow({ ra: o.ra, dec: o.dec, key: o.id, name },
                  null);
        const f2 = state.fovFrames.find((x) => x.id === "demo-fov");
        if (f2) { f2.ra = o.ra; f2.dec = o.dec; }
        state.photoOverlay = { id: "M42", ra: o.ra, dec: o.dec,
                               width_deg: size, alpha: 0.92,
                               img: skyPhotoImage("M42") };
        this._ok = true;
      };
      const alt = altaz(tgt.ra, tgt.dec, currentLst(),
                        state.sky.site.lat_deg)[1];
      if (alt >= 25) { show(tgt); }
      else {
        // Orion is a winter object: go to the night it culminates at
        // local midnight and hand the clock back afterwards
        const t = demoMidnightDate(tgt.ra);
        if (!t) return;
        t.setHours(0, 0, 0, 0);
        state.simOffsetMs = t.getTime() - Date.now();
        fetchSky().then(() => {
          const t2 = (state.sky.dso || []).find((x) => x.id === "M42");
          if (t2) show(t2);
        }).catch(() => {});
      }
      state.playing = true; state.speed = 30;
    },
    update(f) {
      if (!this._ok) return;
      const d = this._dims;
      // settle early and then hold: the faint-star layer only loads for
      // a view that has stopped moving, and an empty frame is no answer
      // to "what would this telescope capture?"
      const goal = 2.2 * Math.max(d.w, d.h);
      setFieldWidth(Math.exp(lerp(Math.log(Math.min(this._wide, 40)),
                                  Math.log(goal),
                                  ease(Math.min(1, f / 0.5)))));
    },
    exit() {
      state.fovFrames = this._frames;
      state.fovSelected = this._sel;
      state.photoOverlay = null;
      if (this._box !== undefined) $("#fov-box").open = this._box;
      renderFOVList();
      if (!(state.demo && state.demo.takeover) &&
          state.simOffsetMs !== this._off) {
        state.simOffsetMs = this._off;           // give the clock back
        fetchSky().catch(() => {});
      }
    },
    skip() { return !(state.sky.dso || []).some((d) => d.id === "M42"); },
  });

  // 6. the Moon
  out.push({
    key: "moon", secs: 10,
    caption: { ja: "月 — 秤動と欠け際", en: "The Moon: libration and terminator" },
    enter() {
      const m = state.sky.planets.find((p) => p.key === "moon");
      this._wide = fieldWidthDeg();
      state.playing = true; state.speed = 300;
      if (m) setFollow({ ra: m.ra, dec: m.dec, key: "moon",
                         name: state.lang === "ja" ? m.name_ja
                                                   : m.name_en }, null);
    },
    update(f) {
      setFieldWidth(Math.exp(lerp(Math.log(Math.min(this._wide, 20)),
                                  Math.log(1.2), ease(f))));
    },
    skip() {
      const m = state.sky.planets.find((p) => p.key === "moon");
      if (!m) return true;
      return altaz(m.ra, m.dec, currentLst(),
                   state.sky.site.lat_deg)[1] < 5;
    },
  });

  // 5. the next meteor shower
  const sh = demoNextShower();
  if (sh)
    out.push({
      key: "meteors", secs: 12,
      caption: { ja: `流星群 — ${sh.name}`,
                 en: `Meteor shower: ${sh.name}` },
      enter() {
        setFollow(null);
        setViewMode("allsky");
        state.view.zoom = 1;
        state.view.allskyCenter = { az: 180, alt: 90 };
        state.simOffsetMs =
          new Date(sh.peak_utc ? showerViewTime(sh) : sh.time_utc) -
          Date.now();
        setMeteorShower(sh);
        state.playing = true; state.speed = 600;
        fetchSky().catch(() => {});
      },
      // the arithmetic behind the number in the badge, recomputed as
      // the clock runs and the radiant climbs
      update() {
        if (!state.sky) return;
        const [, alt] = altaz(sh.ra, sh.dec, currentLst(),
                              state.sky.site.lat_deg);
        const zhr = shrunkZHR(sh, simNow());
        const rate = showerRate(sh);
        const n = (v) => v.toFixed(v < 10 ? 1 : 0);
        this.subtitle = state.lang === "ja"
          ? `予想出現数 = ZHR ${n(zhr)}（極大 ${sh.zhr}・${
              t("ui.shower_peak")}からの経過で減衰）× sin(輻射点高度 ${
              alt.toFixed(0)}°) = ${n(rate)} 個/時`
          : `Rate = ZHR ${n(zhr)} (peak ${sh.zhr}, faded with time from ` +
            `maximum) × sin(radiant ${alt.toFixed(0)}°) = ${n(rate)} /h`;
      },
      exit() { setMeteorShower(null); },
    });

  // 6. a pass of the space station
  if (state.demoPass)
    out.push({
      key: "pass", secs: 10,
      caption: state.demoPass.kind === "iss"
        ? { ja: "国際宇宙ステーション (ISS) の通過",
            en: "A pass of the International Space Station" }
        : { ja: `人工衛星 — ${state.demoPass.name} の通過`,
            en: `Satellite pass: ${state.demoPass.name}` },
      enter() {
        const ev = state.demoPass;
        if (ev.kind === "iss")
          this.subtitle = state.lang === "ja"
            ? `最大高度 ${Math.round(ev.max_alt)}°・` +
              `${Math.round((ev.duration_s || 0) / 60)} 分・` +
              `${ev.mag != null ? `${ev.mag.toFixed(1)} 等` : ""}` +
              `　高度 400 km を秒速 7.7 km で飛ぶ`
            : `${Math.round(ev.max_alt)}° at its highest, ` +
              `${Math.round((ev.duration_s || 0) / 60)} min` +
              `${ev.mag != null ? `, magnitude ${ev.mag.toFixed(1)}` : ""}` +
              ` — 400 km up, 7.7 km a second`;
        setFollow(null);
        setViewMode("horizon");
        state.view.azCenter = ev.max_az; state.view.altOffset = 0;
        setFieldWidth(110);
        state.simOffsetMs = new Date(ev.rise_utc) - Date.now() - 20e3;
        setSatPass(ev);
        state.playing = true; state.speed = 20;
        fetchSky().catch(() => {});
      },
      exit() { setSatPass(null); },
    });

  // 7. a Starlink launch still strung out in a line
  if (state.demoTrain)
    out.push({
      key: "starlink", secs: 12,
      caption: {
        ja: `打ち上げ直後のスターリンク — ${state.demoTrain.name}` +
            `（${state.demoTrain.members} 機が数珠繋ぎ）`,
        en: `A fresh Starlink train: ${state.demoTrain.name}` +
            ` (${state.demoTrain.members} satellites in a line)` },
      enter() {
        const ev = state.demoTrain;
        setFollow(null);
        setViewMode("horizon");
        setFieldWidth(100);
        centerView(ev.max_az, Math.max(20, ev.max_alt * 0.6));
        state.simOffsetMs = new Date(ev.rise_utc) - Date.now() - 20e3;
        setSatPass(ev);
        // the whole train, and nothing but the train: the line is the
        // point, and every other Starlink in the sky would hide it
        state.sat.on = true;
        state.sat.groups = ["starlink"];
        state.sat.desig = ev.desig || null;
        state.sat.maxmag = Math.max(state.sat.maxmag, 7.5);
        state.sat.t0 = 0;
        state.playing = true; state.speed = 15;
        fetchSky().catch(() => {});
      },
      // the layer goes back off: without the launch filter the next
      // refresh would carpet the closing scene with every Starlink
      exit() {
        setSatPass(null);
        state.sat.desig = null;
        state.sat.on = false;
        state.sat.t0 = 0;
      },
    });

  // 8. the event list, and a jump to the next one
  const nev = demoNextEvent();
  if (nev)
    out.push({
      key: "events", secs: 12, noWrap: true, subtitleY: 58,
      caption: { ja: `天体イベント — ${nev.label}`,
                 en: `Events: ${nev.label}` },
      enter() {
        const n = (state.events || []).length;
        this.subtitle = state.lang === "ja"
          ? `合・衝・留、日食・月食、月の朔望と近地点、流星群の極大、` +
            `惑星の最大離角、二十四節気 — 任意の期間を計算します\n` +
            `いま一覧に ${n} 件。行をタップすればその瞬間の星図へ飛びます`
          : `Conjunctions, oppositions and stations, eclipses, lunar ` +
            `phases and perigees, shower maxima, greatest elongations, ` +
            `the 24 solar terms\n${n} in the list now — tap a row and ` +
            `the chart goes to that instant`;
        setFollow(null);
        setSatPass(null);
        setViewMode("allsky");
        openTab("events");
        jumpToTime(nev.time_utc);
        // show which row the clock jumped to
        const li = Array.from($("#events-list").children)
          .find((x) => x.textContent.includes(nev.label));
        if (li) {
          li.classList.add("ev-demo");
          li.scrollIntoView({ block: "center" });
          this._li = li;
        }
        state.playing = true; state.speed = 300;
      },
      exit() { if (this._li) this._li.classList.remove("ev-demo"); },
    });

  // 8b. the app in the other language
  out.push({
    key: "language", secs: 10, noWrap: true, subtitleY: 58,
    caption: { ja: "日本語と英語 — 表示もデータも切り替わります",
               en: "Japanese and English — interface and data alike" },
    enter() {
      this._lang = state.lang;
      setViewMode("allsky");
      setFollow(null);
      state.playing = false;
      openTab("info");
      this.subtitle = state.lang === "ja"
        ? "星座名・恒星名・天体の解説・イベント名・流星群名・観測地まで" +
          "英語に切り替わります\nEN ボタンひとつ、再起動も設定画面も不要"
        : "星座名・恒星名・天体の解説・イベント名・流星群名・観測地まで" +
          "日本語に切り替わります\n日本語ボタンひとつで戻せます";
      setLanguage(this._lang === "ja" ? "en" : "ja").catch(() => {});
    },
    exit() {
      if (this._lang && this._lang !== state.lang)
        setLanguage(this._lang).catch(() => {});
    },
  });

  // 9. the narration
  out.push({
    key: "voice", secs: 16,
    caption: { ja: "音声解説 — 今夜のハイライト",
               en: "Narration: tonight's highlights" },
    enter() {
      openTab("voice");
      state.playing = true; state.speed = 60;
      this.subtitle = state.tonightVoice || "";
      speak(state.tonightVoice || "", { interrupt: true });
    },
    exit() {
      if ("speechSynthesis" in window) speechSynthesis.cancel();
    },
    skip() { return !state.tonightVoice; },
  });

  // 10. the whole sky turning
  out.push({
    key: "diurnal", secs: 10,
    caption: { ja: "日周運動 — 全天", en: "The turning sky" },
    enter() {
      setFollow(null);
      openTab("view");
      setViewMode("allsky");
      state.view.zoom = 1;
      state.view.allskyCenter = { az: 180, alt: 90 };
      state.playing = true; state.speed = 3000;
    },
  });
  return out;
}

/* sunset of the current simulated day, from the tonight summary the
 * server already computed (falls back to 18:00 local) */
function demoSunsetTime() {
  const d = simNow();
  d.setHours(18, 0, 0, 0);
  return d.getTime();
}

function galacticCentreAzAlt() {
  if (!state.sky || !state.sky.matrices) return null;
  const M = state.sky.matrices.gal2eq;
  const v = [1, 0, 0];                   // l = 0, b = 0
  const x = M[0][0] * v[0], y = M[1][0] * v[0], z = M[2][0] * v[0];
  const ra = ((Math.atan2(y, x) / D2R) + 360) % 360;
  const dec = Math.asin(Math.max(-1, Math.min(1, z))) / D2R;
  return altaz(ra, dec, currentLst(), state.sky.site.lat_deg);
}

/* the next event worth stopping the tour for: an eclipse if the window
 * holds one, otherwise whatever comes next */
/* The next event the tour can show.
 *
 * Eclipses are left out: the tour used to open on one, and a total
 * solar eclipse years away and half a world from the observer is not
 * what the app is for.  The events tab still lists them. */
function demoNextEvent() {
  const now = Date.now();
  return (state.events || [])
    .filter((e) => new Date(e.time_utc).getTime() > now &&
                   !ECLIPSE_KINDS.has(e.kind))[0] || null;
}

/* The tour shows the Perseids.
 *
 * They are the shower the audience is likeliest to have heard of, they
 * run in the northern summer when people are outside, and at ZHR 100
 * they are the one that actually fills the sky in the animation.  If
 * the calendar has not been loaded, whatever shower the events feed
 * offers next is used instead. */
/* The station pass the tour shows.
 *
 * The pass list is built at startup from whatever element sets happen
 * to be cached, so on a fresh install there is none — and the ISS, the
 * one artificial object everybody has seen, was simply missing from the
 * tour.  This fetches the station elements if they are not there and
 * asks again, without switching the satellite layer on: the scene draws
 * the pass itself. */
async function ensureDemoPass() {
  if (state.demoPass && state.demoPass.kind === "iss") return;
  try {
    await downloadTLEGroup("stations");
  } catch (_) { /* offline: fall back to whatever is cached */ }
  const d = await api("satellite_events",
                      { site: state.site, days: 7, minalt: 25 });
  const evs = d.events || [];
  state.demoPass = evs.find((e) => e.kind === "iss") || evs[0] ||
                   state.demoPass;
  if (!state.demoTrain)
    state.demoTrain = evs.filter((e) => e.kind === "starlink_train")
      .sort((a, b) => (a.mag == null ? 99 : a.mag) -
                      (b.mag == null ? 99 : b.mag))[0] || null;
}

/* Switch the whole app between Japanese and English.
 *
 * Everything that carries language has to be told: the strings, the
 * site names, the event list, the shower calendar, and the cards
 * already on screen.  The tour uses this too, to show that the English
 * build is not a translated menu bar with Japanese data behind it. */
async function setLanguage(lang) {
  state.lang = lang;
  localStorage.setItem("lang", lang);
  await loadI18n(); await loadSites();
  await Promise.all([refreshInfo(), refreshEvents(), fetchSky()]);
  if (state._sbLoaded) { renderSBList(); showSBFetched(); }
  renderSBSelected();
  renderFOVList();               // preset names are language-bound
  state.showers = null;          // names and dates are language-bound
  loadShowers().catch(() => {});
  renderShowerBadge();           // the strip over the chart, renamed
  renderSatUI();                 // satellite group names + fetch dates
  renderSelected();              // selected-object card
  if ($("#credits-box").open) renderCredits().catch(() => {});
}

function demoNextShower() {
  const list = (state.showers && state.showers.list) || [];
  const per = list.find((x) => x.code === "PER");
  if (per) return per;
  const now = Date.now();
  for (const ev of state.events || []) {
    if (ev.shower && new Date(ev.time_utc).getTime() > now - 86400e3)
      return Object.assign({}, ev.shower,
                           { peak_utc: ev.shower.peak_utc || ev.time_utc });
  }
  return null;
}

function startDemo() {
  if (!state.sky) return;
  state.demo = { scenes: demoScenes().filter((s) => !(s.skip && s.skip())),
                 i: -1, t0: 0, saved: {
                   opts: Object.assign({}, state.opts),
                   view: JSON.parse(JSON.stringify(state.view)),
                   off: state.simOffsetMs, playing: state.playing,
                   speed: state.speed,
                   tab: (document.querySelector(".tab.active") || {})
                     .dataset?.tab || "view",
                   sat: { on: state.sat.on, groups: [...state.sat.groups],
                          maxmag: state.sat.maxmag,
                          desig: state.sat.desig || null } } };
  demoAdvance(performance.now());
  updateDemoUI();
}

function stopDemo(restore = true) {
  const d = state.demo;
  if (!d) return;
  d.takeover = !restore;        // read by scene exits: leave the sky alone
  const sc = d.scenes[d.i];
  if (sc && sc.exit) sc.exit();
  if (restore && d.saved) {
    Object.assign(state.opts, d.saved.opts);
    state.view = d.saved.view;
    state.simOffsetMs = d.saved.off;
    state.playing = d.saved.playing;
    state.speed = d.saved.speed;
    if (d.saved.tab) openTab(d.saved.tab);
    if ("speechSynthesis" in window) speechSynthesis.cancel();
    if (d.saved.sat) {
      Object.assign(state.sat, d.saved.sat);
      state.sat.t0 = 0;
      const cb = $("#opt-satellites");
      if (cb) cb.checked = state.sat.on;
      renderSatUI();               // the group ticks are the tour's doing
    }
    setMeteorShower(null);
    setSatPass(null);
    setFollow(null);
    fetchSky().catch(() => {});
  }
  state.demo = null;
  syncViewOptionUI();
  updateDemoUI();
  if (state.rec && state.rec.stopWithDemo) stopRecording();
}

function demoAdvance(nowMs) {
  const d = state.demo;
  const prev = d.scenes[d.i];
  const off = state.simOffsetMs;
  if (prev && prev.exit) prev.exit();
  d.i += 1;
  if (d.i >= d.scenes.length) { stopDemo(true); return; }
  const sc = d.scenes[d.i];
  const start = () => {
    if (!state.demo || state.demo !== d) return;   // stopped meanwhile
    d.entering = false;
    d.t0 = performance.now();      // the scene gets its full duration
    try { sc.enter(); } catch (_) { /* a scene must never break the tour */ }
    updateDemoUI();
  };
  // A scene that travelled in time hands the clock back on the way out,
  // but the sky payload it was given is still months old.  Entering the
  // next scene against that would aim it at where its subject used to
  // be — which left the Moon scene pointing at empty sky.
  d.t0 = nowMs;
  if (state.simOffsetMs !== off) {
    d.entering = true;
    fetchSky().then(start, start);
  } else start();
}

function demoTick(nowMs) {
  const d = state.demo;
  if (!d || d.entering) return;    // waiting for the sky of the new scene
  const sc = d.scenes[d.i];
  if (!sc) return;
  const f = (nowMs - d.t0) / (sc.secs * 1000);
  if (sc.update) { try { sc.update(f); } catch (_) { /* keep going */ } }
  if (f >= 1) demoAdvance(nowMs);
}

/* caption drawn INTO the canvas so it is part of a recording */
/* wrap `txt` to `maxw` px: at spaces where there are any, otherwise
 * character by character, which is how Japanese lines break */
function wrapToWidth(c, txt, maxw) {
  const out = [];
  for (const para of String(txt).split(/\n+/)) {
    const words = para.includes(" ") ? para.split(/\s+/) : [...para];
    const glue = para.includes(" ") ? " " : "";
    let line = "";
    for (const w of words) {
      const next = line ? line + glue + w : w;
      if (line && c.measureText(next).width > maxw) { out.push(line); line = w; }
      else line = next;
    }
    if (line) out.push(line);
  }
  return out;
}

function drawDemoCaption(c, W, H, pal, px) {
  const d = state.demo;
  if (!d) return;
  const sc = d.scenes[d.i];
  if (!sc) return;
  const txt = state.lang === "ja" ? sc.caption.ja : sc.caption.en;
  c.save();
  c.font = `${15 * px}px sans-serif`;
  c.textAlign = "center"; c.textBaseline = "bottom";
  const w = c.measureText(txt).width;
  c.fillStyle = "rgba(8,10,22,0.62)";
  c.fillRect(W / 2 - w / 2 - 14 * px, H - 46 * px,
             w + 28 * px, 30 * px);
  c.fillStyle = pal.nv ? "#e04040" : "#e8eefc";
  c.fillText(txt, W / 2, H - 24 * px);
  // the narration, as subtitles: a recording captures the canvas, and
  // the speech synthesiser's audio is not part of it
  if (sc.subtitle) {
    // `noWrap` scenes write their own lines and want them left whole —
    // a two-line note about a camera frame reads badly broken across
    // four.  The type shrinks until the longest line fits instead.
    let size = 13;
    c.textAlign = "left"; c.textBaseline = "top";
    const maxw = sc.noWrap ? Math.min(W * 0.86, 900 * px)
                           : Math.min(W * 0.5, 620 * px);
    let lines;
    if (sc.noWrap) {
      lines = sc.subtitle.split("\n");
      for (; size > 8.5; size -= 0.5) {
        c.font = `${size * px}px sans-serif`;
        if (Math.max(...lines.map((l) => c.measureText(l).width)) <= maxw)
          break;
      }
    } else {
      c.font = `${size * px}px sans-serif`;
      lines = wrapToWidth(c, sc.subtitle, maxw).slice(0, 9);
    }
    const lh = (size + 7) * px, x = 20 * px;
    const y = (sc.subtitleY != null ? sc.subtitleY : 92) * px;
    const bw = Math.max(...lines.map((l) => c.measureText(l).width));
    c.fillStyle = "rgba(8,10,22,0.62)";
    c.fillRect(x - 10 * px, y - 9 * px,
               (sc.noWrap ? bw : maxw) + 20 * px, lines.length * lh + 18 * px);
    c.fillStyle = pal.nv ? "#e04040" : "#e8eefc";
    lines.forEach((ln, i) => c.fillText(ln, x, y + i * lh));
  }
  // progress bar for the whole tour
  const done = (d.i + Math.min(1, (performance.now() - d.t0) /
    (sc.secs * 1000))) / d.scenes.length;
  c.fillStyle = "rgba(110,168,255,0.5)";
  c.fillRect(0, H - 3 * px, W * done, 3 * px);
  c.restore();
}

function updateDemoUI() {
  const b = $("#demo-btn");
  if (b) b.textContent = state.demo ? t("ui.demo_stop") : t("ui.demo");
  const r = $("#rec-btn");
  if (r) {
    r.textContent = state.rec ? t("ui.rec_stop") : t("ui.rec");
    r.classList.toggle("recording", !!state.rec);
  }
}

/* ---------------- 録画 (canvas -> video file) ---------------------- */
function pickRecorderType() {
  const want = ["video/mp4;codecs=avc1.640028",
                "video/mp4;codecs=avc1.42E01E", "video/mp4",
                "video/webm;codecs=vp9", "video/webm;codecs=vp8",
                "video/webm"];
  for (const m of want)
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(m))
      return m;
  return null;
}

function startRecording(stopWithDemo) {
  if (state.rec) return;
  const mime = pickRecorderType();
  if (!mime || !canvas.captureStream) { toast(t("ui.rec_unsupported")); return; }
  let rec;
  try {
    const stream = canvas.captureStream(DEMO_FPS);
    rec = new MediaRecorder(stream, { mimeType: mime,
                                      videoBitsPerSecond: REC_BPS });
  } catch (_) { toast(t("ui.rec_unsupported")); return; }
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  rec.onstop = () => {
    const ext = mime.startsWith("video/mp4") ? "mp4" : "webm";
    downloadBlob(new Blob(chunks, { type: mime }), exportName(ext));
    state.rec = null;
    updateDemoUI();
    toast(`${t("ui.rec_saved")} (${ext.toUpperCase()})`);
  };
  state.rec = { rec, mime, stopWithDemo: !!stopWithDemo,
                started: performance.now() };
  rec.start(1000);
  updateDemoUI();
  toast(t("ui.rec_started") +
        (mime.startsWith("video/mp4") ? " MP4" : " WebM"));
}

function stopRecording() {
  if (!state.rec) return;
  try { state.rec.rec.stop(); } catch (_) { state.rec = null; }
  updateDemoUI();
}

/* ---------------- PNG / PDF export (white print mode) ------------- */
function exportName(ext) {
  const d = simNow();
  const p = (n) => String(n).padStart(2, "0");
  return `astrarium_${state.view.mode}_${d.getFullYear()}` +
    `${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}` +
    `${p(d.getMinutes())}.${ext}`;
}
async function downloadBlob(blob, name) {
  // iOS ignores the download attribute: following the link replaces the
  // planetarium with the image and leaves no way back, which is what
  // "the export never comes back" was.  Where the platform has a share
  // sheet, hand the file to it instead; a desktop browser still gets an
  // ordinary download.
  // only where the download attribute is actually broken — a desktop
  // browser should still just save the file, not raise a share sheet
  const touch = navigator.maxTouchPoints > 0;
  try {
    const file = new File([blob], name, { type: blob.type });
    if (touch && navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: name });
      return;
    }
  } catch (e) {
    if (e && e.name === "AbortError") return;      // the user cancelled
    /* anything else: fall through to the link */
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.rel = "noopener";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
function exportCanvas() {
  const allsky = state.view.mode === "allsky";
  const W = allsky ? 2000 : 2400, H = allsky ? 2000 : 1400;
  const off = document.createElement("canvas");
  off.width = W; off.height = H;
  const c = off.getContext("2d");
  // Moonlight and twilight are conditions of the moment, not of the
  // chart: a printout is used at the telescope hours later, and a sky
  // washed out by a Moon that has since set would simply be missing
  // stars.  The glow is switched off for the export and put back.
  const glow = state.opts.skyglow;
  state.opts.skyglow = false;
  state._mwOutline = true;              // the band as contours, not a wash
  try {
    render(c, W, H, screenPal(), W / 1000, false);
  } finally {
    state.opts.skyglow = glow;
    state._mwOutline = false;
  }
  // black and white swapped: what gets saved is the view the observer
  // set up, on paper that does not need a litre of ink.  Rendering with
  // the print palette instead would quietly export a different chart
  // from the one on screen.
  const img = c.getImageData(0, 0, W, H);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 8) {
      // Outside the sky disc the canvas is transparent, which a PNG
      // shows as whatever is behind it and a PDF as black.  On paper
      // the margin should be paper.
      d[i] = d[i + 1] = d[i + 2] = d[i + 3] = 255;
      continue;
    }
    d[i] = 255 - d[i];
    d[i + 1] = 255 - d[i + 1];
    d[i + 2] = 255 - d[i + 2];
  }
  c.putImageData(img, 0, 0);
  // The credit goes on after the inversion, so it is drawn in the
  // colour it will actually have on the paper — dark grey on white.
  const cred = `Astrarium \u00a9 Avellsky`;
  const when = state.sky ? state.sky.time.local_iso : "";
  c.save();
  c.font = `${13 * (W / 1000)}px sans-serif`;
  c.textAlign = "right"; c.textBaseline = "bottom";
  c.fillStyle = "rgba(30,34,44,0.75)";
  if (when) c.fillText(when, W - 14 * (W / 1000), H - 30 * (W / 1000));
  c.font = `${15 * (W / 1000)}px sans-serif`;
  c.fillStyle = "rgba(20,24,34,0.9)";
  c.fillText(cred, W - 14 * (W / 1000), H - 12 * (W / 1000));
  c.restore();
  return off;
}
function exportPNG() {
  exportCanvas().toBlob(
    (b) => downloadBlob(b, exportName("png")), "image/png");
}
/* Minimal single-page PDF: one DCTDecode (JPEG) image XObject scaled to
 * the page.  Page size in points = px * 72/96.  Offsets in the xref are
 * exact byte positions, verified against macOS Quick Look. */
function buildPdf(jpegBytes, wPx, hPx) {
  const wPt = +(wPx * 72 / 96).toFixed(2), hPt = +(hPx * 72 / 96).toFixed(2);
  const enc = new TextEncoder();
  const parts = [];
  let pos = 0;
  const push = (d) => {
    const u8 = typeof d === "string" ? enc.encode(d) : d;
    parts.push(u8); pos += u8.length;
  };
  const offsets = [];
  const obj = (n, body) => {
    offsets[n] = pos;
    push(`${n} 0 obj\n${body}\nendobj\n`);
  };
  push("%PDF-1.4\n");
  obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
  obj(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
  obj(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${wPt} ${hPt}] ` +
         "/Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>");
  offsets[4] = pos;
  push(`4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${wPx} ` +
       `/Height ${hPx} /ColorSpace /DeviceRGB /BitsPerComponent 8 ` +
       `/Filter /DCTDecode /Length ${jpegBytes.length} >>\nstream\n`);
  push(jpegBytes);
  push("\nendstream\nendobj\n");
  const content = `q ${wPt} 0 0 ${hPt} 0 0 cm /Im0 Do Q`;
  obj(5, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  const xrefPos = pos;
  let xr = "xref\n0 6\n0000000000 65535 f \n";
  for (let n = 1; n <= 5; n++)
    xr += String(offsets[n]).padStart(10, "0") + " 00000 n \n";
  push(xr + "trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n" +
       `${xrefPos}\n%%EOF\n`);
  const out = new Uint8Array(pos);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
function exportPDF() {
  const off = exportCanvas();
  const b64 = off.toDataURL("image/jpeg", 0.92).split(",")[1];
  const bin = atob(b64);
  const jpeg = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) jpeg[i] = bin.charCodeAt(i);
  downloadBlob(new Blob([buildPdf(jpeg, off.width, off.height)],
                        { type: "application/pdf" }),
               exportName("pdf"));
}

/* ---------------- deep star fetch (frame-driven debounce) ---------- */
/* Refetch 600 ms after the view/time/mag key settles; skipped while
 * playing faster than x60 to avoid request storms. */
/* Limiting magnitude of the Tycho-2 layer.  The slider is a naked-eye
 * control (1-6.5); at a telescopic field that catalogue is essentially
 * empty, so the deep layer is switched on by the ZOOM itself — without
 * it "zoom in a lot" would show a blank sky. */
/* The deep layer is served as a cone around the centre of the view, so
 * it only makes sense while the view is narrow enough for one cone to
 * cover it.  Past this the request would be most of the sky, the server
 * would truncate it, and what came back would be drawn as a lopsided
 * mass of stars over an otherwise empty chart. */
const DEEP_MAX_FIELD_DEG = 12;

function deepMagLimit() {
  const w = fieldWidthDeg();
  if (w > DEEP_MAX_FIELD_DEG) return 0;   // wide field: naked eye only
  if (state.opts.maglimit > 6.5) return state.opts.maglimit;
  if (w <= 1) return 12;
  if (w <= 3) return 11;
  if (w <= 8) return 10;
  return 0;
}

/* angle between two horizontal directions [deg] */
function angSepAzAlt(az1, alt1, az2, alt2) {
  const a1 = alt1 * D2R, a2 = alt2 * D2R, dz = (az1 - az2) * D2R;
  const c = Math.sin(a1) * Math.sin(a2) +
    Math.cos(a1) * Math.cos(a2) * Math.cos(dz);
  return Math.acos(Math.max(-1, Math.min(1, c))) / D2R;
}

/* az/alt at the centre of the canvas (both view modes) */
function viewCenterAzAlt() {
  const v = state.view;
  if (v.mode === "allsky")
    return [v.allskyCenter.az, v.allskyCenter.alt];
  const W = canvas.width, H = canvas.height;
  return [v.azCenter, v.altOffset + (H * 0.92 - H / 2) / (W / v.fov)];
}

let _deepPending = { key: null, since: 0 };
function deepTick(nowMs) {
  const v = state.view;
  const lim = deepMagLimit();
  const [caz, calt] = viewCenterAzAlt();
  const width = fieldWidthDeg();
  // Drop a payload the view has outgrown or walked away from.  It is a
  // cone of radius 0.72x the field it was fetched for; once the corner
  // of the current view reaches outside that cone the stars stop being
  // a star field and become a clump sitting in an empty sky — which is
  // exactly what a zoom-out or a jump to another object produces.
  if (state.deepStars) {
    const k = state._deepCone;
    if (lim <= 6.5 || !k ||
        angSepAzAlt(k.az, k.alt, caz, calt) + 0.6 * width > 0.72 * k.fov) {
      state.deepStars = null;
      state._deepCone = null;
      state._deepKey = null;
    }
  }
  if (!state.sky || !state.sky.deep_available || lim <= 6.5 ||
      (state.playing && Math.abs(state.speed) > 60))
    return;                       // keep last payload; positions rotate
  // quantise the view centre to a quarter of the field: the query cone
  // is 1.44x the field, so drifting less than that needs no refetch —
  // without this, tracking an object would invalidate the key every frame
  const q = Math.max(width / 4, 1e-4);
  const key = [state.site, Math.floor(simNow().getTime() / 3e5),
               Math.round(caz / q), Math.round(calt / q),
               width.toFixed(4), lim].join("|");
  if (key === state._deepKey || state._deepFetching) return;
  if (_deepPending.key !== key) {
    _deepPending = { key, since: nowMs };
    return;
  }
  if (nowMs - _deepPending.since < 600) return;
  state._deepFetching = true;
  api("deepstars", {
    site: state.site, time: new Date(simNow()).toISOString(),
    az: caz, alt: Math.min(89, Math.max(-5, calt)),
    fov: Math.max(width, 0.2), mag: lim,
  }).then((d) => {
    state._deepKey = key;
    state.deepStars = d.available ? d.stars : null;
    state._deepCone = d.available
      ? { az: caz, alt: Math.min(89, Math.max(-5, calt)),
          fov: Math.max(width, 0.2) } : null;
  }).catch(() => {}).finally(() => { state._deepFetching = false; });
}

function updateHints() {
  const el = $("#deep-hint");
  if (!el) return;
  let msg = "";
  if (deepMagLimit() > 6.5 && state.sky && !state.sky.deep_available)
    msg = t("ui.deep_hint");
  el.textContent = msg;
}

/* ---------------- clock & animation loop ---------------- */
function fmtHms(d, tz) {
  return d.toLocaleString(state.lang === "ja" ? "ja-JP" : "en-US",
    { hour12: false });
}

/* transient local-time overlay (drag scrub + arrow-key scrub) */
let _overlayTimer = null;
function showScrubOverlay(hideAfterMs) {
  const ov = $("#scrub-overlay");
  ov.textContent = fmtHms(simNow());
  ov.classList.add("show");
  clearTimeout(_overlayTimer);
  if (hideAfterMs)
    _overlayTimer = setTimeout(() => ov.classList.remove("show"),
                               hideAfterMs);
}
function hideScrubOverlay(afterMs) {
  clearTimeout(_overlayTimer);
  _overlayTimer = setTimeout(
    () => $("#scrub-overlay").classList.remove("show"), afterMs);
}

/* trailing-debounced sky refetch: LST/redraw feedback is immediate via
 * tick(); the server solution follows 300 ms after the last key press */
let _fetchDebounce = null;
function scheduleFetchSky() {
  state._fetchPending = true;
  clearTimeout(_fetchDebounce);
  _fetchDebounce = setTimeout(() => {
    // keep _fetchPending until done so tick()'s drift-refetch (which
    // checks the same flag) cannot double-fire during the request
    fetchSky().then(draw).catch(() => {})
      .finally(() => { state._fetchPending = false; });
  }, 300);
}
let lastDataRefresh = 0;
function tick(nowMs) {
  if (state.playing) {
    const dt = nowMs - (state._lastFrame || nowMs);
    // net sim advance per real ms = speed * playDir (subtract the 1 ms
    // of real time that also elapses)
    state.simOffsetMs += dt * (state.speed * state.playDir - 1);
  }
  state._lastFrame = nowMs;
  const sim = simNow();
  // the local clock carries its zone, because "22:00" means nothing on
  // its own once the observing site can be anywhere on Earth
  const tzAbbr = state.sky && state.sky.time.local_iso
    ? (state.sky.time.local_iso.split(" ")[2] || "") : "";
  $("#clock-local").textContent =
    fmtHms(sim) + (tzAbbr ? ` (${tzAbbr})` : "");
  // UT and the Julian Date beside it: JD is what ephemerides and
  // observation logs are keyed on.  This is JD(UTC) — the scale the
  // clock above it is showing — not JD(TT).
  const jd = sim.getTime() / 86400000 + 2440587.5;
  const utHms = sim.toISOString().slice(11, 19);
  // the narrow layout keeps the time itself and drops the date and the
  // Julian Date, which the wide one still shows in full
  $("#clock-ut-short").textContent = `${utHms} (UT)`;
  $("#clock-utc").textContent =
    sim.toISOString().slice(0, 19).replace("T", " ") + " " + t("ui.ut") +
    "  JD " + jd.toFixed(5);
  // the date field shows where the clock actually is, so it opens on the
  // current instant instead of empty — but never while it is being typed
  const ti = $("#t-input");
  if (ti && document.activeElement !== ti) {
    const local = new Date(sim.getTime() - sim.getTimezoneOffset() * 60000);
    const v = local.toISOString().slice(0, 19);
    if (ti.value !== v) ti.value = v;
  }
  // sidereal time reads like the other two clocks — hh:mm:ss and its
  // name — because on the bar it sits directly beside them
  $("#clock-lst").textContent = state.sky
    ? (() => { const h = currentLst();
        const hh = Math.floor(h), mm = Math.floor((h - hh) * 60),
              ss = Math.floor(((h - hh) * 60 - mm) * 60);
        return `${String(hh).padStart(2, "0")}:` +
               `${String(mm).padStart(2, "0")}:` +
               `${String(ss).padStart(2, "0")} (${t("ui.lst_short")})`; })()
    : "";
  // refetch when drifted > 20 min simulated or every 60 s real time
  // (suppressed while a debounced key-scrub fetch is already pending)
  // "busy" expires: a request that has been out for fifteen seconds is
  // treated as lost rather than blocking every later update, and the
  // sequence guard in fetchSky keeps the answers in order anyway
  const skyBusy = state._skyInFlight &&
    nowMs - (state._skyInFlightSince || 0) < 15000;
  if (state.sky && !state._fetchPending && !skyBusy &&
      Math.abs(simNow().getTime() - state.lastFetchSim) > 20 * 60e3) {
    if (nowMs - lastDataRefresh > 800) {
      lastDataRefresh = nowMs;
      fetchSky().then(draw).catch(() => {});
    }
  }
  // selected-object panel: alt/az follows the animated clock (2 Hz), the
  // rise/set line refetches only when the local date/site/object changes
  if (state.selected && nowMs - (state._selTick || 0) > 500) {
    state._selTick = nowMs;
    renderSelected();
    loadSelectedRiseSet().catch(() => {});
  }
  // satellites: refetch when the simulated clock leaves the track
  // window (or when the playback speed changed the useful sampling)
  // Fetch the next window before the current one runs out.  How far
  // ahead depends on how fast the clock is running: at x600 a second of
  // real time is ten minutes of sky, so "when it expires" is far too
  // late — the lead is the simulated time that will pass while the
  // request is in flight, with a floor for the paused case.
  const lead = Math.max(4000, Math.abs(state.playing ? state.speed : 1) *
    SAT_PREFETCH_S * 1000);
  if (state.sat.on && !state.sat.fetching && !satTooFast() &&
      nowMs - (state._satFetch || 0) > 400 &&
      (!satWindowCovers(sim.getTime() + lead * state.playDir) ||
       !satWindowCovers(sim.getTime()) ||
       Math.abs(state.sat.step - satStepSeconds()) > 0.5 ||
       state.sat.n !== satSampleCount())) {
    state._satFetch = nowMs;
    fetchSatellites().catch(() => {});
  }
  if (state.sat.on && nowMs - (state._satUi || 0) > 1000) {
    state._satUi = nowMs;
    const warn = $("#sat-fast");
    if (warn) warn.hidden = !satTooFast();
    renderSatUI();
  }
  if (state.shower && state.sky) {
    const sun = state.sky.planets.find((p) => p.key === "sun");
    const moon = state.sky.planets.find((p) => p.key === "moon");
    const sa = sun ? altaz(sun.ra, sun.dec, currentLst(),
                           state.sky.site.lat_deg)[1] : -30;
    const ma = moon ? altaz(moon.ra, moon.dec, currentLst(),
                            state.sky.site.lat_deg)[1] : -30;
    updateMeteors(nowMs, effectiveLimit(sa, ma, moon ? moon.illum : 0));
  }
  demoTick(nowMs);               // scripted tour, when running
  applyFollow();                 // hold the tracked object at the centre
  deepTick(nowMs);
  draw();
  requestAnimationFrame(tick);
}

/* ---------------- comets & asteroids tab ---------------- */
function saveSB() {
  localStorage.setItem("selectedSB", JSON.stringify(state.selectedSB));
}
function sbKindOf(o) {
  return o.kind || (String(o.id).startsWith("comet") ? "comet" : "asteroid");
}
function renderSBSelected() {
  const ul = $("#sb-selected");
  ul.innerHTML = "";
  for (const s of state.selectedSB) {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.textContent = "✕";
    btn.title = t("ui.remove");
    btn.setAttribute("aria-label", `remove ${s.name}`);
    btn.addEventListener("click", async () => {
      state.selectedSB = state.selectedSB.filter((x) => x.id !== s.id);
      saveSB(); renderSBSelected(); renderSBList(); renderSBBright();
      await fetchSky().catch(() => {});
    });
    const span = document.createElement("span");
    span.textContent = s.name;
    li.append(btn, span);
    ul.appendChild(li);
  }
}
function renderSBList() {
  const ul = $("#sb-list");
  ul.innerHTML = "";
  const selIds = new Set(state.selectedSB.map((s) => s.id));
  for (const o of state.sbCatalog.slice(0, 300)) {
    const li = document.createElement("li");
    const lab = document.createElement("label");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = selIds.has(o.id);
    cb.addEventListener("change", async () => {
      if (cb.checked) {
        if (!state.selectedSB.find((x) => x.id === o.id))
          state.selectedSB.push({ id: o.id, name: o.name,
                                  kind: sbKindOf(o) });
      } else {
        state.selectedSB = state.selectedSB.filter((x) => x.id !== o.id);
      }
      saveSB(); renderSBSelected(); renderSBBright();
      await fetchSky().catch(() => {});
    });
    const span = document.createElement("span");
    span.textContent = o.name +
      (o.mag_param != null ? ` (H ${o.mag_param})` : "");
    span.title = o.id;
    lab.append(cb, span);
    li.appendChild(lab);
    ul.appendChild(li);
  }
}
function showSBFetched() {
  const f = state.sbFetched || {};
  const fmt = (s) => (s ? String(s).slice(0, 10) : "—");
  $("#sb-fetched").textContent =
    `${t("ui.mpc_fetched")}: ${t("ui.comets")} ${fmt(f.comets)} / ` +
    `${t("ui.asteroids")} ${fmt(f.asteroids)}`;
}
async function loadSBList() {
  const params = {};
  const q = $("#sb-search").value.trim();
  const kind = $("#sb-kind").value;
  if (q) params.q = q;
  if (kind) params.kind = kind;
  const d = await api("smallbodies", params);
  state.sbCatalog = d.objects || [];
  state.sbFetched = d.fetched;
  state._sbLoaded = true;
  renderSBList();
  showSBFetched();
  // Nothing cached under that name: ask JPL.  The catalogue only holds
  // the bright asteroids and the current comets, so anything else — a
  // faint numbered body, a fresh discovery — has to come from there.
  if (q && q.length >= 2 && !state.sbCatalog.length) await sbLookupJPL(q);
}

async function sbLookupJPL(query) {
  const msg = $("#sb-msg");
  msg.textContent = t("ui.sb_jpl_looking", { q: query });
  try {
    const rec = await jplLookup(query);
    if (!rec) { msg.textContent = t("ui.sb_jpl_none", { q: query }); return; }
    const r = await fetch("/api/smallbodies_import?kind=object",
      { method: "POST", body: JSON.stringify(rec),
        headers: { "Content-Type": "application/json" } });
    const out = await r.json();
    if (!out.ok) { msg.textContent = out.error || t("ui.update_failed");
                   return; }
    msg.textContent = t("ui.sb_jpl_added", { name: out.name });
    const d = await api("smallbodies", { q: query });
    state.sbCatalog = d.objects || [];
    renderSBList();
  } catch (e) {
    msg.textContent = t("ui.sb_jpl_failed");
  }
}

/* "currently bright" ranking (/api/smallbodies_bright); rows share the
 * same select-checkbox mechanism (state.selectedSB) as search results */
function renderSBBright() {
  const ul = $("#sb-bright-list");
  ul.innerHTML = "";
  const selIds = new Set(state.selectedSB.map((s) => s.id));
  for (const o of state.sbBright || []) {
    const li = document.createElement("li");
    const lab = document.createElement("label");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = selIds.has(o.id);
    cb.addEventListener("change", async () => {
      if (cb.checked) {
        if (!state.selectedSB.find((x) => x.id === o.id))
          state.selectedSB.push({ id: o.id, name: o.name, kind: o.kind });
      } else {
        state.selectedSB = state.selectedSB.filter((x) => x.id !== o.id);
      }
      saveSB(); renderSBSelected(); renderSBList();
      await fetchSky().catch(() => {});
    });
    const span = document.createElement("span");
    span.textContent = `${o.name} (${(+o.mag).toFixed(1)})`;
    span.title = o.id;
    lab.append(cb, span);
    li.appendChild(lab);
    ul.appendChild(li);
  }
}
async function loadSBBright() {
  const btn = $("#sb-bright");
  btn.disabled = true;
  btn.textContent = t("ui.updating");     // first call can take seconds
  $("#sb-msg").textContent = "";
  try {
    const d = await api("smallbodies_bright", { mag: 13, limit: 40 });
    state.sbBright = d.objects || [];
    $("#sb-bright-asof").textContent =
      t("ui.sb_bright_asof", { time: d.time_utc || "" });
    renderSBBright();
  } catch (_) {
    $("#sb-msg").textContent = t("ui.update_failed");
  } finally {
    btn.disabled = false;
    btn.textContent = t("ui.sb_bright");
  }
}

/* ---------------- 写野角 (FOV) frame list UI ---------------- */
function renderFOVList() {
  const box = $("#fov-list");
  if (!box) return;
  box.innerHTML = "";
  for (const fr of state.fovFrames) {
    const row = document.createElement("div");
    row.className = "fov-row" + (fr.id === state.fovSelected ? " sel" : "");
    row.addEventListener("pointerdown", () => {
      if (state.fovSelected !== fr.id) {
        state.fovSelected = fr.id;
        renderFOVList();
      }
    });
    const main = document.createElement("div");
    main.className = "fov-row-main";
    const en = document.createElement("input");
    en.type = "checkbox";
    en.checked = !!fr.enabled;
    en.addEventListener("change", () => {
      fr.enabled = en.checked; saveFov();
    });
    const sel = document.createElement("select");
    for (const p of FOV_PRESETS) {
      const o = document.createElement("option");
      o.value = p.id;
      o.textContent = fovPresetName(p);
      sel.appendChild(o);
    }
    sel.value = fr.preset;
    sel.addEventListener("change", () => {
      fr.preset = sel.value;
      state.fovSelected = fr.id;
      saveFov(); renderFOVList();
    });
    const rot = document.createElement("input");
    rot.type = "number";
    rot.className = "fov-rot";
    rot.step = "15";
    rot.value = fr.rotation || 0;
    rot.title = t("ui.fov_rotation");
    rot.setAttribute("aria-label", t("ui.fov_rotation"));
    rot.addEventListener("change", () => {
      fr.rotation = parseFloat(rot.value) || 0;
      state.fovSelected = fr.id;
      saveFov();
    });
    const del = document.createElement("button");
    del.textContent = "✕";
    del.title = t("ui.remove");
    del.setAttribute("aria-label", "delete frame");
    del.addEventListener("click", () => {
      state.fovFrames = state.fovFrames.filter((x) => x.id !== fr.id);
      if (state.fovSelected === fr.id)
        state.fovSelected = state.fovFrames.length
          ? state.fovFrames[state.fovFrames.length - 1].id : null;
      saveFov(); renderFOVList();
    });
    main.append(en, sel, rot, del);
    row.appendChild(main);
    if (fr.preset === "custom") {          // editable sensor / eyepiece
      const cst = fr.custom = fr.custom ||
        { kind: "rect", w: 36, h: 24, f: 50, afov: 52, mag: 40 };
      const cd = document.createElement("div");
      cd.className = "fov-custom";
      const kindSel = document.createElement("select");
      for (const [vv, ll] of [["rect", t("ui.fov_rect")],
                              ["circle", t("ui.fov_circle")]]) {
        const o = document.createElement("option");
        o.value = vv; o.textContent = ll;
        kindSel.appendChild(o);
      }
      kindSel.value = cst.kind || "rect";
      kindSel.addEventListener("change", () => {
        cst.kind = kindSel.value; saveFov(); renderFOVList();
      });
      cd.appendChild(kindSel);
      const num = (val, titleKey, set) => {
        const i = document.createElement("input");
        i.type = "number";
        i.value = val;
        i.title = t(titleKey);
        i.setAttribute("aria-label", t(titleKey));
        i.addEventListener("change", () => {
          set(parseFloat(i.value) || 0);
          state.fovSelected = fr.id;
          saveFov(); renderFOVList();      // refresh the size label
        });
        cd.appendChild(i);
      };
      if ((cst.kind || "rect") === "rect") {
        num(cst.w != null ? cst.w : 36, "ui.fov_sensor", (v) => cst.w = v);
        num(cst.h != null ? cst.h : 24, "ui.fov_sensor", (v) => cst.h = v);
        num(cst.f != null ? cst.f : 50, "ui.fov_focal", (v) => cst.f = v);
      } else {
        num(cst.afov != null ? cst.afov : 52, "ui.fov_afov",
            (v) => cst.afov = v);
        num(cst.mag != null ? cst.mag : 40, "ui.fov_mag",
            (v) => cst.mag = v);
      }
      row.appendChild(cd);
    }
    const sz = document.createElement("div");
    sz.className = "fov-size";
    sz.textContent = frameSizeLabel(fr);
    row.appendChild(sz);
    box.appendChild(row);
  }
}

/* ---------------- 衛星パスのイベントと軌跡 -------------------------
 * ISS / CSS passes and freshly launched Starlink trains appear in the
 * events list like any other phenomenon.  Selecting one moves the clock
 * to the pass and draws its path across the sky: the whole track from
 * rise to set, tick marks every minute, and the satellite itself at the
 * simulated instant, so the display answers "where do I look, and when".
 */
function satPassLabel(ev) {
  const parts = [ev.name];
  if (ev.members > 1)
    parts.push(`x${ev.members}` +
               (ev.height_km ? ` ${ev.height_km}km` : ""));
  parts.push(`${t("ui.altitude")} ${ev.max_alt.toFixed(0)}°`);
  parts.push(`${ev.rise_az.toFixed(0)}°→${ev.set_az.toFixed(0)}°`);
  if (ev.mag != null) parts.push(`${ev.mag.toFixed(1)}m`);
  return parts.join(" · ");
}

async function setSatPass(ev) {
  if (!ev) { state.satPass = null; return; }
  state.satPass = { ev, track: null };
  const t0 = new Date(ev.rise_utc).getTime();
  const t1 = new Date(ev.set_utc).getTime();
  const span = Math.max(30, (t1 - t0) / 1000);
  const n = 60;
  const step = span / (n - 1);
  try {
    const d = await api("satellites", {
      site: state.site, time: new Date(t0).toISOString(),
      norad: ev.norad, step, n, minalt: -5, sunlit: 0,
    });
    const row = (d.satellites || [])[0];
    if (row && state.satPass && state.satPass.ev === ev)
      state.satPass.track = { az: row.az, alt: row.alt, lit: row.lit,
                              t0, step };
  } catch (_) { /* the label alone still tells the user when to look */ }
}

function drawSatPass(c, W, H, pal, px) {
  const sp = state.satPass;
  if (!sp || !sp.track || pal.print) return;
  const tr = sp.track;
  const col = pal.nv ? "#e04040" : "#7fe6ee";
  c.save();
  c.strokeStyle = col;
  c.lineWidth = 1.6 * px;
  c.beginPath();
  let prev = null;
  for (let i = 0; i < tr.alt.length; i++) {
    if (tr.alt[i] < -1) { prev = null; continue; }
    const p = project(tr.az[i], tr.alt[i], W, H);
    if (!p) { prev = null; continue; }
    if (prev && Math.hypot(p[0] - prev[0], p[1] - prev[1]) < W / 3)
      c.lineTo(p[0], p[1]);
    else c.moveTo(p[0], p[1]);
    prev = p;
  }
  c.stroke();
  // one tick per minute, labelled
  c.fillStyle = col;
  c.font = `${10 * px}px sans-serif`;
  c.textAlign = "left"; c.textBaseline = "alphabetic";
  const tz = (state.sky && state.sky.time && state.sky.time.tz) || "UTC";
  for (let i = 0; i < tr.alt.length; i++) {
    const ms = tr.t0 + i * tr.step * 1000;
    if (new Date(ms).getSeconds() > tr.step) continue;
    if (tr.alt[i] < 0) continue;
    const p = project(tr.az[i], tr.alt[i], W, H);
    if (!p) continue;
    c.beginPath(); c.arc(p[0], p[1], 2.2 * px, 0, 7); c.fill();
    let hm = "";
    try {
      hm = new Date(ms).toLocaleTimeString(
        state.lang === "ja" ? "ja-JP" : "en-GB",
        { timeZone: tz, hour: "2-digit", minute: "2-digit" });
    } catch (_) { hm = ""; }
    c.fillText(hm, p[0] + 5 * px, p[1] - 4 * px);
  }
  // where it is right now
  const f = (simNow().getTime() - tr.t0) / (tr.step * 1000);
  if (f >= 0 && f <= tr.alt.length - 1) {
    const i = Math.min(tr.alt.length - 2, Math.floor(f)), u = f - i;
    const alt = tr.alt[i] + (tr.alt[i + 1] - tr.alt[i]) * u;
    let dz = ((tr.az[i + 1] - tr.az[i] + 540) % 360) - 180;
    const az = ((tr.az[i] + dz * u) % 360 + 360) % 360;
    const p = alt > -1 ? project(az, alt, W, H) : null;
    if (p) {
      c.beginPath(); c.arc(p[0], p[1], 5 * px, 0, 7);
      c.lineWidth = 1.8 * px;
      c.stroke();
      c.fillText(sp.ev.name, p[0] + 8 * px, p[1] + 4 * px);
    }
  }
  c.restore();
}

/* ---------------- 流星群のシミュレーション -------------------------
 * Selecting a shower in the events list animates it on the chart.  Every
 * quantity comes from the shower's own entry in the IMO working list:
 * the radiant (with its drift), the population index r, the geocentric
 * velocity and the ZHR.
 *
 * Rate: the honest one.  ZHR is defined for a radiant in the zenith and
 * a 6.5-mag sky, so the observable rate is
 *     HR = ZHR * sin(h_radiant) * (limiting magnitude term)
 * and meteors are spawned at that rate **per simulated hour** — so at
 * x1 you wait as long as you really would, and running the clock faster
 * shows proportionally more.  Nothing is invented to make the display
 * look busier than the sky.
 *
 * Geometry: a meteor's path lies on the great circle away from the
 * radiant, so its apparent length grows with distance from it (members
 * near the radiant are short, ones 90 deg away are longest) and its
 * angular speed follows the entry velocity.
 */
const MET_MAX_ALIVE = 400;

/* Card shown when the radiant is clicked: what the shower is, what it
 * should do tonight, and what the numbers behind the animation are. */
function showerCardHtml(sh, alt) {
  const rows = [`<b>☄ ${esc(showerName(sh))}</b>` +
    (sh.code ? ` <span class="pop-dim">${sh.code}</span>` : "")];
  rows.push(fmtRaDec(sh.ra, sh.dec));
  if (alt != null)
    rows.push(`${t("ui.altitude")} ${alt.toFixed(1)}°` +
      (alt <= 0 ? ` <span class="pop-dim">(${t("ui.below_horizon")})</span>`
                : ""));
  if (sh.peak_local)
    rows.push(`${t("ui.shower_peak")} ${esc(showerPeakLocal(sh))}` +
      (sh.peak_utc ? ` / ${esc(showerPeakUT(sh))}` : ""));
  const specs = [];
  if (sh.zhr != null) specs.push(`ZHR ${sh.zhr}`);
  if (sh.vinf != null) specs.push(`v∞ ${sh.vinf} km/s`);
  if (sh.r != null) specs.push(`r ${sh.r}`);
  if (specs.length) rows.push(specs.join(" · "));
  const rate = showerRate(sh);
  const rateText = showerRateText(sh);
  if (rateText) rows.push(`${t("ui.shower_rate")} ${rateText}`);
  if (sh.moon)
    rows.push(`${t("ui.moon_condition")} ${t("moon." + sh.moon)}` +
      (sh.moon_illum != null
        ? ` (${Math.round(sh.moon_illum * 100)}%)` : ""));
  const parent = showerParent(sh);
  if (parent) rows.push(`${t("ui.shower_parent")}: ${esc(parent)}`);
  return rows.join("<br>");
}

/* Showers are not exclusive: in August the Perseids, the δ Aquariids
 * and the α Capricornids are all running, and an observer watching that
 * sky sees meteors from all three.  The chart therefore holds a list;
 * `state.shower` stays as the first of them for the parts that describe
 * one shower (the card, the sky-condition line). */
function setMeteorShowers(list) {
  state.showersOn = (list || []).map((s) => Object.assign({}, s));
  state.shower = state.showersOn[0] || null;
  state.meteors = [];
  state._metCarry = {};
  renderShowerBadge();
  syncShowerButton();   // the chart button follows, however it was cleared
}

function setMeteorShower(sh) { setMeteorShowers(sh ? [sh] : []); }

/* One line per shower, each with its own expected rate: when three are
 * running at once, a single joined string told the observer neither
 * which they were nor which one is actually producing anything. */
function renderShowerBadge() {
  const el = $("#shower-badge");
  if (!el) return;
  const list = state.showersOn || [];
  el.hidden = !list.length;
  if (!list.length) return;
  el.innerHTML = list.map((sh) =>
    `<div class="sb-row"><button class="sb-name" data-code="${
      esc(sh.code || "")}">☄ ${esc(showerName(sh))}</button>` +
    `<span class="hint sb-rate" data-code="${esc(sh.code || "")}">` +
    "</span></div>").join("") +
    `<button id="shower-off">${t("ui.follow_stop")}</button>`;
  el.querySelector("#shower-off")
    .addEventListener("click", () => setMeteorShowers([]));
  // the name is a way in to the shower's own card
  for (const b of el.querySelectorAll(".sb-name"))
    b.addEventListener("click", (e) => {
      const sh = (state.showersOn || []).find(
        (x) => x.code === b.dataset.code);
      if (!sh) return;
      const pop = $("#popup");
      pop.innerHTML = showerDetailHtml(sh);
      placePopup(pop, e.clientX, e.clientY);
    });
}

/* ZHR at a given instant.
 *
 * The IMO working list gives the ZHR at the maximum and the period over
 * which the shower is detectable at all.  Between the two the activity
 * is taken as a Gaussian about the maximum, with two anchors:
 *
 *   * one day either side of the maximum the shower has fallen to the
 *     sporadic background — about ten meteors an hour at the zenith
 *     under a 6.5-magnitude sky — which is what "the shower is over"
 *     means to someone standing outside.  That fixes σ: for a ZHR of
 *     100 it is 0.47 d, for a ZHR of 20 it is 0.85 d.
 *   * outside the published activity period the rate is exactly zero.
 *     The Gaussian is already negligible there; the cut makes the
 *     statement definite rather than very small.
 *
 * A shower no stronger than the background (α Capricornids, ZHR 5) is
 * given the width of a shower twice the background instead of a
 * negative logarithm.
 *
 * With no window on record (a shower arriving from the events feed),
 * the peak value is returned unchanged rather than invented. */
const SPORADIC_ZHR = 10;
function shrunkZHR(sh, whenMs) {
  const zhr = sh.zhr || 20;
  const peak = Date.parse(sh.peak_utc);
  if (!isFinite(peak)) return zhr;
  const from = Date.parse(sh.active_start_utc);
  const to = Date.parse(sh.active_end_utc);
  if ((isFinite(from) && whenMs < from) || (isFinite(to) && whenMs > to))
    return 0;                                   // outside the activity
  const dtDays = (whenMs - peak) / 86400e3;
  const ratio = Math.max(2, zhr / SPORADIC_ZHR);
  const sigma = 1 / Math.sqrt(2 * Math.log(ratio));      // days
  return zhr * Math.exp(-(dtDays * dtDays) / (2 * sigma * sigma));
}

/* What the sky itself does to the count.
 *
 * This follows the 太陽光・月光 option: with it off the figure is the
 * shower and the site alone, which is what someone comparing showers
 * wants.  With it on:
 *
 *   * between sunrise and sunset nothing is seen at all — zero, not a
 *     small number;
 *   * moonlight takes away a share of the meteors that grows with the
 *     illuminated fraction and with how high the Moon stands, down to a
 *     twentieth of the dark-sky count under a full Moon overhead.  The
 *     faint end of the distribution is what is lost, and there are far
 *     more faint meteors than bright ones.
 *
 * Twilight is not modelled: the Sun below the horizon is treated as
 * night, which is right within about a magnitude for the deep twilight
 * an observer would be out in. */
/* Naked-eye limiting magnitude during twilight, from the Sun's
 * altitude.  Piecewise linear through the familiar landmarks: the sky
 * is fully dark below −18° (astronomical twilight), about 4th magnitude
 * at the end of nautical twilight, 1st magnitude at the end of civil
 * twilight, and nothing but the brightest objects at sunset. */
const TWILIGHT_LM = [[0, -1.0], [-6, 1.0], [-12, 4.0], [-18, 6.5]];
function twilightLimitingMag(sunAlt) {
  if (sunAlt <= -18) return 6.5;
  for (let i = 1; i < TWILIGHT_LM.length; i++) {
    const [a0, m0] = TWILIGHT_LM[i - 1], [a1, m1] = TWILIGHT_LM[i];
    if (sunAlt >= a1)
      return m0 + (m1 - m0) * (sunAlt - a0) / (a1 - a0);
  }
  return 6.5;
}

function meteorSkyFactor(sh) {
  if (!state.opts.skyglow || !state.sky) return 1;
  const lst = currentLst(), lat = state.sky.site.lat_deg;
  let f = 1;
  const sun = state.sky.planets.find((p) => p.key === "sun");
  if (sun) {
    const [, sa] = altaz(sun.ra, sun.dec, lst, lat);
    if (sa > 0) return 0;                     // daylight
    // Twilight: the faint meteors go first, and they are most of them.
    // The standard reduction to a brighter limit is r^(lm − 6.5), with
    // r the shower's own population index — so the same twilight costs
    // a shower rich in faint meteors more than one full of fireballs.
    const lm = twilightLimitingMag(sa);
    if (lm < 6.5) f *= Math.pow((sh && sh.r) || 2.2, lm - 6.5);
  }
  const moon = state.opts.moonglow
    ? state.sky.planets.find((p) => p.key === "moon") : null;
  if (!moon) return f;
  const [, ma] = altaz(moon.ra, moon.dec, lst, lat);
  if (ma <= 0) return f;                      // the Moon has set
  return f * Math.max(0.05,
    1 - 0.9 * (moon.illum || 0) * Math.sin(ma * D2R));
}

/* The rate together with the reason it is zero, so the display can say
 * which of the three quite different reasons applies: the radiant is
 * below the horizon, the Sun is up, or the shower is not running.  They
 * were all reported as "radiant below the horizon", which is simply
 * wrong when the radiant is 40 degrees up in a daylit sky. */
const RATE_WINDOW_DAYS = 1;
function showerRateInfo(sh) {
  if (!state.sky) return { alt: null, rate: 0, why: "none" };
  const [, alt] = altaz(sh.ra, sh.dec, currentLst(),
                        state.sky.site.lat_deg);
  // Beyond a day either side of the maximum the shower is down to the
  // sporadic background, and a number there would claim a precision the
  // model does not have — so no figure is given at all.
  const peak = Date.parse(sh.peak_utc);
  if (isFinite(peak) &&
      Math.abs(simNow() - peak) > RATE_WINDOW_DAYS * 86400e3)
    return { alt, rate: 0, why: "far" };
  const zhr = shrunkZHR(sh, simNow());
  if (zhr <= 0) return { alt, rate: 0, why: "inactive" };
  if (alt <= 0) return { alt, rate: 0, why: "below" };
  const sky = meteorSkyFactor(sh);
  if (sky <= 0) return { alt, rate: 0, why: "daylight" };
  return { alt, rate: zhr * Math.sin(alt * D2R) * sky, why: "ok" };
}

function showerRateText(sh) {
  const info = showerRateInfo(sh);
  if (info.why === "ok")
    return `${info.rate.toFixed(info.rate < 10 ? 1 : 0)} ` +
           `${t("ui.rate_unit")}`;
  if (info.why === "far" || info.why === "none") return "";
  return t(info.why === "below" ? "ui.shower_below"
         : info.why === "daylight" ? "ui.shower_daylight"
         : "ui.shower_inactive");
}

/* Expected hourly rate for this observer, in meteors per hour:
 *
 *     HR = ZHR(t) · sin(h_radiant) · (sky)
 *
 * ZHR(t) is the Gaussian above, sin(h) is the standard reduction for a
 * radiant that is not overhead, and (sky) is 1 unless the observer has
 * asked for sunlight and moonlight to be taken into account. */
function showerRate(sh) {
  if (!state.sky) return 0;
  const [, alt] = altaz(sh.ra, sh.dec, currentLst(),
                        state.sky.site.lat_deg);
  if (alt <= 0) return 0;                     // radiant below the horizon
  return shrunkZHR(sh, simNow()) * Math.sin(alt * D2R) *
         meteorSkyFactor(sh);
}

function spawnMeteor(sh) {
  // uniform over the visible sky, then kept only if it is on the far
  // side of nothing in particular — the radiant sets the direction, the
  // entry point does not
  const r = sh.r || 2.2;
  // magnitude distribution N(<m) ~ r^m: draw from the exponential tail
  const u = Math.random();
  const mag = 6.5 + Math.log(u) / Math.log(r);      // brighter = smaller
  const d = 8 + Math.random() * 82;                  // deg from radiant
  const pa = Math.random() * 360;                    // around the radiant
  return { sh, d0: d, pa, mag,
           born: performance.now(),
           life: 380 + Math.random() * 700,          // ms on screen
           len: 0 };
}

/* point at angular distance d from (ra0,dec0) along position angle pa */
function offsetRaDec(ra0, dec0, d, pa) {
  const dr = d * D2R, p = pa * D2R;
  const la = dec0 * D2R, lo = ra0 * D2R;
  const sd = Math.sin(la) * Math.cos(dr) +
             Math.cos(la) * Math.sin(dr) * Math.cos(p);
  const dec = Math.asin(Math.max(-1, Math.min(1, sd)));
  const ra = lo + Math.atan2(Math.sin(p) * Math.sin(dr) * Math.cos(la),
                             Math.cos(dr) - Math.sin(la) * sd);
  return [((ra / D2R) % 360 + 360) % 360, dec / D2R];
}

function updateMeteors(nowMs, effLimit) {
  const list = state.showersOn || [];
  if (!list.length) { state.meteors = []; return; }
  const dtReal = Math.min(0.25, (nowMs - (state._metLast || nowMs)) / 1000);
  state._metLast = nowMs;
  // simulated seconds elapsed: the rate is per simulated hour
  const simFactor = state.playing ? Math.abs(state.speed) : 1;
  if (!state._metCarry || typeof state._metCarry !== "object")
    state._metCarry = {};
  for (const sh of list) {
    const rate = showerRate(sh);
    let carry = (state._metCarry[sh.code] || 0) +
      rate / 3600 * dtReal * simFactor;
    while (carry >= 1 && state.meteors.length < MET_MAX_ALIVE) {
      carry -= 1;
      state.meteors.push(spawnMeteor(sh));
    }
    state._metCarry[sh.code] = Math.min(carry, 50);  // cap a backlog
  }
  // each badge row carries its own shower's rate
  for (const el of $$("#shower-badge .sb-rate")) {
    const sh = list.find((x) => x.code === el.dataset.code);
    el.textContent = sh ? showerRateText(sh) : "";
  }
  state.meteors = state.meteors.filter(
    (m) => nowMs - m.born < m.life);
}

/* The radiant marker.  Drawn for as long as a shower is selected — at a
 * realistic rate minutes can pass between meteors, and the radiant is
 * the thing an observer actually wants on the chart.  It is also a hit
 * target: clicking it opens the shower's card. */
function drawRadiant(c, W, H, pal, px, hits) {
  if (pal.print || !state.sky) return;
  for (const sh of state.showersOn || [])
    drawOneRadiant(c, W, H, pal, px, hits, sh);
}

function drawOneRadiant(c, W, H, pal, px, hits, sh) {
  const lst = currentLst(), lat = state.sky.site.lat_deg;
  const [az, alt] = altaz(sh.ra, sh.dec, lst, lat);
  const p = project(az, alt, W, H);
  if (!p) return;
  const up = alt > 0;
  c.save();
  c.strokeStyle = pal.nv ? "rgba(224,64,64,0.85)"
    : up ? "rgba(255,220,140,0.85)" : "rgba(255,220,140,0.35)";
  c.lineWidth = 1.4 * px;
  c.setLineDash([4 * px, 3 * px]);
  c.beginPath(); c.arc(p[0], p[1], 11 * px, 0, 7); c.stroke();
  c.setLineDash([]);
  c.beginPath();                       // small cross at the exact point
  c.moveTo(p[0] - 4 * px, p[1]); c.lineTo(p[0] + 4 * px, p[1]);
  c.moveTo(p[0], p[1] - 4 * px); c.lineTo(p[0], p[1] + 4 * px);
  c.stroke();
  c.fillStyle = pal.nv ? "#e04040" : (up ? "#ffdc8c" : "#9a8a5e");
  c.font = `${11 * px}px sans-serif`;
  c.textAlign = "left"; c.textBaseline = "alphabetic";
  c.fillText(`☄ ${showerName(sh)}`, p[0] + 14 * px, p[1] - 8 * px);
  c.restore();
  if (hits) hits.push({ x: p[0], y: p[1], kind: "radiant",
                        name: showerName(sh),
                        ra: sh.ra, dec: sh.dec, az, alt, shower: sh });
}

function drawMeteors(c, W, H, pal, px, effLimit) {
  if (!state.meteors || !state.meteors.length || pal.print) return;
  const lst = currentLst(), lat = state.sky.site.lat_deg;
  const now = performance.now();
  c.save();
  c.lineCap = "round";
  for (const m of state.meteors) {
    const sh = m.sh || state.shower;
    if (!sh) continue;
    // apparent path length: v_inf gives the angular speed, and the
    // foreshortening factor sin(d) makes trails near the radiant short
    const vscale = (sh.vinf || 40) / 60;
    const f = (now - m.born) / m.life;              // 0..1
    if (f < 0 || f > 1) continue;
    const span = 14 * vscale * Math.sin(m.d0 * D2R);   // total path, deg
    const dA = m.d0 + span * Math.max(0, f - 0.15);
    const dB = m.d0 + span * f;
    const [ra1, de1] = offsetRaDec(sh.ra, sh.dec, dA, m.pa);
    const [ra2, de2] = offsetRaDec(sh.ra, sh.dec, dB, m.pa);
    const a1 = altaz(ra1, de1, lst, lat), a2 = altaz(ra2, de2, lst, lat);
    if (a2[1] < 0) continue;
    const p1 = project(a1[0], a1[1], W, H);
    const p2 = project(a2[0], a2[1], W, H);
    if (!p1 || !p2) continue;
    if (Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) > W / 3) continue;
    // brightness: rises fast, decays; scaled by the drawn magnitude
    const bright = Math.max(0, Math.min(1,
      (f < 0.2 ? f / 0.2 : 1 - (f - 0.2) / 0.8))) *
      Math.max(0.25, Math.min(1, (6.5 - m.mag) / 5 + 0.3));
    const g = c.createLinearGradient(p1[0], p1[1], p2[0], p2[1]);
    const head = pal.nv ? "255,90,90" : "255,255,235";
    g.addColorStop(0, `rgba(${head},0)`);
    g.addColorStop(1, `rgba(${head},${bright})`);
    c.strokeStyle = g;
    c.lineWidth = Math.max(1, (1.6 - m.mag * 0.16)) * px;
    c.beginPath();
    c.moveTo(p1[0], p1[1]); c.lineTo(p2[0], p2[1]);
    c.stroke();
  }
  c.restore();
}

/* ---------------- 惑星の衛星 (moons on the chart) -------------------
 * Galilean and classical Saturnian moons, drawn wherever their parent
 * planet is drawn.  They are never magnitude-limited: a moon is part of
 * the planet's appearance, and at the zoom where you can separate them
 * the sky-glow cut that applies to field stars is beside the point.
 *
 * /api/sky carries their offsets, but that payload is only refreshed
 * when the simulated clock drifts ~20 min, and Io moves a third of a
 * Jupiter radius in that time — visible once the disk is large.  So when
 * a planet is drawn big the configuration is topped up from
 * /api/planetview, which is the same solution the close-up modal uses.
 */
const MOON_REFRESH_RPX = 8;        // disk radius that triggers topping up
let _moonPending = {};

function moonsOf(pl) {
  const fresh = state.moonCache && state.moonCache[pl.key];
  return (fresh && fresh.moons) || pl.moons || null;
}

function refreshMoons(body, rpx) {
  if (rpx < MOON_REFRESH_RPX) return;
  const now = performance.now();
  const cache = (state.moonCache = state.moonCache || {});
  const c = cache[body];
  const simMs = simNow().getTime();
  // re-solve every 3 s of wall clock, or whenever the simulated clock
  // has moved more than a minute since the cached solution
  if (c && now - c.at < 3000 && Math.abs(simMs - c.sim) < 60e3) return;
  if (_moonPending[body]) return;
  _moonPending[body] = true;
  api("planetview", { body, site: state.site,
                      time: new Date(simMs).toISOString() })
    .then((d) => {
      cache[body] = { moons: (d.moons || []).map((m) => ({
        name: m.name, name_ja: m.name_ja, front: m.front,
        // the modal works in planet radii; the chart wants arcsec
        dx: m.dx_radii * d.diameter_arcsec / 2,
        dy: m.dy_radii * d.diameter_arcsec / 2 })),
        at: now, sim: simMs };
    })
    .catch(() => {})
    .finally(() => { _moonPending[body] = false; });
}

function drawPlanetMoons(c, pl, rpx, W, H, pal, px, hits) {
  const moons = moonsOf(pl);
  if (!moons || !moons.length) return;
  refreshMoons(pl.key, rpx);
  const cosd = Math.max(0.02, Math.cos(pl.dec * D2R));
  const lst = currentLst(), lat = state.sky.site.lat_deg;
  const r = Math.max(1.1, Math.min(3.2, rpx * 0.09)) * px;
  c.font = `${10 * px}px sans-serif`;
  c.textAlign = "left"; c.textBaseline = "alphabetic";
  for (const m of moons) {
    const ra = pl.ra + (m.dx / 3600) / cosd;
    const dec = pl.dec + m.dy / 3600;
    const [az, alt] = altaz(ra, dec, lst, lat);
    const p = project(az, alt, W, H);
    if (!p || alt < -1) continue;
    c.fillStyle = pal.print ? "#000"
      : m.front ? "#fff8e0" : (pal.nv ? "#c04040" : "#cfd4dc");
    c.beginPath(); c.arc(p[0], p[1], r, 0, 7); c.fill();
    if (rpx > 10) {                 // names once they are separable
      c.fillStyle = pal.print ? "#333"
        : (pal.nv ? "#a02020" : "#9fb4d8");
      c.fillText(state.lang === "ja" ? m.name_ja : m.name,
                 p[0] + r + 3 * px, p[1] - 3 * px);
    }
    if (hits) hits.push({ x: p[0], y: p[1], kind: "moon",
      name: state.lang === "ja" ? m.name_ja : m.name,
      ra, dec, vmag: null, az, alt });
  }
}

/* ---------------- 天体面のテクスチャ描画 (disk rendering) -----------
 * Once a body's disk is more than a few pixels across, a coloured dot is
 * no longer an honest picture of it.  This renders the real sphere:
 * an orthographic projection of the surface map, oriented by the
 * sub-observer point and the position angle of the body's north pole
 * (server side: IAU WGCCRE rotation elements, Meeus libration for the
 * Moon), with the terminator placed by the sub-solar direction.
 *
 * The Sun deliberately has no map — a static texture would put spots and
 * granulation at fixed longitudes, which is fiction.  It is drawn from a
 * limb-darkening law instead, which is the part of its appearance that
 * really is fixed.
 *
 * Sprites are rendered once per (body, orientation, size) and cached; the
 * longitude step is chosen so a cached sprite is never more than about a
 * pixel out of date. */
const DISK_MIN_RADIUS_PX = 3.5;    // below this a dot is drawn instead
/* Sprite resolution.  The maps are 2048 px around the body, so half of
 * one covers the visible hemisphere in ~1024 texels: a sprite radius of
 * 512 px is the point past which there is nothing more to resolve.
 * Building one costs a megapixel, so while the clock is running or the
 * view is being dragged the cheaper 200 px sprite is used and scaled. */
const DISK_SPRITE_PX_STILL = 512;
const DISK_SPRITE_PX_MOVING = 200;
const SUN_LIMB_U = 0.84, SUN_LIMB_V = -0.20;   // 550 nm limb darkening

const _texImages = {};
let _texIndex = null;

async function loadPlanetTextures() {
  try {
    const d = await api("planet_textures");
    _texIndex = d.available ? d.bodies : null;
    state.texCredit = d.available ? d.credit : null;
  } catch (_) { _texIndex = null; }
}

function textureFor(body) {
  if (!_texIndex || !_texIndex[body]) return null;
  let img = _texImages[body];
  if (img === undefined) {
    img = new Image();
    img.src = `planettex/${_texIndex[body].file}`;
    img.onload = () => { img._ready = true; };
    img.onerror = () => { _texImages[body] = null; };
    _texImages[body] = img;
  }
  return img && img._ready ? img : null;
}

/* pixel data of a texture, sampled by (u, v) in [0,1) */
function textureData(body) {
  const img = textureFor(body);
  if (!img) return null;
  let td = _texImages[body]._data;
  if (!td) {
    const w = Math.min(img.naturalWidth, 2048);
    const h = Math.round(w / 2);
    const cv = document.createElement("canvas");
    cv.width = w; cv.height = h;
    const cx = cv.getContext("2d", { willReadFrequently: true });
    cx.drawImage(img, 0, 0, w, h);
    td = { w, h, px: cx.getImageData(0, 0, w, h).data };
    _texImages[body]._data = td;
  }
  return td;
}

/* Direction to the Sun in the sub-observer basis (e = body east at the
 * disk centre, n = toward the pole, k = toward the viewer).
 *
 * The Sun lies `phase` degrees off the line of sight, in the direction of
 * the bright limb; that is all the terminator needs, and it holds for
 * every body, so no per-body sub-solar solution is required.  In the
 * image plane a sky position angle psi is n·cos(psi-pa) - e·sin(psi-pa),
 * because n sits at PA = pa and e at PA = pa - 90. */
function sunDirInDiskFrame(phaseDeg, limbPaDeg, polePaDeg) {
  const a = phaseDeg * D2R, d = (limbPaDeg - polePaDeg) * D2R;
  return [-Math.sin(a) * Math.sin(d),
          Math.sin(a) * Math.cos(d),
          Math.cos(a)];
}

/* position angle of the bright limb: away from the Sun's apparent place */
function brightLimbPA(ra, dec) {
  const sun = state.sky && state.sky.planets.find((p) => p.key === "sun");
  if (!sun) return 0;
  const a = ra * D2R, d = dec * D2R;
  const as = sun.ra * D2R, ds = sun.dec * D2R;
  return (Math.atan2(Math.cos(ds) * Math.sin(as - a),
                     Math.sin(ds) * Math.cos(d) -
                     Math.cos(ds) * Math.sin(d) * Math.cos(as - a))
          / D2R + 360) % 360;
}

/* Render one body sprite: pole UP, body-east to the RIGHT (which is
 * celestial west — the IAU planetographic east limb is the preceding
 * limb on the sky).  Returns a canvas of size 2R. */
function buildDiskSprite(body, R, o, sun) {
  const cv = document.createElement("canvas");
  cv.width = cv.height = 2 * R;
  const cx = cv.getContext("2d");
  const img = cx.createImageData(2 * R, 2 * R);
  const out = img.data;
  const td = textureData(body);
  const lat0 = o.lat * D2R;
  const sl0 = Math.sin(lat0), cl0 = Math.cos(lat0);
  const S = sun;                     // sub-solar direction (null = all lit)
  const softness = 2.5 / R;          // terminator softening, ~1 px
  for (let iy = 0; iy < 2 * R; iy++) {
    const b = 1 - (iy + 0.5) / R;    // +1 at the top (pole side)
    for (let ix = 0; ix < 2 * R; ix++) {
      const a = (ix + 0.5) / R - 1;
      const q = 1 - a * a - b * b;
      const i4 = (iy * 2 * R + ix) * 4;
      if (q <= 0) continue;          // outside the disk: transparent
      const c = Math.sqrt(q);
      const sinLat = b * cl0 + c * sl0;
      const B = -b * sl0 + c * cl0;
      const lat = Math.asin(Math.max(-1, Math.min(1, sinLat))) / D2R;
      const lon = o.lon + Math.atan2(a, B) / D2R;
      let r = 190, g = 190, bl = 190;
      if (td) {
        const u = (((lon + 180) % 360) + 360) % 360 / 360;
        const v = (90 - lat) / 180;
        const px = (Math.min(td.h - 1, Math.max(0, Math.round(v * td.h))) *
          td.w + Math.min(td.w - 1, Math.floor(u * td.w))) * 4;
        r = td.px[px]; g = td.px[px + 1]; bl = td.px[px + 2];
      }
      // illumination: Lambert on the sub-solar direction + a little
      // ambient so the night side is not a hard black hole
      let lit = 1;
      if (S) {
        const mu = a * S[0] + b * S[1] + c * S[2];
        lit = mu <= -softness ? 0
          : mu >= softness ? 1 : (mu + softness) / (2 * softness);
        lit = 0.04 + 0.96 * lit * Math.max(0, Math.min(1, mu * 3 + 0.35));
      }
      out[i4] = r * lit;
      out[i4 + 1] = g * lit;
      out[i4 + 2] = bl * lit;
      out[i4 + 3] = 255;
    }
  }
  cx.putImageData(img, 0, 0);
  return cv;
}

const _diskCache = new Map();
function diskSprite(body, R, o, sun) {
  // quantise so a cached sprite is at most ~1 px out of date
  const fast = state.playing && Math.abs(state.speed) > 1000;
  const step = Math.max(0.05, (fast ? 8 : 1) * 57 / R);
  const key = [body, R, Math.round(o.lon / step), Math.round(o.lat / step),
               sun ? sun.map((x) => x.toFixed(3)).join(",") : "-"].join("|");
  let hit = _diskCache.get(key);
  if (!hit) {
    hit = buildDiskSprite(body, R, o, sun);
    if (_diskCache.size > 24) _diskCache.clear();
    _diskCache.set(key, hit);
  }
  return hit;
}

/* screen directions of celestial north and east at (ra, dec) — derived
 * from the projection itself, so mirror, view mode and parallactic
 * rotation are all accounted for */
/* Lay a photograph on the sky, centred on its object and scaled so its
 * width spans `width_deg`.  Astrophotographs are published north-up and
 * east-left, so the image axes follow the sky axes at that point, with
 * a mirror when the projection itself is handed the other way (the
 * 鏡像反転 option, or simply the all-sky view).
 *
 * The scale is the catalogue diameter of the object, not a plate
 * solution — the demo says so on screen, because a published crop is
 * framed to taste and this is a comparison of angular sizes, not
 * astrometry. */
function drawSkyPhoto(c, ov, W, H, P) {
  const img = ov.img;
  if (!img || !img.complete || !img.naturalWidth) return;
  const p = P(ov.ra, ov.dec);
  if (!p || p[3] < 0) return;
  const ax = skyAxesAt(ov.ra, ov.dec, W, H);
  const s = (ov.width_deg * (W / fieldWidthDeg())) / img.naturalWidth;
  if (!(s > 0) || !isFinite(s)) return;
  // screen y grows downward, so the untouched sky gives north x east < 0
  const mir = (ax.north[0] * ax.east[1] -
               ax.north[1] * ax.east[0]) > 0 ? -1 : 1;
  // A photograph has its own resolution.  Magnified past the scale it
  // can support it is a wall of blur showing nothing real, so it fades
  // out as the view closes in on it — which is what the field-of-view
  // scene does on the way in from the previous close-up.
  const k = Math.max(0, Math.min(1,
    (fieldWidthDeg() / ov.width_deg - 1.2) / 1.3));
  if (k <= 0.01) return;
  const src = featheredPhoto(ov.id, img);
  c.save();
  c.globalAlpha = (ov.alpha == null ? 1 : ov.alpha) * k;
  // added to the sky rather than laid over it: the photograph's own
  // black background then contributes nothing and the edge, already
  // faded by the mask, leaves no rectangle behind
  c.globalCompositeOperation = "lighter";
  c.translate(p[0], p[1]);
  c.transform(-mir * ax.east[0] * s, -mir * ax.east[1] * s,
              -ax.north[0] * s, -ax.north[1] * s, 0, 0);
  c.drawImage(src, -img.naturalWidth / 2, -img.naturalHeight / 2);
  c.restore();
}

/* the same photograph with its corners faded out, built once */
const _feathered = new Map();
function featheredPhoto(id, img) {
  const hit = _feathered.get(id);
  if (hit) return hit;
  const w = img.naturalWidth, h = img.naturalHeight;
  const cv = document.createElement("canvas");
  cv.width = w; cv.height = h;
  const g = cv.getContext("2d");
  g.drawImage(img, 0, 0);
  g.globalCompositeOperation = "destination-in";
  const r = Math.min(w, h) / 2;
  const grad = g.createRadialGradient(w / 2, h / 2, r * 0.55,
                                      w / 2, h / 2, r * 1.0);
  grad.addColorStop(0, "rgba(0,0,0,1)");
  grad.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, w, h);
  _feathered.set(id, cv);
  return cv;
}

const _photoCache = new Map();
function skyPhotoImage(id) {
  if (_photoCache.has(id)) return _photoCache.get(id);
  const rec = state.dsoPhotos && state.dsoPhotos[id];
  if (!rec) return null;
  const img = new Image();
  img.src = `dsophoto/${rec.file}`;
  _photoCache.set(id, img);
  return img;
}

function skyAxesAt(ra, dec, W, H) {
  const eps = 0.05;
  const P = (r, d) => {
    const [az, alt] = altaz(r, d, currentLst(), state.sky.site.lat_deg);
    return projectRaw(az, alt, W, H);
  };
  const p0 = P(ra, dec);
  const dn = P(ra, Math.min(89.9, dec + eps));
  const de = P(ra + eps / Math.max(0.02, Math.cos(dec * D2R)), dec);
  const norm = (v) => {
    const n = Math.hypot(v[0], v[1]) || 1;
    return [v[0] / n, v[1] / n];
  };
  return { north: norm([dn[0] - p0[0], dn[1] - p0[1]]),
           east: norm([de[0] - p0[0], de[1] - p0[1]]) };
}

/* Draw the body at (x, y) with apparent radius rpx.  Returns false when
 * the disk is too small to be worth rendering (caller draws a dot). */
function drawBodyDisk(c, x, y, rpx, pl, W, H, pal) {
  if (rpx < DISK_MIN_RADIUS_PX || pal.print) return false;
  const busy = state._dragging || (state.playing &&
                                   Math.abs(state.speed) > 60);
  const cap = busy ? DISK_SPRITE_PX_MOVING : DISK_SPRITE_PX_STILL;
  const R = Math.max(4, Math.round(Math.min(rpx, cap)));
  const scale = rpx / R;
  const ax = skyAxesAt(pl.ra, pl.dec, W, H);
  if (pl.key === "sun") {            // limb darkening, no invented map
    const g = c.createRadialGradient(x, y, 0, x, y, rpx);
    for (let i = 0; i <= 8; i++) {
      const f = i / 8, mu = Math.sqrt(Math.max(0, 1 - f * f));
      const k = 1 - SUN_LIMB_U * (1 - mu) - SUN_LIMB_V * (1 - mu * mu);
      const v = Math.max(0, Math.min(1, k));
      g.addColorStop(f, pal.nv
        ? `rgb(${Math.round(255 * v)},${Math.round(60 * v)},` +
          `${Math.round(40 * v)})`
        : `rgb(255,${Math.round(232 * v + 20)},${Math.round(150 * v)})`);
    }
    c.fillStyle = g;
    c.beginPath(); c.arc(x, y, rpx, 0, 7); c.fill();
    return true;
  }
  const o = pl.orient;
  if (!o || !textureFor(pl.key)) return false;
  // carry the rotation forward from the epoch of the sky payload
  const dtDays = (simNow().getTime() - (state.skyEpochMs || 0)) / 86400e3;
  const lonNow = o.lon + (o.lon_rate || 0) * dtDays;
  const sun = (pl.phase == null || pl.phase < 0.05) ? null
    : sunDirInDiskFrame(pl.phase, brightLimbPA(pl.ra, pl.dec), o.pa);
  const sprite = diskSprite(pl.key, R, { lon: lonNow, lat: o.lat }, sun);
  // pole at position angle o.pa; body-east 90° before it
  const pole = [ax.north[0] * Math.cos(o.pa * D2R) +
                ax.east[0] * Math.sin(o.pa * D2R),
                ax.north[1] * Math.cos(o.pa * D2R) +
                ax.east[1] * Math.sin(o.pa * D2R)];
  const ea = (o.pa - 90) * D2R;
  const eDir = [ax.north[0] * Math.cos(ea) + ax.east[0] * Math.sin(ea),
                ax.north[1] * Math.cos(ea) + ax.east[1] * Math.sin(ea)];
  const flip = (pole[0] * eDir[1] - pole[1] * eDir[0]) > 0 ? 1 : -1;
  c.save();
  c.translate(x, y);
  // sprite space: +x = body east, +y down = away from the pole
  c.transform(flip * eDir[0] * scale, flip * eDir[1] * scale,
              -pole[0] * scale, -pole[1] * scale, 0, 0);
  if (pl.key === "saturn") drawSaturnRings(c, R, o, -1);
  c.drawImage(sprite, -R, -R);
  if (pl.key === "saturn") drawSaturnRings(c, R, o, +1);
  c.restore();
  return true;
}

/* Rings in sprite space (pole up): an ellipse squashed by sin(B), drawn
 * in two halves so the globe sits between them. */
function drawSaturnRings(c, R, o, half) {
  const B = Math.abs(o.lat) * D2R;          // ring opening angle
  const front = (o.lat >= 0) === (half > 0);
  const RINGS = [[1.24, 1.53, 0.35], [1.53, 1.95, 0.85], [2.03, 2.27, 0.6]];
  c.save();
  for (const [r0, r1, alpha] of RINGS) {
    c.beginPath();
    c.ellipse(0, 0, r1 * R, r1 * R * Math.sin(B), 0,
              front ? 0 : Math.PI, front ? Math.PI : 2 * Math.PI);
    c.ellipse(0, 0, r0 * R, r0 * R * Math.sin(B), 0,
              front ? Math.PI : 2 * Math.PI, front ? 0 : Math.PI, true);
    c.closePath();
    c.fillStyle = `rgba(214,196,158,${alpha})`;
    c.fill();
  }
  c.restore();
}

/* ---------------- メシエ天体の写真つき情報カード --------------------
 * data/dso_photos (scripts/fetch_messier_photos.py) holds one freely
 * licensed photograph per Messier object plus its attribution; the
 * index is fetched once at boot.  Without that directory the card just
 * drops the picture — nothing else changes. */
async function loadDsoPhotos() {
  try {
    const d = await api("dso_photos");
    state.dsoPhotos = d.available ? d.objects : null;
  } catch (_) { state.dsoPhotos = null; }
  try {
    const d = await api("dso_info");
    state.dsoInfo = d.available ? d.objects : null;
    state.dsoInfoLicence = d.licence || "";
  } catch (_) { state.dsoInfo = null; }
}

function dsoPhotoOf(id) {
  return (state.dsoPhotos && state.dsoPhotos[id]) || null;
}

function dsoTypeName(type) {
  return type ? t(`dsotype.${type}`) : "";
}

/* header of the DSO popup: name, photograph + credit, catalogue detail */
function dsoCardHtml(hit) {
  const d = hit.dso || {};
  const ph = dsoPhotoOf(d.id || hit.id);
  const alt = (state.lang === "ja" && d.name_ja) ? d.name_ja
    : (d.name_en || d.id || "");
  let h = `<b>${hit.name}</b>`;
  const sub = [d.id, d.ngc].filter(
    (x) => x && x !== hit.name).join(" / ");
  if (sub) h += ` <span class="pop-dim">${sub}</span>`;
  h += "<br>";
  if (ph) {
    h += `<img class="dso-photo" src="dsophoto/${ph.file}" alt="${alt}">` +
      `<div class="dso-credit">${ph.author}` +
      `${ph.licence ? ` / ${ph.licence}` : ""}</div>`;
  }
  const facts = [];
  if (d.type) facts.push(dsoTypeName(d.type));
  if (d.con) facts.push(d.con);
  if (d.size_arcmin) facts.push(`${d.size_arcmin}′`);
  if (d.best_month)
    facts.push(`${t("ui.best_month")} ${d.best_month}` +
               (state.lang === "ja" ? "月" : ""));
  if (facts.length) h += `${facts.join(" · ")}<br>`;
  // what the object actually is, in a sentence or two
  const info = state.dsoInfo && state.dsoInfo[d.id || hit.id];
  const desc = info && (state.lang === "ja" ? info.desc_ja : info.desc_en);
  if (desc)
    h += `<div class="dso-desc">${esc(desc)}` +
      `<span class="pop-dim"> — Wikipedia` +
      `${state.dsoInfoLicence ? " / " + esc(state.dsoInfoLicence) : ""}` +
      `</span></div>`;
  return h;
}

/* ---------------- 人工衛星 (TLE / SGP4) -----------------------------
 * Satellites move ~1°/s, so the rigid LST rotation the rest of the
 * chart animates with is useless for them.  The server instead returns
 * a short alt/az TRACK per satellite (n samples, `step` seconds apart,
 * SGP4 in TEME rotated to the Earth-fixed frame) and the client
 * interpolates inside that window, refetching when the simulated clock
 * runs out of it.  The sample spacing follows the playback speed so one
 * window always covers a useful stretch of simulated time. */
//: samples per window.  A big group costs seconds to propagate — the
//: whole Starlink catalogue is ~11,000 objects — so at speed the window
//: has to be long enough that the next one is ready before this one
//: runs out.  120 is the server's ceiling.
const SAT_SAMPLES = 60;
const SAT_SAMPLES_FAST = 120;
//: seconds of real time a satellite fetch is assumed to take, used to
//: start the next one early enough that playback never runs dry
const SAT_PREFETCH_S = 4;
//: seconds of satellite motion that may be extrapolated past either end
//: of the window.  A satellite covers about a degree a second, so this
//: is roughly ten degrees — enough to cover a late reply, little enough
//: that what is drawn is still where the satellite is.
const SAT_GRACE_S = 10;

//: Above this the layer is suspended rather than drawn.  One real
//: second is then well over an hour of sky: a satellite would cross the
//: whole chart between two frames, so any position drawn for it is a
//: guess.  Saying so beats flickering wrong dots.
const SAT_MAX_SPEED = 600;

function satTooFast() {
  return state.playing && Math.abs(state.speed) > SAT_MAX_SPEED;
}

function satSampleCount() {
  const sp = state.playing ? Math.abs(state.speed) : 1;
  return sp > 100 ? SAT_SAMPLES_FAST : SAT_SAMPLES;
}

function saveSat() {
  localStorage.setItem("sat", JSON.stringify({
    v: SAT_SETTINGS_V,
    on: state.sat.on, groups: state.sat.groups,
    maxmag: state.sat.maxmag, sunlitOnly: state.sat.sunlitOnly }));
}

/* sample spacing [s]: fine while the clock runs in real time, coarser
 * (so one window still spans minutes of simulated time) during playback */
function satStepSeconds() {
  const sp = state.playing ? Math.abs(state.speed) : 1;
  // A satellite covers roughly a degree of sky a second, so samples much
  // further apart than this cannot describe the arc however they are
  // interpolated.  The window shrinks in simulated time as the clock
  // speeds up, which is the right trade: at x600 a pass is over in a
  // blink, and at the speeds people actually watch one it stays smooth.
  return Math.min(60, Math.max(2, Math.round(sp * 0.15)));
}

function satWindowCovers(ms) {
  const s = state.sat;
  if (!s.data || !s.t0) return false;
  return ms >= s.t0 && ms <= s.t0 + s.step * (s.n - 1) * 1000;
}

async function fetchSatellites() {
  const s = state.sat;
  if (s.fetching) return;
  s.fetching = true;
  const step = satStepSeconds();
  const n = satSampleCount();
  // start the window slightly before "now" so a backward step or a
  // frame of jitter does not immediately invalidate it
  const t0 = new Date(simNow().getTime() - step * 2000);
  try {
    const d = await api("satellites", {
      site: state.site, time: t0.toISOString(),
      groups: s.groups.join(","), step, n,
      minalt: -2, maxmag: s.maxmag,
      sunlit: s.sunlitOnly ? 1 : 0,
      // desig: show one launch only — what makes a Starlink train worth
      // watching is the line, which 8000 unrelated satellites hide
      ...(s.desig ? { desig: s.desig } : {}),
    });
    s.available = !!d.available;
    s.loaded = d.loaded || 0;
    s.groupMeta = d.groups || [];
    s.data = d.satellites || [];
    s.t0 = t0.getTime();
    s.step = step;
    s.n = n;
    renderSatUI();
  } finally {
    s.fetching = false;
  }
}

/* interpolated alt/az of every tracked satellite at the simulated time */
/* Great-circle interpolation between two alt/az samples.
 *
 * Interpolating azimuth and altitude separately cuts the corner of the
 * arc, and near the zenith — where the azimuth sweeps fastest — it also
 * makes the satellite speed up and slow down between samples.  On an
 * 85-degree pass that showed up as a 4x swing in apparent speed with a
 * visible kink at every sample.  On the sphere there is no such
 * artefact: the path is the arc and the rate along it is constant.
 */
function azAltToVec(az, alt) {
  const a = alt * D2R, z = az * D2R, ca = Math.cos(a);
  return [ca * Math.cos(z), ca * Math.sin(z), Math.sin(a)];
}

function slerpAzAlt(az0, alt0, az1, alt1, u) {
  const v0 = azAltToVec(az0, alt0), v1 = azAltToVec(az1, alt1);
  const dot = Math.max(-1, Math.min(1,
    v0[0] * v1[0] + v0[1] * v1[1] + v0[2] * v1[2]));
  const th = Math.acos(dot);
  let x, y, z;
  if (th < 1e-7) {                       // the two samples coincide
    x = v0[0]; y = v0[1]; z = v0[2];
  } else {
    const sn = Math.sin(th);
    const s0 = Math.sin((1 - u) * th) / sn, s1 = Math.sin(u * th) / sn;
    x = v0[0] * s0 + v1[0] * s1;
    y = v0[1] * s0 + v1[1] * s1;
    z = v0[2] * s0 + v1[2] * s1;
  }
  const r = Math.hypot(x, y, z) || 1;
  return { az: ((Math.atan2(y / r, x / r) / D2R) % 360 + 360) % 360,
           alt: Math.asin(Math.max(-1, Math.min(1, z / r))) / D2R };
}

function satellitesNow() {
  const s = state.sat;
  if (!s.on || !s.data || !s.t0 || satTooFast()) return [];
  const f = (simNow().getTime() - s.t0) / (s.step * 1000);
  // A grace band of one sample either side, extrapolated along the same
  // great circle the interpolation uses.  Under continuous playback the
  // clock reaches the end of a window before its replacement has been
  // fetched — with a hard cut-off every satellite blinked out for as
  // long as the request took.  A few seconds of extrapolation is far
  // more honest than a gap, and the prefetch below normally lands
  // before the band is needed at all.
  const last = s.n - 1;
  const grace = SAT_GRACE_S / Math.max(1, s.step);
  if (!(f >= -grace && f <= last + grace)) return [];
  const i = Math.min(last - 1, Math.max(0, Math.floor(f)));
  const u = f - i;
  const out = [];
  for (const sat of s.data) {
    const a0 = sat.alt[i], a1 = sat.alt[i + 1];
    if (a0 == null || a1 == null) continue;
    const { az, alt } = slerpAzAlt(sat.az[i], a0, sat.az[i + 1], a1, u);
    if (alt < -1) continue;
    const lit = u < 0.5 ? sat.lit[i] : sat.lit[i + 1];
    const mag = (u < 0.5 ? sat.mag[i] : sat.mag[i + 1]);
    out.push({ name: sat.name, norad: sat.norad, az, alt, lit, mag,
               range_km: sat.range_km, height_km: sat.height_km,
               age: sat.elements_age_days });
  }
  return out;
}

/* Two large crewed stations are in orbit: the ISS and Tiangong.
 *
 * CelesTrak's "stations" file does not list them that way — it lists
 * their modules, because each was launched and tracked separately, so
 * ZARYA, POISK and NAUKA all arrive as if they were spacecraft of their
 * own, as do TIANHE, WENTIAN and MENGTIAN.  They are bolted together
 * and share one orbit to within tens of metres, so the chart draws one
 * marker per station, on the module the whole assembly is catalogued
 * from, and names it after the station.  Visiting vehicles — Progress,
 * Crew Dragon, Shenzhou, Tianzhou, Cygnus — stay separate: those really
 * are distinct spacecraft, even while docked. */
const STATION_PRIMARY = { iss: 25544, css: 48274 };
function stationKey(name) {
  if (/^ISS\b/i.test(name || "")) return "iss";
  if (/^CSS\b/i.test(name || "")) return "css";
  return null;
}

function isStationModule(s) {
  const k = stationKey(s.name);
  return k ? s.norad !== STATION_PRIMARY[k] : false;
}

function satChartName(s) {
  const k = stationKey(s.name);
  if (k === "iss") return "ISS";
  if (k === "css") return state.lang === "ja" ? "天宮" : "Tiangong";
  return s.name;
}

function satFullName(s) {
  const k = stationKey(s.name);
  if (k === "iss")
    return state.lang === "ja" ? "国際宇宙ステーション (ISS)"
                               : "International Space Station (ISS)";
  if (k === "css")
    return state.lang === "ja" ? "中国宇宙ステーション 天宮 (CSS)"
                               : "Chinese Space Station Tiangong (CSS)";
  return s.name;
}

function drawSatellites(c, W, H, pal, px, hits) {
  const sats = satellitesNow();
  if (!sats.length) return;
  c.font = `${10 * px}px sans-serif`;
  c.textAlign = "left";
  c.textBaseline = "alphabetic";
  // ISS modules / docked vehicles share one orbit and pile up on the
  // same pixel — label only the first (brightest) of each cluster
  const labelled = [];
  sats.sort((a, b) => (a.mag == null ? 99 : a.mag) -
                      (b.mag == null ? 99 : b.mag));
  for (const s of sats) {
    if (isStationModule(s)) continue;   // one marker per station
    const p = project(s.az, s.alt, W, H);
    if (!p) continue;
    const col = s.lit ? pal.satellite : pal.satelliteDark;
    const r = 2.6 * px;
    c.strokeStyle = c.fillStyle = col;
    c.lineWidth = 1.2 * px;
    if (s.lit) { c.beginPath(); c.arc(p[0], p[1], r, 0, 7); c.fill(); }
    else { c.beginPath(); c.arc(p[0], p[1], r, 0, 7); c.stroke(); }
    c.beginPath();                       // small cross so it reads as
    c.moveTo(p[0] - r * 2.2, p[1]);      // "artificial", not a star
    c.lineTo(p[0] - r * 1.3, p[1]);
    c.moveTo(p[0] + r * 1.3, p[1]);
    c.lineTo(p[0] + r * 2.2, p[1]);
    c.stroke();
    if (!labelled.some(([lx, ly]) =>
        Math.hypot(lx - p[0], ly - p[1]) < 14 * px)) {
      c.fillText(satChartName(s), p[0] + 5 * px, p[1] - 4 * px);
      labelled.push([p[0], p[1]]);
    }
    if (hits) hits.push({ x: p[0], y: p[1], kind: "satellite",
      name: satFullName(s), norad: s.norad, az: s.az, alt: s.alt,
      vmag: s.mag,
      range_km: s.range_km, height_km: s.height_km, sunlit: s.lit,
      age: s.age });
  }
}

/* --- 天体タブの人工衛星セクション --- */
function renderSatUI() {
  const s = state.sat;
  const box = $("#sat-groups");
  if (box && !box._built) {
    box._built = true;
    for (const g of (s.groupMeta.length ? s.groupMeta
                     : [{ key: "stations", ja: "宇宙ステーション",
                          en: "Space stations" },
                        { key: "visual", ja: "肉眼で見える衛星",
                          en: "Brightest (visual)" }])) {
      const lab = document.createElement("label");
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = s.groups.includes(g.key);
      cb.addEventListener("change", () => {
        s.groups = cb.checked ? [...new Set([...s.groups, g.key])]
                              : s.groups.filter((x) => x !== g.key);
        s.t0 = 0;                        // invalidate the window
        saveSat();
        if (s.on) fetchSatellites().catch(() => {});
      });
      const sp = document.createElement("span");
      sp.textContent = state.lang === "ja" ? g.ja : g.en;
      sp.dataset.satGroup = g.key;
      lab.append(cb, sp);
      box.appendChild(lab);
    }
  }
  if (box)                               // per-group fetch date
    for (const g of s.groupMeta) {
      const sp = box.querySelector(`[data-sat-group="${g.key}"]`);
      if (!sp) continue;
      sp.textContent = (state.lang === "ja" ? g.ja : g.en) +
        (g.meta ? ` (${g.meta.count})` : "");
      sp.title = g.meta ? `${g.meta.fetched}` : t("ui.sat_not_downloaded");
    }
  const fetched = $("#sat-fetched");
  if (fetched) {
    const metas = s.groupMeta.filter((g) => g.meta &&
      s.groups.includes(g.key));
    fetched.textContent = metas.length
      ? `TLE: ${metas.map((g) => g.meta.fetched.slice(0, 16))
          .sort().slice(-1)[0]}Z (${s.loaded || 0})`
      : t("ui.sat_not_downloaded");
  }
  const ul = $("#sat-list");
  if (!ul) return;
  const now = satellitesNow().filter((x) => x.alt > 0)
    .sort((a, b) => b.alt - a.alt).slice(0, 12);
  ul.innerHTML = "";
  for (const x of now) {
    const li = document.createElement("li");
    li.className = "sat-row" + (x.lit ? "" : " sat-dark");
    li.tabIndex = 0;
    li.setAttribute("role", "button");
    li.innerHTML = `<span class="sat-name">${x.name}</span>` +
      `<span class="sat-num">${x.alt.toFixed(0)}° / ` +
      `${x.az.toFixed(0)}°${x.mag != null
        ? ` ${x.mag.toFixed(1)}m` : ""}</span>`;
    const go = () => loadSatPasses(x.norad, x.name);
    li.addEventListener("click", go);
    li.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); }
    });
    ul.appendChild(li);
  }
}

async function loadSatPasses(norad, name) {
  const box = $("#sat-passes");
  if (!box) return;
  box.innerHTML = `<div class="hint">${t("ui.loading")}</div>`;
  try {
    const d = await api("satellite_passes", {
      site: state.site, norad, days: 5, minalt: 10, visible: 1,
      time: new Date(simNow()).toISOString(),
    });
    if (!d.found || !d.passes.length) {
      box.innerHTML = `<b>${name}</b><div class="hint">` +
        `${t("ui.sat_no_pass")}</div>`;
      return;
    }
    const rows = d.passes.map((p) =>
      `<li class="ev-jump" data-t="${p.rise_utc}">` +
      `<span class="ev-time">${p.rise_local.slice(0, 16)}</span>` +
      `${t("ui.altitude")} ${p.max_alt.toFixed(0)}° ` +
      `${Math.round(p.duration_s / 60)}min` +
      `${p.mag != null ? ` ${p.mag.toFixed(1)}m` : ""} ` +
      `<span class="pop-dim">${p.rise_az.toFixed(0)}°→` +
      `${p.set_az.toFixed(0)}°</span></li>`)
      .join("");
    box.innerHTML = `<b>${d.name}</b><ul id="sat-pass-list">${rows}</ul>`;
    box.scrollIntoView({ block: "nearest" });
    box.querySelectorAll("li[data-t]").forEach((li) => {
      li.addEventListener("click", () => jumpToTime(li.dataset.t));
    });
  } catch (_) {
    box.innerHTML = `<div class="hint">${t("ui.update_failed")}</div>`;
  }
}

/* ---------------- 選択中の天体 (voice tab) --------------------------
 * The chart click that opens the popup also latches the object here, so
 * its rise / transit / set stays on screen while the sky is animated.
 * Alt/az is recomputed locally every ~0.5 s (same rigid LST rotation as
 * the chart); the rise/set line comes from /api/riseset and is refetched
 * only when the object, site or local date changes. */
function fmtRaDec(ra, dec) {
  const raH = ra / 15;
  const hh = Math.floor(raH), hm = Math.floor((raH - hh) * 60),
        hs = ((raH - hh) * 60 - hm) * 60;
  const sgn = dec < 0 ? "−" : "+";
  const ad = Math.abs(dec), dd = Math.floor(ad),
        dm = Math.floor((ad - dd) * 60);
  return `α ${hh}h${String(hm).padStart(2, "0")}m` +
    `${hs.toFixed(1)}s δ ${sgn}${dd}°${String(dm).padStart(2, "0")}′`;
}

function selectObject(h) {
  state.selected = h
    ? { kind: h.kind, name: h.name, key: h.key || "", id: h.id || "",
        ra: h.ra, dec: h.dec, vmag: h.vmag }
    : null;
  state.selectedRS = null;
  state._rsKey = null;
  renderSelected();
  if (state.selected) loadSelectedRiseSet().catch(() => {});
}

/* local (site tz) calendar date of the simulated instant — the rise/set
 * arc is computed for that day, so it is the cache key */
function simLocalDate() {
  const tz = (state.sky && state.sky.time && state.sky.time.tz) || "UTC";
  try {
    return simNow().toLocaleDateString("en-CA", { timeZone: tz });
  } catch (_) { return simNow().toISOString().slice(0, 10); }
}

let _rsInflight = null;
/* resolves once state.selectedRS holds the summary for the current
 * object/site/date; repeated calls share the one request */
function loadSelectedRiseSet() {
  const s = state.selected;
  if (!s) return Promise.resolve();
  const key = `${s.kind}|${s.name}|${state.site}|${state.lang}|` +
    simLocalDate();
  if (state._rsKey === key) return _rsInflight || Promise.resolve();
  state._rsKey = key;
  _rsInflight = api("riseset", {
    site: state.site, ra: s.ra, dec: s.dec, body: s.key || "",
    lang: state.lang, time: new Date(simNow()).toISOString(),
  }).then((rs) => {
    if (state._rsKey !== key) return;          // superseded meanwhile
    state.selectedRS = rs.summary;
    renderSelected();
  }, (e) => {
    if (state._rsKey === key) state._rsKey = null;   // allow a retry
    throw e;
  });
  return _rsInflight;
}

function renderSelected() {
  const box = $("#sel-obj");
  if (!box) return;
  const s = state.selected;
  const btn = $("#speak-selected");
  if (btn) btn.disabled = !s;
  if (!s) {
    box.innerHTML = `<span class="hint">${t("ui.select_hint")}</span>`;
    state.selectedVoice = "";
    return;
  }
  const parts = [`<b>${s.name}</b>`, fmtRaDec(s.ra, s.dec)];
  const voice = [s.name];
  if (state.sky) {
    const [az, alt] = altaz(s.ra, s.dec, currentLst(),
                            state.sky.site.lat_deg);
    parts.push(`${t("ui.azimuth")} ${az.toFixed(1)}° / ` +
      `${t("ui.altitude")} ${alt.toFixed(1)}°` +
      (alt < 0 ? ` <span class="pop-dim">(${t("ui.below_horizon")})</span>`
               : ""));
    const deg = state.lang === "ja" ? "度" : " degrees";
    voice.push(`${t("ui.azimuth")} ${az.toFixed(0)}${deg} ` +
      `${t("ui.altitude")} ${alt.toFixed(0)}${deg}`);
  }
  if (s.vmag != null) {
    parts.push(`${t("ui.magnitude")} ${(+s.vmag).toFixed(2)}`);
    voice.push(`${t("ui.magnitude")} ${(+s.vmag).toFixed(1)}`);
  }
  if (state.selectedRS) {
    parts.push(`<span class="sel-rs">${state.selectedRS}</span>`);
    voice.push(state.selectedRS.replace(/\//g, " "));
  }
  const f = state.view.follow;
  if (f && f.name === s.name)
    parts.push(`<span class="sel-follow">${t("ui.following")}` +
      ` <button id="sel-unfollow">${t("ui.follow_stop")}</button></span>`);
  else
    parts.push(`<button id="sel-center">🔎 ${t("ui.center_zoom")}</button>`);
  box.innerHTML = parts.join("<br>");
  const cb = box.querySelector("#sel-center");
  if (cb) cb.addEventListener("click", () => setFollow(s, zoomTargetFor(s)));
  const ub = box.querySelector("#sel-unfollow");
  if (ub) ub.addEventListener("click", () => setFollow(null));
  state.selectedVoice = voice.join(state.lang === "ja" ? "、" : ", ");
}

/* ---------------- 惑星拡大ビュー (planet close-up modal) ------------ */
/* Disk with phase shading (bright limb toward bright_limb_pa_deg),
 * Saturn's rings with correct front/back halves, Galilean/Saturnian
 * moon configuration.  Sky orientation: N up, E LEFT (no mirror). */
const PV_BODIES = new Set(["mercury", "venus", "mars", "jupiter",
                           "saturn", "uranus", "neptune", "moon"]);
const PV_PHASED = new Set(["mercury", "venus", "mars", "moon"]);
const PV_COLOR = {
  mercury: "#cfc4b4", venus: "#f4ead2", mars: "#e07850",
  jupiter: "#e8c9a0", saturn: "#e8d8a8", uranus: "#bfe4e4",
  neptune: "#7ea8ff", moon: "#d4d4cc",
};
let _pvTimer = null;

function openPlanetView(body) {
  const modal = $("#planet-modal");
  modal.hidden = false;
  state._pvBody = body;
  const refetch = async () => {
    try {
      const d = await api("planetview", {
        body, site: state.site, time: new Date(simNow()).toISOString() });
      if (!modal.hidden && state._pvBody === body) {
        state._pvData = d;
        drawPlanetView(d);
      }
    } catch (_) { /* keep last drawing */ }
  };
  $("#planet-modal-title").textContent = "";
  $("#planet-modal-info").textContent = t("ui.loading");
  state._pvZoom = 1;
  state._pvPan = { x: 0, y: 0 };
  state._pvHits = [];
  const mbox = $("#planet-modal-moon");
  if (mbox) { mbox.hidden = true; mbox.innerHTML = ""; }
  bindPlanetViewZoom();
  refetch();
  clearInterval(_pvTimer);
  _pvTimer = setInterval(refetch, 5000);   // follows the sim clock
}
/* Pinch (or wheel) to magnify the drawing.  The window is where a
 * planet is examined, so it has to be examinable — the moons of Jupiter
 * are a few pixels apart at the scale that fits Callisto in. */
function bindPlanetViewZoom() {
  const cv = $("#planet-canvas");
  if (!cv || cv.dataset.zoomBound) return;
  cv.dataset.zoomBound = "1";
  const redraw = () => { if (state._pvData) drawPlanetView(state._pvData); };
  const zoomBy = (f) => {
    const z0 = state._pvZoom || 1;
    const z = Math.max(0.5, Math.min(40, z0 * f));
    // the pan is in pixels, so it has to grow with the drawing or the
    // part being examined slides out of the window as it magnifies
    const p = state._pvPan || { x: 0, y: 0 };
    state._pvPan = { x: p.x * (z / z0), y: p.y * (z / z0) };
    state._pvZoom = z;
    redraw();
  };
  const panBy = (dx, dy) => {
    const p = state._pvPan || { x: 0, y: 0 };
    state._pvPan = { x: p.x + dx, y: p.y + dy };
    redraw();
  };
  cv.addEventListener("wheel", (e) => {
    e.preventDefault();
    zoomBy(e.deltaY < 0 ? 1.15 : 1 / 1.15);
  }, { passive: false });
  const pts = new Map();
  let d0 = 0, drag = null, moved = false;
  const scale = () => cv.width / cv.getBoundingClientRect().width;
  cv.addEventListener("pointerdown", (e) => {
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 1) {
      drag = { x: e.clientX, y: e.clientY, id: e.pointerId };
      moved = false;
      cv.setPointerCapture(e.pointerId);
    } else if (pts.size === 2) {
      drag = null;                       // a second finger means zoom
      const [a, b] = [...pts.values()];
      d0 = Math.hypot(a.x - b.x, a.y - b.y);
    }
  });
  cv.addEventListener("pointermove", (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 2 && d0 >= 20) {
      const [a, b] = [...pts.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (d >= 20) { zoomBy(d / d0); d0 = d; }
      return;
    }
    if (drag && e.pointerId === drag.id) {
      const k = scale();
      const dx = (e.clientX - drag.x) * k, dy = (e.clientY - drag.y) * k;
      if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
      drag.x = e.clientX; drag.y = e.clientY;
      panBy(dx, dy);
    }
  }, { passive: true });
  const drop = (e) => {
    pts.delete(e.pointerId);
    if (pts.size < 2) d0 = 0;
    if (drag && e.pointerId === drag.id) drag = null;
  };
  cv.addEventListener("pointerup", drop);
  cv.addEventListener("pointercancel", drop);
  // a tap that did not drag: name the moon under it
  cv.addEventListener("click", (e) => {
    if (moved) { moved = false; return; }
    const r = cv.getBoundingClientRect();
    const k = scale();
    const x = (e.clientX - r.left) * k, y = (e.clientY - r.top) * k;
    let best = null, bd = 18 * k;
    for (const h of state._pvHits || []) {
      const dd = Math.hypot(h.x - x, h.y - y);
      if (dd < bd) { bd = dd; best = h; }
    }
    const box = $("#planet-modal-moon");
    if (!best) { box.hidden = true; return; }
    box.innerHTML = moonCardHtml(best.moon, state._pvData);
    box.hidden = false;
  });
}

function closePlanetView() {
  $("#planet-modal").hidden = true;
  clearInterval(_pvTimer);
  _pvTimer = null;
}

/* What is known about one moon of the planet being examined. */
function moonCardHtml(m, d) {
  const name = state.lang === "ja" ? (m.name_ja || m.name) : m.name;
  const p = m.phys || {};
  const n = (v, k) => (v == null ? "-" : (+v).toFixed(k));
  const sep = (m.dx_arcsec == null) ? null
    : Math.hypot(m.dx_arcsec, m.dy_arcsec);
  const rows = [];
  const add = (k, v) => rows.push(`<tr><td>${esc(k)}</td><td>${v}</td></tr>`);
  if (sep != null) add(t("ui.pv_separation"), `${n(sep, 2)}″`);
  add(t("ui.pv_side"), t(m.front ? "ui.pv_front" : "ui.pv_behind"));
  if (p.radius_km != null)
    add(t("ui.pv_radius"), `${p.radius_km.toLocaleString()} km ` +
      `<span class="pop-dim">(⌀ ${(p.radius_km * 2).toLocaleString()} km)</span>`);
  if (p.a_km != null)
    add(t("ui.pv_orbit_radius"),
        `${p.a_km.toLocaleString()} km` +
        (d && d.orbit && d.orbit.radius_km
          ? ` <span class="pop-dim">(${n(p.a_km / d.orbit.radius_km, 1)} ` +
            `${esc(t("ui.pv_planet_radii"))})</span>` : ""));
  if (p.period_d != null)
    add(t("ui.pv_period"), p.period_d < 1
      ? `${n(p.period_d * 24, 2)} ${t("ui.hours")}`
      : `${n(p.period_d, 3)} ${t("ui.days")}`);
  return `<b>${esc(name)}</b><table class="pv-table">${
    rows.join("")}</table>`;
}

/* What the window is showing, in words: where the body is now and what
 * orbit it is on.  The distances are the ones an observer reaches for —
 * how far away it is from here, and from the Sun. */
function planetViewInfoHtml(d) {
  const km = (au) => (au * 149597870.7);
  const n = (v, k) => (v == null ? "-" : (+v).toFixed(k));
  const rows = [];
  const add = (k, v) => rows.push(
    `<tr><td>${esc(k)}</td><td>${v}</td></tr>`);
  add(t("ui.diameter"), `${d.diameter_arcsec}″`);
  if (d.magnitude != null) add(t("ui.magnitude"), d.magnitude);
  add(t("ui.illumination"),
      `${Math.round(d.illuminated_fraction * 100)}%`);
  add(t("ui.phase_angle"), `${n(d.phase_angle_deg, 1)}°`);
  // distance: astronomical units for a planet, kilometres for the Moon,
  // because that is the unit each is talked about in
  if (d.body === "moon") {
    add(t("ui.pv_geo"), `${Math.round(km(d.delta_au)).toLocaleString()} km`);
    if (d.moon)
      add(t("ui.moon_distance"),
          `${Math.round(d.moon.distance_km).toLocaleString()} km`);
  } else {
    add(t("ui.pv_geo"), `${n(d.delta_au, 4)} au`);
  }
  add(t("ui.pv_helio"), `${n(d.r_sun_au, 4)} au`);
  if (d.elong_deg != null)
    add(t("ui.elongation"), `${n(d.elong_deg, 1)}° ` +
      (d.elong_side === "E" ? t("ui.evening")
        : d.elong_side === "W" ? t("ui.morning") : ""));
  add(`${t("ui.azimuth")} / ${t("ui.altitude")}`,
      `${n(d.az, 1)}° / ${n(d.alt, 1)}°`);
  if (d.moon) {
    add(t("ui.pv_moon_age"), `${n(d.moon.age_days, 1)} d`);
    add(t("ui.pv_phase"), esc(d.moon.phase_name));
    if ((d.moon.titles || []).length)
      add(t("ui.pv_moon_title"),
          `<b>${esc(d.moon.titles.join(state.lang === "ja" ? "・" : " · "))}`
          + "</b>");
  }
  const o = d.orient;
  if (o) {
    add(d.body === "moon" ? t("ui.pv_libration") : t("ui.sub_observer"),
        `${n(o.lon, 2)}° / ${n(o.lat, 2)}°`);
    if (o.sub_solar_lon != null)
      add(t("ui.pv_subsolar"),
          `${n(o.sub_solar_lon, 2)}° / ${n(o.sub_solar_lat, 2)}°`);
    if (o.pa != null) add(t("ui.pv_pole_pa"), `${n(o.pa, 1)}°`);
  }
  const orb = d.orbit;
  if (orb) {
    rows.push(`<tr><td colspan="2" class="pv-sec">${
      esc(t("ui.pv_orbit"))}</td></tr>`);
    add(t("ui.pv_semimajor"), `${n(orb.a_au, 5)} au`);
    add(t("ui.pv_ecc"), n(orb.e, 4));
    add(t("ui.pv_incl"), `${n(orb.incl_deg, 3)}°`);
    add(t("ui.pv_period"),
        orb.period_yr < 1 ? `${n(orb.period_yr * 365.25, 2)} d`
                          : `${n(orb.period_yr, 3)} ${t("ui.years")}`);
    add(t("ui.pv_radius"), `${orb.radius_km.toLocaleString()} km`);
  }
  return `<table class="pv-table">${rows.join("")}</table>` +
    `<div class="pv-time">${esc(d.time_utc.replace("T", " "))} ` +
    `${esc(t("ui.ut"))}</div>`;
}

function drawPlanetView(d) {
  const name = state.lang === "ja" ? d.name_ja : d.name_en;
  $("#planet-modal-title").textContent = name;
  $("#planet-modal-info").innerHTML = planetViewInfoHtml(d);

  const cv = $("#planet-canvas");
  const c = cv.getContext("2d");
  const S = cv.width;
  const pan = state._pvPan || { x: 0, y: 0 };
  const cx = S / 2 + pan.x, cy = S / 2 + pan.y;
  state._pvHits = [];
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.fillStyle = "#05070d";
  c.fillRect(0, 0, S, S);

  // px per planet equatorial radius: fit the moon system / ring / disk.
  // Saturn: fit out to Titan (~20 R) but let Hyperion/Iapetus fall off
  // the canvas, otherwise the disk shrinks to a dot.
  const rCap = d.body === "saturn" ? 17 : 28;
  let maxR = d.ring ? 2.6 : 1.35;
  for (const m of d.moons) {
    const r = Math.max(Math.abs(m.dx_radii), Math.abs(m.dy_radii));
    if (r <= rCap) maxR = Math.max(maxR, r + 1.2);
  }
  const scale = (S / 2 - 28) / maxR * (state._pvZoom || 1);
  const R = scale;                              // disk radius px
  // sky orientation N up E left: x = -dx (east), y = -dy (north)
  const sx = (m) => cx - m.dx_radii * scale;
  const sy = (m) => cy - m.dy_radii * scale;
  const moonCol = (front) => front ? "#fff8e0" : "#cfd4dc";

  for (const m of d.moons)
    state._pvHits.push({ x: sx(m), y: sy(m), moon: m });

  // --- moons behind the planet plane first
  for (const m of d.moons) if (!m.front) {
    c.fillStyle = moonCol(false);
    c.beginPath(); c.arc(sx(m), sy(m), 3, 0, 7); c.fill();
  }

  // --- Saturn rings: back half, then disk, then front half
  let ringRot = 0, ringFrontSign = 1, ringB = 0;
  const drawRingHalf = (front) => {
    const open = Math.max(0.04, Math.abs(Math.sin(ringB * D2R)));
    c.save();
    c.translate(cx, cy);
    c.rotate(ringRot);
    // clip to the half-plane: front half lies toward -pole if b>0
    c.beginPath();
    const big = S;
    if (front === (ringFrontSign > 0)) c.rect(-big, 0, 2 * big, big);
    else c.rect(-big, -big, 2 * big, big);
    c.clip();
    c.fillStyle = "rgba(216,196,150,0.85)";
    c.beginPath();
    c.ellipse(0, 0, 2.27 * R, 2.27 * R * open, 0, 0, 7);
    c.ellipse(0, 0, 1.53 * R, 1.53 * R * open, 0, 0, 7);
    c.fill("evenodd");
    c.strokeStyle = "rgba(40,32,16,0.6)";       // Cassini division
    c.lineWidth = 1.5;
    c.beginPath();
    c.ellipse(0, 0, 1.95 * R, 1.95 * R * open, 0, 0, 7);
    c.stroke();
    c.restore();
  };
  if (d.ring) {
    ringB = d.ring.b_deg;
    const pa = d.ring.pole_pa_deg * D2R;
    // pole on screen (N up, E left): (-sin PA, -cos PA); ring major
    // axis is perpendicular to it
    ringRot = Math.atan2(-Math.cos(pa), -Math.sin(pa)) + Math.PI / 2;
    // in the rotated frame the pole is local (0,-1); the NEAR ring arm
    // is on the hemisphere opposite the visible pole face
    ringFrontSign = ringB > 0 ? 1 : -1;
    drawRingHalf(false);
  }

  // --- planet disk: the real surface map when one is available, else
  // the schematic disk (flat colour + Jupiter's two belts)
  let textured = false;
  if (d.orient && textureFor(d.body)) {
    const sun = d.phase_angle_deg > 0.05
      ? sunDirInDiskFrame(d.phase_angle_deg, d.bright_limb_pa_deg,
                          d.orient.pa)
      : null;
    const Rs = Math.max(4, Math.round(Math.min(R,
      DISK_SPRITE_PX_STILL)));
    const sprite = diskSprite(d.body, Rs,
                              { lon: d.orient.lon, lat: d.orient.lat }, sun);
    // modal orientation is N up, E left: a PA psi is (-sin psi, -cos psi)
    const pa = d.orient.pa * D2R;
    const pole = [-Math.sin(pa), -Math.cos(pa)];
    const ea = pa - Math.PI / 2;
    const eDir = [-Math.sin(ea), -Math.cos(ea)];
    const k = R / Rs;
    c.save();
    c.translate(cx, cy);
    c.transform(eDir[0] * k, eDir[1] * k, -pole[0] * k, -pole[1] * k, 0, 0);
    c.drawImage(sprite, -Rs, -Rs);
    c.restore();
    textured = true;
  } else {
    const lit = PV_COLOR[d.body] || "#d0d8e8";
    c.fillStyle = lit;
    c.beginPath(); c.arc(cx, cy, R, 0, 7); c.fill();
    if (d.body === "jupiter") {                // two faint belts
      c.save();
      c.beginPath(); c.arc(cx, cy, R, 0, 7); c.clip();
      c.fillStyle = "rgba(150,100,60,0.35)";
      c.fillRect(cx - R, cy - 0.42 * R, 2 * R, 0.22 * R);
      c.fillRect(cx + -R, cy + 0.20 * R, 2 * R, 0.22 * R);
      c.restore();
    }
  }

  // --- phase shading: only for the schematic disk; the textured sprite
  // already carries its own terminator
  if (!textured && PV_PHASED.has(d.body) &&
      d.illuminated_fraction < 0.995) {
    const k = Math.max(0, Math.min(1, d.illuminated_fraction));
    const chi = d.bright_limb_pa_deg * D2R;
    // bright-limb direction on screen: sin(chi)*E + cos(chi)*N
    //   = (-sin chi, -cos chi); rotate so it points along +x
    const ang = Math.atan2(-Math.cos(chi), -Math.sin(chi));
    c.save();
    c.translate(cx, cy);
    c.rotate(ang);
    const xt = R * (1 - 2 * k);       // terminator crossing (+x = bright)
    c.beginPath();
    c.moveTo(0, -R);
    c.arc(0, 0, R, -Math.PI / 2, Math.PI / 2, true);  // dark-limb half
    if (Math.abs(xt) > 0.5) {
      // terminator half-ellipse through (xt, 0)
      if (xt < 0)
        c.ellipse(0, 0, -xt, R, 0, Math.PI / 2, 3 * Math.PI / 2, false);
      else
        c.ellipse(0, 0, xt, R, 0, Math.PI / 2, -Math.PI / 2, true);
    }
    c.closePath();
    c.fillStyle = "rgba(6,8,16,0.93)";
    c.fill();
    c.restore();
  }

  if (d.ring) drawRingHalf(true);

  // --- moons in front (transiting ones show ON the disk, lighter)
  c.font = "10px sans-serif";
  c.textAlign = "left"; c.textBaseline = "middle";
  for (const m of d.moons) if (m.front) {
    c.fillStyle = moonCol(true);
    c.beginPath(); c.arc(sx(m), sy(m), 3, 0, 7); c.fill();
    c.strokeStyle = "rgba(0,0,0,0.5)";
    c.lineWidth = 0.8;
    c.stroke();
  }
  // labels for every moon inside the canvas
  c.fillStyle = "#9fb4d8";
  for (const m of d.moons) {
    const x = sx(m), y = sy(m);
    if (x < -10 || x > S + 10 || y < -10 || y > S + 10) continue;
    c.fillText(state.lang === "ja" ? m.name_ja : m.name, x + 5, y - 6);
  }

  // --- orientation indicator: N up, E left
  c.strokeStyle = c.fillStyle = "#6ea8ff";
  c.lineWidth = 1.4;
  const ox = S - 30, oy = 34;
  c.beginPath();
  c.moveTo(ox, oy); c.lineTo(ox, oy - 18);
  c.moveTo(ox - 4, oy - 13); c.lineTo(ox, oy - 18);
  c.lineTo(ox + 4, oy - 13);
  c.moveTo(ox, oy); c.lineTo(ox - 18, oy);
  c.stroke();
  c.font = "11px sans-serif";
  c.textAlign = "center";
  c.fillText("N", ox, oy - 24);
  c.fillText("E", ox - 24, oy + 1);
}

/* ---------------- interactions ---------------- */
function updatePlayButtons() {
  const fwd = state.playing && state.playDir === 1;
  const back = state.playing && state.playDir === -1;
  $("#t-play").textContent = fwd ? "⏸" : "▶";
  $("#t-back").textContent = back ? "⏸" : "◀";
  $("#t-play").classList.toggle("active", fwd);
  $("#t-back").classList.toggle("active", back);
}

/* show one panel tab (also called from the chart popups) */
/* Open a tab *and* make sure it can be seen.  On a phone the panel is a
 * sheet over the chart: switching the tab underneath a closed sheet
 * changes nothing on screen, which is why "次の可視パス" looked as if it
 * did nothing at all.  `focus` is scrolled into view once the tab is up. */
function showPanelTab(name, focus) {
  openTab(name);
  const panel = $("#panel");
  if (getComputedStyle(panel).position === "fixed")
    document.body.classList.add("panel-open");
  const tog = $("#panel-toggle");
  if (tog) tog.setAttribute("aria-expanded", "true");
  panel.scrollTop = 0;
  if (focus) requestAnimationFrame(() => {
    const el = $(focus);
    if (el) el.scrollIntoView({ block: "nearest" });
  });
}

function openTab(name) {
  $$(".tab").forEach((x) => x.classList.toggle("active",
                                               x.dataset.tab === name));
  $$(".tabpage").forEach((x) => x.classList.remove("active"));
  const page = $(`#tab-${name}`);
  if (page) page.classList.add("active");
  if (name === "bodies" && !state._sbLoaded)
    loadSBList().catch(() => {
      $("#sb-msg").textContent = t("ui.update_failed");
    });
}

function bind() {
  // tabs
  $$(".tab").forEach((b) => b.addEventListener(
    "click", () => openTab(b.dataset.tab)));
  // phone layout: the panel is a sheet over the chart, so it needs a
  // way back out.  Tapping the chart closes it — on a phone the chart
  // is what the app is for, and a half-covered sky is not usable.
  if (/[?&]bench=1\b/.test(location.search))
    setTimeout(() => runBenchmark().catch((e) => console.log("BENCH", e)),
               1500);

  // one press: fetch the elements if needed, switch the layer on, and
  // show what it did
  $("#shower-select").addEventListener("change", async (e) => {
    const code = e.target.value;
    if (!code) { applyShower(null); return; }
    const list = await loadShowers().catch(() => []);
    applyShower(list.find((x) => x.code === code) || null);
  });
  $("#shower-btn").addEventListener("click", async () => {
    const b = $("#shower-btn");
    if ((state.showersOn || []).length) { applyShower(null); return; }
    b.disabled = true;
    try {
      // whatever is active on the date being displayed — the clock is
      // left alone, because the observer is looking at that sky
      const list = await loadShowers();
      const live = list.filter((x) => x.active);
      if (!live.length) {
        const next = list[0];
        toast(next
          ? `${t("ui.shower_none_now")}（${showerName(next)} ` +
            `${(next.peak_local || "").slice(5, 16)}）`
          : t("ui.shower_none_now"));
        return;
      }
      const ordered = showersByProximity(live);
      setMeteorShowers(ordered);
      const det = $("#shower-detail");
      if (det) det.innerHTML = ordered.map(showerDetailHtml).join("<hr>");
      const sel = $("#shower-select");
      if (sel) sel.value = ordered[0].code;
      syncShowerButton();
      toast(ordered.map(showerName).join(state.lang === "ja" ? "・" : ", "));
    } catch (_) {
      toast(t("ui.update_failed"));
    } finally {
      b.disabled = false;
    }
  });
  $("#comet-btn").addEventListener("click", async () => {
    const b = $("#comet-btn");
    if (selectedComets().length) {      // pressing it again puts them away
      state.selectedSB = state.selectedSB.filter((o) => o.kind !== "comet");
      saveSB();
      renderSBSelected(); renderSBList(); renderSBBright();
      syncCometButton();
      await fetchSky().catch(() => {});
      return;
    }
    b.disabled = true;
    try {
      const n = await showBrightComets($("#sb-msg"));
      toast(n ? t("ui.comet_shown", { n, mag: COMET_MAG_LIMIT })
              : t("ui.comet_none", { mag: COMET_MAG_LIMIT }));
    } catch (_) {
      toast(t("ui.update_failed"));
    } finally {
      b.disabled = false;
    }
  });
  $("#sat-btn").addEventListener("click", async () => {
    const b = $("#sat-btn");
    if (state.sat.on) {            // pressing it again puts them away
      state.sat.on = false;
      const cb = $("#opt-satellites");
      if (cb) cb.checked = false;
      saveSat();
      syncSatButton();
      return;
    }
    b.disabled = true;
    try {
      await enableSatellites($("#sat-msg"));
      toast(t("ui.sat_updated", { n: state.sat.loaded || 0 }));
    } catch (_) {
      toast(t("ui.update_failed"));
    } finally {
      b.disabled = false;
      syncSatButton();
    }
  });

  // the 情報 button reaches the panel from the chart, which on a phone
  // is otherwise two taps away behind the sheet
  $("#info-btn").addEventListener("click", () => showPanelTab("info"));
  $("#events-btn").addEventListener("click", () => showPanelTab("events"));

  // --- 経緯線: a small menu of the four grids, opening upwards from the
  // bar it sits in
  const gridPop = $("#grid-pop");
  const gridOpen = (open) => {
    if (open) {
      // placed against the viewport: the bar scrolls, and a child of a
      // scrolling box cannot escape it
      const r = $("#grid-btn").getBoundingClientRect();
      gridPop.hidden = false;
      gridPop.style.left = "0px";
      gridPop.style.bottom = `${Math.round(window.innerHeight - r.top + 6)}px`;
      const w = gridPop.getBoundingClientRect().width;
      const x = Math.min(Math.max(6, r.left),
                         document.documentElement.clientWidth - w - 6);
      gridPop.style.left = `${Math.round(x)}px`;
    } else {
      gridPop.hidden = true;
    }
    $("#grid-btn").setAttribute("aria-expanded", String(open));
  };
  $("#grid-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    gridOpen(gridPop.hidden);
  });
  gridPop.addEventListener("click", (e) => e.stopPropagation());
  document.addEventListener("click", () => gridOpen(false));
  for (const k of GRID_OPTS) {
    const el = $(`#qg-${k}`);
    if (!el) continue;
    el.addEventListener("change", () => {
      state.opts[k] = el.checked;
      saveOpts();
      syncViewOptionUI();          // the panel's copy of the same switch
    });
  }

  $("#credits-box").addEventListener("toggle", () => {
    if ($("#credits-box").open) renderCredits().catch(() => {});
  });

  // --- quick display controls (phone layout)
  // The same options as the panel, repeated where a thumb can reach
  // them; both directions have to stay in step, so every path goes
  // through syncViewOptionUI()/syncQuickBar() rather than setting one
  // widget from the other.
  const qbMag = $("#qb-maglimit");
  if (qbMag) {
    qbMag.addEventListener("input", () => {
      state.opts.maglimit = parseFloat(qbMag.value);
      syncViewOptionUI();
      saveOpts();
      scheduleFetchSky();
    });
    $$("#qb-toggles button[data-opt]").forEach((b) => {
      b.addEventListener("click", () => {
        const id = b.dataset.opt;
        state.opts[id] = !state.opts[id];
        if (id === "conart" && state.opts.conart) loadConstellationArt();
        if (id === "milkyway" && state.opts.milkyway) loadMilkyway();
        syncViewOptionUI();
        saveOpts();
      });
    });
  }

  syncQuickBar();

  const panelToggle = $("#panel-toggle");
  const setPanel = (open) => {
    document.body.classList.toggle("panel-open", open);
    panelToggle.setAttribute("aria-expanded", String(open));
  };
  panelToggle.addEventListener("click", () => {
    setPanel(!document.body.classList.contains("panel-open"));
  });

  // Drag the sheet down to dismiss it.  A sheet that can only be closed
  // by the button it was opened with is a sheet you have to aim at; on
  // a phone the gesture is the obvious way out.  The drag starts on the
  // grab handle or on the tab strip, or anywhere once the sheet is
  // scrolled to its top — otherwise it would fight the panel's own
  // scrolling.
  const panel = $("#panel");
  let sheet = null;
  const sheetIsOverlay = () =>
    getComputedStyle(panel).position === "fixed";
  panel.addEventListener("pointerdown", (e) => {
    if (!document.body.classList.contains("panel-open")) return;
    if (!sheetIsOverlay()) return;
    const onHandle = e.target.closest("#panel-grab, #tabs");
    if (!onHandle && panel.scrollTop > 0) return;
    sheet = { y0: e.clientY, dy: 0, t0: performance.now(),
              id: e.pointerId, handle: !!onHandle };
    panel.style.transition = "none";
  });
  panel.addEventListener("pointermove", (e) => {
    if (!sheet || e.pointerId !== sheet.id) return;
    const dy = e.clientY - sheet.y0;
    if (dy <= 0) { sheet.dy = 0; panel.style.transform = ""; return; }
    // a pull upward from the handle should not scroll the sheet either
    if (sheet.handle) e.preventDefault();
    sheet.dy = dy;
    panel.style.transform = `translateY(${dy}px)`;
  }, { passive: false });
  const endSheet = (e) => {
    if (!sheet || (e && e.pointerId !== sheet.id)) return;
    const { dy, t0 } = sheet;
    sheet = null;
    panel.style.transition = "";
    panel.style.transform = "";
    const v = dy / Math.max(1, performance.now() - t0);   // px per ms
    // far enough, or thrown hard enough to mean it
    if (dy > panel.getBoundingClientRect().height * 0.25 || v > 0.6)
      setPanel(false);
  };
  panel.addEventListener("pointerup", endSheet);
  panel.addEventListener("pointercancel", endSheet);
  canvas.addEventListener("pointerdown", () => {
    if (document.body.classList.contains("panel-open")) setPanel(false);
  });
  // view options
  for (const id of VIEW_OPT_IDS) {
    const el = $(`#opt-${id}`);
    el.checked = state.opts[id];
    el.addEventListener("change", () => {
      state.opts[id] = el.checked;
      if (id === "conart" && el.checked) loadConstellationArt();
      saveOpts();
      if (id === "milkyway" && el.checked) loadMilkyway();
      if (id === "trails") resetTrails();
      syncQuickBar();               // the phone's copy of these controls
    });
  }
  // 写野角 (FOV) frames
  $("#fov-add").addEventListener("click", () => {
    const rd = screenToRaDec(canvas.width / 2, canvas.height / 2);
    const fr = {
      id: "f" + Date.now().toString(36) +
          Math.floor(Math.random() * 1e4).toString(36),
      enabled: true, preset: "ff50", rotation: 0,
      ra: rd ? rd.ra : 0, dec: rd ? rd.dec : 0,
      custom: { kind: "rect", w: 36, h: 24, f: 50, afov: 52, mag: 40 },
    };
    state.fovFrames.push(fr);
    state.fovSelected = fr.id;
    $("#fov-box").open = true;
    saveFov();
    renderFOVList();
  });
  const ml = $("#opt-maglimit");
  ml.value = state.opts.maglimit;
  $("#maglimit-out").textContent = state.opts.maglimit;
  ml.addEventListener("input", () => {
    state.opts.maglimit = parseFloat(ml.value);
    $("#maglimit-out").textContent = ml.value;
    saveOpts();
    updateHints();
    syncQuickBar();
  });
  // export
  $("#demo-btn").addEventListener("click", async () => {
    if (state.demo) { stopDemo(true); return; }
    // the tour wants the shower calendar and a station pass; both are
    // fetched rather than assumed, because a fresh install has neither
    await loadShowers().catch(() => {});
    await ensureDemoPass().catch(() => {});
    startDemo();
  });
  $("#rec-btn").addEventListener("click", () => {
    if (state.rec) stopRecording();
    else startRecording(!!state.demo);   // a demo recording self-terminates
  });
  $("#export-png").addEventListener("click", exportPNG);
  $("#export-pdf").addEventListener("click", exportPDF);
  // language
  $("#lang-toggle").addEventListener("click",
    () => setLanguage(state.lang === "ja" ? "en" : "ja"));
  // night vision
  const applyNv = () => document.body.classList.toggle("nv", state.nv);
  applyNv();
  $("#nv-toggle").addEventListener("click", () => {
    state.nv = !state.nv; localStorage.setItem("nv", state.nv ? "1" : "0");
    applyNv();
  });
  // site: category menu drives the site menu
  $("#site-group").addEventListener("change", async (e) => {
    await loadSiteGroup(e.target.value);
  });
  $("#site-region").addEventListener("change",
    (e) => showRegion(e.target.value));
  $("#site-select").addEventListener("change", async (e) => {
    state.site = e.target.value;
    localStorage.setItem("site", state.site);
    resetTrails();
    await Promise.all([fetchSky(), refreshInfo(), refreshEvents(),
                       loadHorizonMask()]);
    // the maxima are reported in the site's own clock, and the radiant
    // altitudes are its own too: solve them again for the new place
    await refreshShowersForSite();
  });
  // 観測地の手動入力: the app must be fully usable with location
  // services refused, so any position can be typed in directly
  const msMsg = (text, bad) => {
    const el = $("#ms-msg");
    el.textContent = text;
    el.style.color = bad ? "#ff8080" : "";
  };
  const applyManualSite = async (lat, lon, elev) => {
    if (!(isFinite(lat) && isFinite(lon)) ||
        Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      msMsg(t("ui.manual_site_bad"), true);
      return false;
    }
    state.site = customSiteSpec(lat, lon, isFinite(elev) ? elev : 0);
    localStorage.setItem("site", state.site);
    await loadSites("");
    $("#site-select").value = state.site;
    msMsg(t("ui.manual_site_set", { name: customSiteLabel(state.site) }));
    resetTrails();
    await Promise.all([fetchSky(), refreshInfo(), refreshEvents(),
                       loadHorizonMask()]).catch(() => {});
    return true;
  };
  $("#ms-apply").addEventListener("click", () => {
    applyManualSite(parseFloat($("#ms-lat").value),
                    parseFloat($("#ms-lon").value),
                    parseFloat($("#ms-elev").value));
  });
  $("#ms-gps").addEventListener("click", async () => {
    msMsg(t("ui.gps_locating"));
    try {
      const p = await getPosition();
      $("#ms-lat").value = p.lat.toFixed(4);
      $("#ms-lon").value = p.lon.toFixed(4);
      if (p.alt != null) $("#ms-elev").value = Math.round(p.alt);
      msMsg("");
    } catch (e) {
      msMsg(`${t("ui.gps_denied")} (${String(e.message).slice(0, 60)})`, true);
    }
  });

  // 現在地 (GPS): use the position itself, and name the nearest site
  $("#gps-btn").addEventListener("click", async () => {
    toast(t("ui.gps_locating"));
    let p;
    try {
      p = await getPosition();
    } catch (e) {
      toast(`${t("ui.gps_denied")} (${String(e.message).slice(0, 60)})`);
      return;
    }
    {
      const latitude = p.lat, longitude = p.lon, altitude = p.alt;
      // the observer's own position, not the nearest listed one: an
      // observing site 30 km away is a different sky at the horizon
      const ok = await applyManualSite(latitude, longitude,
                                       altitude == null ? 0 : altitude);
      if (!ok) return;
      $("#ms-lat").value = latitude.toFixed(4);
      $("#ms-lon").value = longitude.toFixed(4);
      let best = null, bd = Infinity;
      for (const s of state.sites) {
        const d = haversineKm(latitude, longitude, s.lat_deg, s.lon_deg);
        if (d < bd) { bd = d; best = s; }
      }
      toast(best ? t("ui.nearest_site", {
        name: state.lang === "ja" ? best.name_ja : best.name_en,
        km: bd < 10 ? bd.toFixed(1) : Math.round(bd) })
        : customSiteLabel(state.site));
    }
  });
  // time controls
  $("#t-now").addEventListener("click", async () => {
    state.simOffsetMs = 0; state.playing = false;
    updatePlayButtons();
    resetTrails();
    await fetchSky();
  });
  $$(".t-step").forEach((b) => b.addEventListener("click", async () => {
    state.simOffsetMs += parseFloat(b.dataset.step) * 60e3;
    resetTrails();
    await fetchSky();
  }));
  // ▶/◀ are exclusive: pressing one stops the other; pressing the
  // active one pauses (speed selector stays a magnitude)
  $("#t-play").addEventListener("click", () => {
    if (state.playing && state.playDir === 1) state.playing = false;
    else { state.playing = true; state.playDir = 1; }
    updatePlayButtons();
  });
  $("#t-back").addEventListener("click", () => {
    if (state.playing && state.playDir === -1) state.playing = false;
    else { state.playing = true; state.playDir = -1; }
    updatePlayButtons();
  });
  $("#t-back").title = t("ui.play_back");
  $("#t-speed").addEventListener("change",
    (e) => { state.speed = parseFloat(e.target.value); });
  $("#t-input").addEventListener("change", async (e) => {
    const d = new Date(e.target.value);
    if (!isNaN(d)) {
      state.simOffsetMs = d - new Date();
      resetTrails();
      await fetchSky();
    }
  });
  // view mode: pressing either button is the user taking the wheel, so
  // it ends a running tour first — a demo scene re-applies its zoom on
  // every frame, and would otherwise pull the magnified Moon or planet
  // straight back over the whole-sky view that was just asked for.
  for (const mode of ["allsky", "horizon"])
    $(`#view-${mode}`).addEventListener("click", () => {
      if (state.demo) stopDemo(false);
      setViewMode(mode);
    });
  $("#az-center").addEventListener("change",
    (e) => { state.view.azCenter = parseFloat(e.target.value);
             resetTrails(); });
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    resetTrails();
    const rect = canvas.getBoundingClientRect();
    zoomBy(e.deltaY < 0 ? 1 / 1.15 : 1.15,
           (e.clientX - rect.left) * devicePixelRatio,
           (e.clientY - rect.top) * devicePixelRatio);
  }, { passive: false });

  // --- canvas drag
  // horizon mode: pan.
  // all-sky mode: plain drag = DIURNAL ROTATION about the celestial
  //   pole (NCP for northern sites, SCP for southern) — the planisphere
  //   gesture: the sky dial turns with the pointer and the simulated
  //   time follows; SHIFT+drag = pan the view center.
  let drag = null;

  // angle of a screen point around the celestial pole's screen image
  function _poleAngleSetup(e) {
    const W = canvas.width, H = canvas.height;
    const dpr = devicePixelRatio;
    const lat = state.sky ? state.sky.site.lat_deg : 35;
    const paz = lat >= 0 ? 0 : 180;      // NCP due north / SCP due south
    const palt = Math.abs(lat);
    const pp = projectRaw(paz, palt, W, H);
    const pole = [pp[0] / dpr, pp[1] / dpr];
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    // probe star: the sky point under the cursor (fallback: a point on
    // the meridian 40° from the pole) — used to measure, numerically,
    // how the on-screen angle around the pole responds to LST, so the
    // rotation direction/rate is exact for any hemisphere, mirror
    // setting and pan center.
    let probe = screenToRaDec(mx * dpr, my * dpr);
    if (!probe || Math.hypot(mx - pole[0], my - pole[1]) < 25) {
      const fb = { az: paz, alt: Math.max(palt - 40, 2) };
      // convert the fallback az/alt to ra/dec (inverse of altaz())
      const lst = currentLst(), la = lat * D2R;
      const A = (fb.az - 180) * D2R, al = fb.alt * D2R;
      const sd = Math.sin(la) * Math.sin(al) -
        Math.cos(la) * Math.cos(al) * Math.cos(A);
      const dec = Math.asin(Math.max(-1, Math.min(1, sd))) / D2R;
      const ha = Math.atan2(Math.sin(A), Math.cos(A) * Math.sin(la) +
        Math.tan(al) * Math.cos(la)) / D2R;
      probe = { ra: ((lst * 15 - ha) % 360 + 360) % 360, dec };
    }
    const theta = (lstH) => {
      const aa = altaz(probe.ra, probe.dec, lstH, lat);
      const q = projectRaw(aa[0], aa[1], W, H);
      return Math.atan2(q[1] / dpr - pole[1], q[0] / dpr - pole[0]);
    };
    const L0 = currentLst();
    const dH = 0.4;                       // probe step: 0.4 sidereal h
    let dth = theta(L0 + dH) - theta(L0);
    dth = ((dth + Math.PI * 3) % (Math.PI * 2)) - Math.PI;   // wrap
    return { pole,
             mouseAngle: (x, y) => Math.atan2(y - pole[1], x - pole[0]),
             radPerLstHour: dth / dH };
  }

  canvas.addEventListener("pointerdown", (e) => {
    // a FOV corner grabbed: rotate the frame instead of panning
    const rect0 = canvas.getBoundingClientRect();
    const hx = (e.clientX - rect0.left) * devicePixelRatio;
    const hy = (e.clientY - rect0.top) * devicePixelRatio;
    const h = fovHandleAt(hx, hy, devicePixelRatio);
    if (h) {
      const fr = state.fovFrames.find((x) => x.id === h.id);
      const ctr = state.fovHandles.find((x) => x.id === h.id);
      if (fr && ctr && ctr.cx != null) {
        state.fovSelected = fr.id;
        renderFOVList();
        // corner = rotate, centre = drag the frame to a new position
        // (a centre press that does not move is a click -> zoom to it)
        drag = h.kind === "corner"
          ? { fovRot: { fr, cx: ctr.cx, cy: ctr.cy,
                        a0: Math.atan2(hy - ctr.cy, hx - ctr.cx),
                        rot0: fr.rotation || 0 } }
          : { fovMove: { fr } };
        drag.x0 = e.clientX; drag.y0 = e.clientY; drag.moved = false;
        state._dragging = true;
        canvas.setPointerCapture(e.pointerId);
        return;
      }
    }
    drag = { x0: e.clientX, y0: e.clientY, moved: false,
             az0: state.view.azCenter, alt0: state.view.altOffset,
             caz: state.view.allskyCenter.az,
             calt: state.view.allskyCenter.alt,
             shift: e.shiftKey, off0: state.simOffsetMs,
             rot: null, cum: 0, prevA: null };
    if (state.view.mode === "allsky" && !e.shiftKey && state.sky) {
      drag.rot = _poleAngleSetup(e);
      const rect = canvas.getBoundingClientRect();
      drag.prevA = drag.rot.mouseAngle(e.clientX - rect.left,
                                       e.clientY - rect.top);
    }
    state._dragging = true;
    resetTrails();
    canvas.setPointerCapture(e.pointerId);
  });
  // --- pinch to zoom
  // The wheel is the desktop's zoom; a phone has two fingers.  A second
  // finger cancels the pan in progress rather than fighting it, and the
  // view is scaled about the point between the fingers so the sky stays
  // under them.
  const touches = new Map();
  let pinch = null;
  const pinchState = () => {
    const [a, b] = [...touches.values()];
    return { d: Math.hypot(a.x - b.x, a.y - b.y),
             mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
  };
  canvas.addEventListener("pointerdown", (e) => {
    if (e.pointerType !== "touch") return;
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (touches.size === 2) {
      drag = null;                  // two fingers means zoom, not pan
      state._dragging = false;
      state._suppressClick = true;  // lifting them must not open a popup
      pinch = pinchState();
      resetTrails();
    }
  });
  const dropTouch = (e) => {
    if (!touches.delete(e.pointerId)) return;
    if (touches.size < 2) pinch = null;
  };
  canvas.addEventListener("pointerup", dropTouch);
  canvas.addEventListener("pointercancel", dropTouch);

  canvas.addEventListener("pointermove", (e) => {
    if (e.pointerType === "touch" && touches.has(e.pointerId)) {
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch && touches.size === 2) {
        const now = pinchState();
        // ignore the first jitter: a ratio from two nearly-touching
        // fingers is noise, not intent
        if (now.d > 20 && pinch.d > 20) {
          const rect = canvas.getBoundingClientRect();
          zoomBy(pinch.d / now.d,
                 (now.mx - rect.left) * devicePixelRatio,
                 (now.my - rect.top) * devicePixelRatio);
          pinch = now;
        }
        return;
      }
    }
    if (!drag) return;
    const dx = e.clientX - drag.x0, dy = e.clientY - drag.y0;
    if (Math.hypot(dx, dy) > 5) drag.moved = true;
    if (drag.fovRot) {                 // rotate the grabbed FOV frame
      if (!drag.moved) return;
      const r = drag.fovRot;
      const rect = canvas.getBoundingClientRect();
      const a = Math.atan2((e.clientY - rect.top) * devicePixelRatio - r.cy,
                           (e.clientX - rect.left) * devicePixelRatio - r.cx);
      let deg = r.rot0 + (a - r.a0) / D2R * (state.opts.mirror ? -1 : 1);
      if (e.shiftKey) deg = Math.round(deg / 15) * 15;   // snap
      r.fr.rotation = Math.round(((deg % 360) + 360) % 360 * 10) / 10;
      saveFov();
      renderFOVList();
      return;
    }
    if (drag.fovMove) {                // drag the frame by its centre
      if (!drag.moved) return;
      const rect = canvas.getBoundingClientRect();
      const rd = screenToRaDec((e.clientX - rect.left) * devicePixelRatio,
                               (e.clientY - rect.top) * devicePixelRatio);
      if (rd) {
        drag.fovMove.fr.ra = rd.ra;
        drag.fovMove.fr.dec = rd.dec;
        saveFov();
      }
      return;
    }
    if (!drag.moved) return;
    const mir = state.opts.mirror ? -1 : 1;
    if (state.view.mode === "horizon") {
      // pan: content follows the pointer (mirror-aware in azimuth)
      const pxPerDeg = canvas.clientWidth / state.view.fov;
      state.view.azCenter =
        ((drag.az0 - mir * dx / pxPerDeg) % 360 + 360) % 360;
      state.view.altOffset =
        Math.min(90, Math.max(-30, drag.alt0 + dy / pxPerDeg));
      // reflect nearest cardinal in the quick-jump select
      const near = Math.round(state.view.azCenter / 90) % 4 * 90;
      $("#az-center").value = String(near);
    } else if (drag.shift) {
      // SHIFT+drag: pan the all-sky view center
      const degPerPx = 90 / (Math.min(canvas.clientWidth,
        canvas.clientHeight) / 2 * ALLSKY_FILL * state.view.zoom);
      const ctr = state.view.allskyCenter;
      ctr.az = ((drag.caz - mir * dx * degPerPx) % 360 + 360) % 360;
      ctr.alt = Math.min(90, Math.max(20, drag.calt + dy * degPerPx));
    } else if (drag.rot) {
      // plain drag: diurnal rotation about the celestial pole — the
      // mouse angle around the pole's screen image drives LST, so the
      // dial follows the pointer (full circle ≈ one sidereal day)
      const rect = canvas.getBoundingClientRect();
      const A = drag.rot.mouseAngle(e.clientX - rect.left,
                                    e.clientY - rect.top);
      let dA = A - drag.prevA;
      dA = ((dA + Math.PI * 3) % (Math.PI * 2)) - Math.PI;   // unwrap
      drag.prevA = A;
      drag.cum += dA;
      const s = drag.rot.radPerLstHour;
      if (Math.abs(s) > 1e-6) {
        const dLstH = drag.cum / s;                 // sidereal hours
        state.simOffsetMs = drag.off0 +
          dLstH * 3600e3 / 1.00273790935;           // -> solar ms
      }
      showScrubOverlay(0);
    }
    // panning shifts the view relative to the tracked object rather
    // than letting go of it
    if (state.view.follow) syncFollowOffset();
  });
  const endDrag = (e) => {
    if (!drag) return;
    const wasScrub = state.view.mode === "allsky" && !drag.shift &&
                     drag.rot && drag.moved;
    if (drag.moved) state._suppressClick = true;   // no popup after drag
    drag = null;
    state._dragging = false;
    if (wasScrub) {
      hideScrubOverlay(700);
      fetchSky().catch(() => {});
    }
  };
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);
  // double-click: recenter the all-sky view on the zenith
  canvas.addEventListener("dblclick", () => {
    if (state.view.mode === "allsky")
      state.view.allskyCenter = { az: 180, alt: 90 };
  });

  // --- arrow keys scrub the simulated time (←/→ ±10 min, +Shift ±1 d,
  // +Alt ±1 min; ↑/↓ ±1 h); LST/redraw is live, refetch is debounced
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {          // close modal / popup / tracking
      closePlanetView();
      $("#popup").hidden = true;
      if (state.view.follow) setFollow(null);
      return;
    }
    const tag = e.target && e.target.tagName;
    if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
    let mins;
    switch (e.key) {
      case "ArrowRight": mins = e.shiftKey ? 1440 : e.altKey ? 1 : 10;
        break;
      case "ArrowLeft": mins = -(e.shiftKey ? 1440 : e.altKey ? 1 : 10);
        break;
      case "ArrowUp": mins = 60; break;
      case "ArrowDown": mins = -60; break;
      default: return;
    }
    e.preventDefault();
    state.simOffsetMs += mins * 60e3;
    resetTrails();
    showScrubOverlay(900);
    scheduleFetchSky();
  });

  // click popup (SHIFT+click: move the selected 写野角 frame instead)
  canvas.addEventListener("click", async (e) => {
    if (state._suppressClick) { state._suppressClick = false; return; }
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) * devicePixelRatio;
    const y = (e.clientY - rect.top) * devicePixelRatio;
    if (e.shiftKey) {                  // 構図決め: recenter the frame
      const fr = selectedFovFrame();
      if (fr) {
        const rd = screenToRaDec(x, y);
        if (rd) { fr.ra = rd.ra; fr.dec = rd.dec; saveFov(); }
      }
      return;
    }
    // 写野角の中心をクリック: frame the FOV and zoom into it
    const fh = fovHandleAt(x, y, devicePixelRatio);
    if (fh && fh.kind === "center") {
      const fr = state.fovFrames.find((f) => f.id === fh.id);
      if (fr) { zoomToFrame(fr); $("#popup").hidden = true; return; }
    }
    let best = null, bd = 18 * devicePixelRatio;
    for (const h of state.hit || []) {
      const d = Math.hypot(h.x - x, h.y - y);
      if (d < bd) { bd = d; best = h; }
    }
    const pop = $("#popup");
    if (!best) {
      // nothing pointlike under the tap: the figure drawn there, if any
      const art = artHitAt(x, y);
      if (art) {
        const cn = (state.sky.connames || []).find((q) => q.abbr === art);
        pop.innerHTML = constellationCardHtml(
          art, cn ? (state.lang === "ja" ? cn.ja : cn.en) : art);
        placePopup(pop, e.clientX, e.clientY);
        return;
      }
      pop.hidden = true;
      selectObject(null);
      setFollow(null);
      return;
    }
    if (best.kind === "constellation") {   // 星座解説
      pop.innerHTML = constellationCardHtml(best.abbr, best.name);
      placePopup(pop, e.clientX, e.clientY);
      return;
    }
    if (best.kind === "radiant") {     // 流星群の情報
      pop.innerHTML = showerCardHtml(best.shower, best.alt) +
        `<br><button id="shower-clear">${t("ui.follow_stop")}</button>`;
      placePopup(pop, e.clientX, e.clientY);
      const b = pop.querySelector("#shower-clear");
      if (b) b.addEventListener("click", () => {
        setMeteorShower(null);
        pop.hidden = true;
      });
      return;
    }
    if (best.kind === "satellite") {   // no fixed RA/Dec — its own card
      pop.innerHTML = `<b>${best.name}</b> ` +
        `<span class="pop-dim">NORAD ${best.norad}</span><br>` +
        `${t("ui.azimuth")} ${best.az.toFixed(1)}° ` +
        `${t("ui.altitude")} ${best.alt.toFixed(1)}°<br>` +
        `${t("ui.sat_range")} ${Math.round(best.range_km)} km / ` +
        `${t("ui.sat_height")} ${Math.round(best.height_km)} km<br>` +
        (best.sunlit
          ? `${t("ui.magnitude")} ${best.vmag != null
              ? "≈" + (+best.vmag).toFixed(1) : "-"}`
          : t("ui.sat_eclipsed")) +
        `<br><span class="pop-dim">${t("ui.sat_age")} ` +
        `${best.age}d</span>` +
        `<br><button id="sat-pass-open">${t("ui.sat_passes")}</button>`;
      placePopup(pop, e.clientX, e.clientY);
      const b = pop.querySelector("#sat-pass-open");
      if (b) b.addEventListener("click", () => {
        pop.hidden = true;                 // the sheet covers it anyway
        showPanelTab("satellites", "#sat-passes");
        loadSatPasses(best.norad, best.name);
      });
      return;
    }
    selectObject(best);                // latch it for the 音声 tab panel
    const html = (best.kind === "dso" ? dsoCardHtml(best)
      : (best.kind === "comet" || best.kind === "asteroid")
        ? smallBodyCardHtml(best) + "<br>"
        : `<b>${best.name}</b><br>`) +
      `${fmtRaDec(best.ra, best.dec)}<br>` +
      `${t("ui.azimuth")} ${best.az.toFixed(1)}° ` +
      `${t("ui.altitude")} ${best.alt.toFixed(1)}°` +
      // the small-body card already opens with the magnitude
      (best.vmag != null && best.kind !== "comet" && best.kind !== "asteroid"
        ? `<br>${t("ui.magnitude")} ${(+best.vmag).toFixed(2)}` : "");
    const zoomable = best.kind === "planet" && PV_BODIES.has(best.key);
    const setPop = (extra) => {        // keep the buttons rebound
      pop.innerHTML = html + extra +
        `<br><button id="ct-zoom">🔎 ${t("ui.center_zoom")}</button>` +
        (zoomable
          ? ` <button id="pv-open">🔍 ${t("ui.planet_view")}</button>`
          : "");
      const b = pop.querySelector("#pv-open");
      if (b) b.addEventListener("click", () => openPlanetView(best.key));
      const z = pop.querySelector("#ct-zoom");
      if (z) z.addEventListener("click", () => {
        setFollow(best, zoomTargetFor(best));
        pop.hidden = true;
      });
    };
    setPop("");
    placePopup(pop, e.clientX, e.clientY);
    try {                        // shared with the 音声 tab panel
      await loadSelectedRiseSet();
      if (state.selectedRS && state.selected &&
          state.selected.name === best.name)
        setPop(`<br>${state.selectedRS}`);
    } catch (_) { /* popup stays with basic info */ }
  });
  // planet close-up modal
  $("#planet-modal-close").addEventListener("click", closePlanetView);
  $("#planet-modal").addEventListener("click", (e) => {
    if (e.target === $("#planet-modal")) closePlanetView();
  });
  // events
  const reloadEvents = () => refreshEvents().catch(() => {
    $("#events-loading").textContent = t("ui.update_failed");
  });
  $("#events-reload").addEventListener("click", reloadEvents);
  $("#events-days").addEventListener("change", reloadEvents);
  $("#events-dir").addEventListener("change", reloadEvents);
  $("#show-occultations").addEventListener("change", reloadEvents);
  $("#only-eclipses").addEventListener("change", reloadEvents);
  $("#show-satpasses").addEventListener("change", reloadEvents);
  // comets & asteroids
  let sbTimer = null;
  const sbReload = () => {
    clearTimeout(sbTimer);
    sbTimer = setTimeout(() => loadSBList().catch(() => {
      $("#sb-msg").textContent = t("ui.update_failed");
    }), 300);
  };
  $("#sb-search").addEventListener("input", sbReload);
  $("#sb-kind").addEventListener("change", sbReload);
  $("#sb-bright").addEventListener("click", loadSBBright);
  // --- 人工衛星 (TLE)
  const satOn = $("#opt-satellites");
  satOn.checked = state.sat.on;
  satOn.addEventListener("change", () => {
    state.sat.t0 = 0;
    if (satOn.checked) {
      enableSatellites($("#sat-msg")).catch(() => {
        $("#sat-msg").textContent = t("ui.update_failed");
      });
    } else {
      state.sat.on = false;
      saveSat();
      renderSatUI();
      syncSatButton();
    }
  });
  const satMag = $("#sat-maxmag");
  satMag.value = state.sat.maxmag;
  $("#sat-maxmag-out").textContent = state.sat.maxmag;
  satMag.addEventListener("input", () => {
    state.sat.maxmag = parseFloat(satMag.value);
    $("#sat-maxmag-out").textContent = satMag.value;
    state.sat.t0 = 0;
    saveSat();
  });
  const satLit = $("#sat-sunlit");
  satLit.checked = state.sat.sunlitOnly;
  satLit.addEventListener("change", () => {
    state.sat.sunlitOnly = satLit.checked;
    state.sat.t0 = 0;
    saveSat();
  });
  $("#sat-update").addEventListener("click", async () => {
    const btn = $("#sat-update");
    btn.disabled = true;
    btn.textContent = t("ui.updating");
    $("#sat-msg").textContent = "";
    const groups = state.sat.groups.length ? state.sat.groups : ["stations"];
    const failed = [];
    let total = 0, fresh = 0;
    try {
      for (const g of groups) {
        $("#sat-msg").textContent = t("ui.sat_downloading", { group: g });
        try {
          const n = await downloadTLEGroup(g);
          if (n == null) fresh++; else total += n;   // null: cache is current
        } catch (e) {
          failed.push(g);
        }
      }
      $("#sat-msg").textContent = failed.length
        ? `${t("ui.update_failed")}: ${failed.join(", ")}`
        : (!total && fresh) ? t("ui.sat_fresh")
                            : t("ui.sat_updated", { n: total });
      state.sat.t0 = 0;
      await fetchSatellites();
      renderSatUI();
    } finally {
      btn.disabled = false;
      btn.textContent = t("ui.sat_update");
    }
  });
  $("#sb-update").addEventListener("click", async () => {
    const btn = $("#sb-update");
    btn.disabled = true;
    btn.textContent = t("ui.updating");
    const msg = $("#sb-msg");
    msg.textContent = "";
    try {
      // comets: the MPC allows the page to fetch its file directly
      msg.textContent = t("ui.sb_fetch_comets");
      const txt = await (await fetch(MPC_COMETS_URL,
        { cache: "no-store" })).text();
      const r = await fetch("/api/smallbodies_import?kind=comets",
        { method: "POST", body: txt,
          headers: { "Content-Type": "text/plain" } });
      const out = await r.json();
      if (!out.ok) throw new Error(out.error || "import failed");
      let note = t("ui.sb_comets_done", { n: out.count });
      // asteroids: JPL sends no CORS header, so this one goes through
      // the host relay and is skipped where there is no host
      try {
        msg.textContent = t("ui.sb_fetch_asteroids");
        const raw = await jplRelay({
          path: "sbdb_query.api",
          fields: "pdes,name,epoch,e,q,i,om,w,tp,H,G",
          "sb-kind": "a", "sb-ns": "n", sort: "H", limit: "1000",
          "full-prec": "1" });
        const a = await fetch("/api/smallbodies_import?kind=asteroids",
          { method: "POST", body: raw,
            headers: { "Content-Type": "application/json" } });
        const ao = await a.json();
        if (ao.ok) note += " / " + t("ui.sb_asteroids_done", { n: ao.count });
        else note += " / " + t("ui.sb_asteroids_skipped");
      } catch (_) {
        note += " / " + t("ui.sb_asteroids_skipped");
      }
      await loadSBList();
      msg.textContent = note;
    } catch (_) {
      $("#sb-msg").textContent = t("ui.update_failed");
    } finally {
      btn.disabled = false;
      btn.textContent = t("ui.mpc_update");
    }
  });
  renderSBSelected();
  // voice: tonight text is fetched in the VOICE language so an English
  // voice never reads Japanese text (and vice versa)
  $("#speak-tonight").addEventListener("click", async () => {
    const vlang = $("#voice-lang").value;
    if (vlang === state.lang && state.tonightVoice) {
      speak(state.tonightVoice);
      return;
    }
    try {
      const d = await api("tonight", { site: state.site, lang: vlang });
      speak(d.voice_text);
    } catch (_) { speak(state.tonightVoice || ""); }
  });
  // stop speaking: explicit button or voice-language change
  const cancelSpeech = () => {
    if ("speechSynthesis" in window) speechSynthesis.cancel();
  };
  $("#voice-stop").addEventListener("click", cancelSpeech);
  $("#voice-lang").addEventListener("change", cancelSpeech);
  $("#speak-selected").addEventListener("click", () => {
    if (state.selectedVoice) speak(state.selectedVoice, { interrupt: true });
  });
}

/* ---------------- render benchmark ----------------
 * Loaded with ?bench=1 the page measures itself instead of guessing:
 * how long the WebAssembly core took to answer, and how long a frame
 * costs with each of the expensive layers switched on.  This is the
 * only way to get real numbers off a phone, where no profiler is
 * attached — the results are drawn onto the canvas so a screenshot is
 * the measurement.
 */
async function benchRun() {
  const rows = [];
  const timed = (label, frames) => {
    draw();                                   // warm caches
    const t0 = performance.now();
    for (let i = 0; i < frames; i++) draw();
    const ms = (performance.now() - t0) / frames;
    // a frame that measures as free did not happen: say so rather than
    // publishing an impossible number
    rows.push(ms < 0.05
      ? { label, ms: +ms.toFixed(3), fps: null, suspect: true }
      : { label, ms: +ms.toFixed(2), fps: +(1000 / ms).toFixed(1) });
  };
  // the layer only costs anything once its image is in memory, so the
  // load has to finish before the frames are timed — otherwise the
  // measurement quietly reports the cost of not drawing it
  const layerReady = async () => {
    loadMilkyway();                       // fire-and-forget by design
    for (let i = 0; i < 60; i++) {
      if (state._mwImg) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  };
  const saved = JSON.parse(JSON.stringify(state.opts));
  const savedView = JSON.parse(JSON.stringify(state.view));
  const N = 30;
  setViewMode("allsky");
  state.opts.milkyway = false;
  timed("allsky, stars only", N);
  state.opts.milkyway = true;
  timed(await layerReady() ? "allsky + milky way"
                           : "allsky + milky way (NOT LOADED)", N);
  state.opts.milkyway = false;
  setViewMode("horizon"); setFieldWidth(60);
  timed("horizon 60\u00b0", N);
  Object.assign(state.opts, saved);
  state.view = savedView;
  return rows;
}

async function benchApi() {
  const out = [];
  for (const [label, path, params] of [
      ["sky", "sky", { site: state.site, mag: 6.6, lang: state.lang }],
      ["tonight", "tonight", { site: state.site, lang: state.lang }],
      ["riseset", "riseset", { site: state.site, body: "moon" }]]) {
    const t0 = performance.now();
    try { await api(path, params); } catch (_) { /* report the time anyway */ }
    out.push({ label, ms: Math.round(performance.now() - t0) });
  }
  return out;
}

async function runBenchmark() {
  // Nothing is drawn until the first sky arrives, and on a phone that
  // takes seconds — benchmarking before it lands measures an empty
  // canvas and reports 0 ms, which is how this was first got wrong.
  let bootMs = null;
  for (let i = 0; i < 600; i++) {
    if (state.sky) { bootMs = Math.round(performance.now()); break; }
    await new Promise((r) => setTimeout(r, 100));
  }
  if (bootMs === null) {
    window.__bench = { error: "sky never loaded" };
    console.log("BENCH", JSON.stringify(window.__bench));
    return window.__bench;
  }
  const render = await benchRun();
  const apis = await benchApi();
  const mem = performance.memory
    ? Math.round(performance.memory.usedJSHeapSize / 1e6) + " MB JS heap"
    : "heap size unavailable";
  const res = { boot_ms: bootMs, canvas: [canvas.width, canvas.height],
                dpr: devicePixelRatio, render, apis, mem };
  window.__bench = res;
  console.log("BENCH", JSON.stringify(res));
  // drawn, not alerted: a screenshot is how this leaves the phone
  const c = ctx, px = canvas.width / canvas.clientWidth;
  c.save();
  c.fillStyle = "rgba(6,8,18,0.94)";
  c.fillRect(0, 0, canvas.width, canvas.height);
  c.fillStyle = "#dfe6f5";
  c.textAlign = "left"; c.textBaseline = "top";
  const lh = 22 * px;
  let y = 40 * px;
  const line = (txt, size) => {
    c.font = `${(size || 14) * px}px ui-monospace, monospace`;
    c.fillText(txt, 24 * px, y); y += lh;
  };
  line("Astrarium render benchmark", 18);
  line(`canvas ${canvas.width}x${canvas.height} dpr ${devicePixelRatio}`);
  line(`first sky at ${bootMs} ms after load`);
  line(mem);
  y += lh / 2;
  for (const r of render)
    line(r.suspect ? `${r.ms} ms  (not drawn?)  ${r.label}`
                   : `${r.ms.toFixed(2)} ms  ${r.fps} fps  ${r.label}`);
  y += lh / 2;
  for (const a of apis) line(`${a.ms} ms  api/${a.label}`);
  c.restore();
  return res;
}

/* ---------------- 流星群カレンダー ----------------
 * The working list gives a shower a solar longitude, not a date, so the
 * server solves each maximum for the year ahead; the page keeps that
 * list, offers it as a menu, and on a choice moves the clock to the
 * maximum and puts the radiant on the chart.  Someone reading about the
 * Perseids wants to see where they will be at 2 a.m. on the night, not
 * where the radiant is this afternoon. */
async function loadShowers() {
  // which showers are running depends on the date being displayed, so
  // the list is solved for the simulated clock and cached per day
  const day = new Date(simNow()).toISOString().slice(0, 10);
  const k = `${state.site}|${state.lang}|${day}`;
  if (state.showers && state.showers.key === k) return state.showers.list;
  const d = await api("showers", { site: state.site, lang: state.lang,
                                   time: new Date(simNow()).toISOString() });
  state.showers = { key: k, list: d.showers || [] };
  renderShowerMenu();
  return state.showers.list;
}

/* Nearest maximum to the sky being shown, first.
 *
 * The list is read against a chart, not against today: someone looking
 * at a December sky wants the Geminids at the top, and after the peak
 * the shower that just ran is still the one being asked about — so the
 * distance is taken either side of the displayed instant. */
function showersByProximity(list) {
  const now = simNow();
  return (list || []).slice().sort(
    (a, b) => Math.abs(Date.parse(a.peak_utc) - now) -
              Math.abs(Date.parse(b.peak_utc) - now));
}

/* The catalogue carries both names, so a language switch renames the
 * showers immediately instead of waiting for the list to be fetched
 * again — and a card built from an events row reads the same way. */
function showerName(sh) {
  if (!sh) return "";
  return (state.lang === "ja" ? sh.name_ja : sh.name_en) || sh.name || "";
}

/* The maximum in the observer's own clock and in UT.  The working list
 * is published in UT; the local time is what decides whether to set an
 * alarm, and the two differ by enough that a shower peaking at 11 a.m.
 * JST is an evening event elsewhere. */
function showerPeakLocal(sh) {
  const p = sh.peak_local || "";
  const zone = p.split(" ")[2] || "";
  return `${p.slice(0, 16)}${zone ? " " + zone : ""}`;
}

function showerPeakUT(sh) {
  const u = sh.peak_utc || "";
  return u ? `${u.slice(0, 10)} ${u.slice(11, 16)} UT` : "";
}

function showerParent(sh) {
  if (!sh) return "";
  return (state.lang === "ja" ? sh.parent_ja : sh.parent_en) ||
         sh.parent || "";
}

function showerMenuLabel(sh) {
  const p = sh.peak_local || "";
  const md = p.slice(5, 16).replace("-", "/");     // MM/DD HH:MM
  return `${showerName(sh)}  ${md}`;
}

function renderShowerMenu() {
  const sel = $("#shower-select");
  if (!sel) return;
  const list = showersByProximity((state.showers || {}).list);
  sel.innerHTML = `<option value="">${esc(t("ui.shower_pick"))}</option>` +
    list.map((sh) => `<option value="${esc(sh.code)}">` +
      `${esc(showerMenuLabel(sh))}</option>`).join("");
  if (state.shower && state.shower.code) sel.value = state.shower.code;
}

/* the detail block under the menu: everything that decides whether the
 * night is worth staying up for */
function showerDetailHtml(sh) {
  const ja = state.lang === "ja";
  const rows = [];
  const add = (k, v) => rows.push(
    `<tr><td>${esc(k)}</td><td>${v}</td></tr>`);
  add(t("ui.shower_peak"), esc(showerPeakLocal(sh)));
  add(`${t("ui.shower_peak")} (UT)`, esc(showerPeakUT(sh)));
  add(t("ui.radiant"), fmtRaDec(sh.ra, sh.dec));
  if (sh.radiant_alt != null)
    add(t("ui.shower_radiant_alt"), `${sh.radiant_alt.toFixed(0)}°`);
  const nowInfo = showerRateInfo(sh);
  if (nowInfo.alt != null)
    add(t("ui.shower_radiant_now"), `${nowInfo.alt.toFixed(0)}°` +
      (nowInfo.alt <= 0
        ? ` <span class="pop-dim">(${t("ui.below_horizon")})</span>` : ""));
  add("ZHR", `${sh.zhr} <span class="pop-dim">(${
    t("ui.shower_zhr_at_peak")})</span>`);
  const rateText = showerRateText(sh);
  if (rateText) add(t("ui.shower_rate"), rateText);
  if (sh.vinf != null) add(t("ui.shower_speed"), `${sh.vinf} km/s`);
  if (sh.r != null) add(t("ui.shower_pop_index"), `${sh.r}`);
  if (sh.moon_illum != null)
    add(t("body.moon"), `${Math.round(sh.moon_illum * 100)}% ` +
      `<span class="pop-dim">(${t("ui.moon_cond_" + (sh.moon || ""))})` +
      `</span>`);
  const parent = showerParent(sh);
  if (parent) add(t("ui.shower_parent"), esc(parent));
  return `<b>${esc(showerName(sh))}</b> ` +
    `<span class="pop-dim">${esc(sh.code)}` +
    `</span><table class="pv-table">${rows.join("")}</table>` +
    `<div class="hint">${esc(t("ui.shower_jumped"))}</div>`;
}

/* When to show the sky for a shower.
 *
 * The maximum is an instant, and for a Japanese observer it lands in
 * daylight as often as not — the 2026 Perseids peak at 11 a.m. JST.
 * Jumping there would answer a question about a meteor shower with a
 * blue sky, so the clock goes to 1 a.m. on the night of the maximum
 * instead, when the radiant is high; the card still states the real
 * peak time. */
function showerViewTime(sh) {
  const utc = Date.parse(sh.peak_utc);
  const loc = Date.parse((sh.peak_local || "").slice(0, 19)
                         .replace(" ", "T") + "Z");
  if (!isFinite(utc) || !isFinite(loc)) return sh.peak_utc;
  const hour = +sh.peak_local.slice(11, 13);
  if (hour >= 20 || hour < 4) return sh.peak_utc;   // already deep night
  const off = loc - utc;                            // site's UTC offset
  const night = new Date(loc);
  if (hour >= 12) night.setUTCDate(night.getUTCDate() + 1);
  night.setUTCHours(1, 0, 0, 0);
  return new Date(night.getTime() - off).toISOString();
}

/* Choose a shower: draw its radiant and take the clock to the maximum. */
function applyShower(sh, jump = true) {
  if (!sh) { setMeteorShowers([]); syncShowerButton(); return; }
  setMeteorShower(sh);
  const det = $("#shower-detail");
  if (det) det.innerHTML = showerDetailHtml(sh);
  const sel = $("#shower-select");
  if (sel) sel.value = sh.code;
  syncShowerButton();
  if (jump && sh.peak_utc) jumpToTime(showerViewTime(sh));
}

/* Re-solve the shower list for the current site and repaint whatever is
 * showing it — the menu, the strip over the chart, and the card. */
async function refreshShowersForSite() {
  if (!state.showers) return;
  state.showers = null;
  const list = await loadShowers().catch(() => []);
  const on = (state.showersOn || []).map((old) =>
    list.find((x) => x.code === old.code) || old);
  if (on.length) setMeteorShowers(on);
  const det = $("#shower-detail");
  const sel = $("#shower-select");
  if (det && det.innerHTML && on.length)
    det.innerHTML = on.map(showerDetailHtml).join("<hr>");
  else if (det && det.innerHTML && sel && sel.value) {
    const one = list.find((x) => x.code === sel.value);
    if (one) det.innerHTML = showerDetailHtml(one);
  }
}

function syncShowerButton() {
  const b = $("#shower-btn");
  if (!b) return;
  const on = (state.showersOn || []).length > 0;
  b.classList.toggle("on", on);
  b.setAttribute("aria-pressed", String(on));
}

/* Bright comets, in one press.
 *
 * The orbital elements are not shipped — they are revised constantly and
 * a stale set puts a comet degrees from where it is — so the first press
 * fetches the MPC's current file.  "Bright" is taken as magnitude 12 or
 * better: that is the reach of a small telescope, and a chart of every
 * 20th-magnitude comet on file would be a chart of nothing anyone can
 * see. */
const COMET_MAG_LIMIT = 12;
const COMET_MAX = 20;

function selectedComets() {
  return state.selectedSB.filter((o) => o.kind === "comet");
}

function syncCometButton() {
  const b = $("#comet-btn");
  if (!b) return;
  const on = selectedComets().length > 0;
  b.classList.toggle("on", on);
  b.setAttribute("aria-pressed", String(on));
}

async function importComets() {
  const txt = await (await fetch(MPC_COMETS_URL, { cache: "no-store" }))
    .text();
  const r = await fetch("/api/smallbodies_import?kind=comets",
    { method: "POST", body: txt,
      headers: { "Content-Type": "text/plain" } });
  const out = await r.json();
  if (!out.ok) throw new Error(out.error || "import failed");
  return out.count;
}

async function showBrightComets(msgEl) {
  const say = (k, o) => { if (msgEl) msgEl.textContent = t(k, o); };
  const ask = () => api("smallbodies_bright",
                        { mag: COMET_MAG_LIMIT, limit: 60 });
  let d = await ask().catch(() => null);
  let comets = ((d && d.objects) || []).filter((o) => o.kind === "comet");
  if (!comets.length) {                 // nothing on file yet: go and get it
    say("ui.comet_fetching");
    await importComets();
    d = await ask();
    comets = ((d && d.objects) || []).filter((o) => o.kind === "comet");
  }
  comets = comets.slice(0, COMET_MAX);
  const others = state.selectedSB.filter((o) => o.kind !== "comet");
  state.selectedSB = others.concat(comets.map(
    (o) => ({ id: o.id, name: o.name, kind: o.kind })));
  saveSB();
  renderSBSelected(); renderSBList(); renderSBBright();
  syncCometButton();
  await fetchSky().catch(() => {});
  return comets.length;
}

/* Turn the satellite layer on, downloading the element sets first if
 * none are cached.  Without this, switching the layer on for the first
 * time drew nothing at all and gave no hint why: the elements are not
 * shipped with the app, because they go stale in days. */
async function enableSatellites(msgEl) {
  const say = (k, o) => { if (msgEl) msgEl.textContent = t(k, o); };
  state.sat.on = true;
  const cb = $("#opt-satellites");
  if (cb) cb.checked = true;
  saveSat();
  const groups = state.sat.groups.length ? state.sat.groups : ["stations"];
  const meta = await api("satellites", { meta: 1 }).catch(() => null);
  const cached = meta && (meta.groups || []).some(
    (g) => groups.includes(g.key) && g.meta && g.meta.count);
  if (!cached) {
    for (const g of groups) {
      say("ui.sat_downloading", { group: g });
      try { await downloadTLEGroup(g); } catch (_) { /* try the rest */ }
    }
    say("ui.sat_updated", { n: state.sat.loaded || 0 });
  }
  state.sat.t0 = 0;
  await fetchSatellites().catch(() => {});
  renderSatUI();
}

/* Download one Celestrak element-set group in the page and hand the
 * text to the compute core.
 *
 * The core cannot fetch it itself: in the WebAssembly build there is no
 * subprocess to run curl in and no socket to open.  Celestrak serves
 * these files with `Access-Control-Allow-Origin: *`, so the page can,
 * and the core only has to parse and cache what it is given. */
const CELESTRAK_GP =
  "https://celestrak.org/NORAD/elements/gp.php?GROUP={g}&FORMAT=tle";

/* CelesTrak's usage policy asks that a given GP group be fetched at
 * most once every two hours — that is how often it is regenerated — and
 * answers a caller that ignores it with an HTTP error, then a firewall
 * block.  A cache younger than that is served without touching the
 * network; the observer loses nothing, because there is nothing newer
 * to have. */
const TLE_MIN_AGE_MS = 2 * 3600e3;
async function tleAgeMs(group) {
  const meta = await api("satellites", { meta: 1 }).catch(() => null);
  const g = meta && (meta.groups || []).find((x) => x.key === group);
  const f = g && g.meta && g.meta.fetched;
  const ts = f ? Date.parse(f) : NaN;
  return Number.isFinite(ts) ? Date.now() - ts : Infinity;
}

async function downloadTLEGroup(group) {
  if (await tleAgeMs(group) < TLE_MIN_AGE_MS) return null;   // still fresh
  const r = await fetch(CELESTRAK_GP.replace("{g}",
    encodeURIComponent(group)), { cache: "no-store" });
  if (!r.ok) throw new Error(`celestrak ${r.status}`);
  const text = await r.text();
  if (!text || text.length < 100 || /^\s*<|no gp data/i.test(text))
    throw new Error("no element sets returned");
  const res = await fetch(
    `/api/satellites_import?group=${encodeURIComponent(group)}`,
    { method: "POST", body: text,
      headers: { "Content-Type": "text/plain" } });
  const d = await res.json();
  if (!d.ok) throw new Error(d.error || "import failed");
  state.sat.loaded = Object.values(d.index || {})
    .reduce((a, v) => a + (v.count || 0), 0);
  return d.count;
}

/* Put the card next to the tap without letting it fall off the screen.
 * It is measured after the content is in, because the height depends on
 * what was clicked — a star is three lines, a comet is a dozen, and a
 * Messier object carries a photograph. */
function placePopup(pop, cx, cy) {
  const m = 8, gap = 14;
  pop.hidden = false;                     // must be laid out to measure
  pop.style.left = "0px";
  pop.style.top = "0px";
  const r = pop.getBoundingClientRect();
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  let x = cx + gap;
  if (x + r.width + m > vw) x = cx - gap - r.width;   // flip to the left
  x = Math.max(m, Math.min(x, vw - r.width - m));
  let y = cy + 8;
  if (y + r.height + m > vh) y = cy - 8 - r.height;   // flip above
  y = Math.max(m, Math.min(y, vh - r.height - m));
  pop.style.left = `${x}px`;
  pop.style.top = `${y}px`;
}

/* What is known about a comet or minor planet: where it is now, and the
 * orbit that put it there.  The elements come with the sky payload, so
 * the card needs no further request. */
function smallBodyCardHtml(hit) {
  const b = (state.sky.smallbodies || []).find(
    (x) => x.id === hit.id || x.name === hit.name);
  if (!b) return `<b>${esc(hit.name)}</b>`;
  const e = b.elements || {};
  const num = (v, d) => (v == null || !isFinite(v) ? "-" : (+v).toFixed(d));
  const row = (k, v) => `<br><span class="pop-dim">${k}</span> ${v}`;
  let h = `<b>${esc(b.name)}</b> <span class="pop-dim">` +
    `${t(b.kind === "comet" ? "ui.comets" : "ui.asteroids")}</span>`;
  h += row(t("ui.magnitude"), b.mag == null ? "-" : num(b.mag, 1));
  h += row(t("ui.sb_r_sun"), `${num(b.r_sun_au, 3)} au`);
  h += row(t("ui.sb_delta"), `${num(b.delta_au, 3)} au`);
  h += row(t("ui.elongation"),
    `${num(b.elong_deg, 1)}° ${b.elong_side === "E" ? t("ui.evening")
      : b.elong_side === "W" ? t("ui.morning") : ""}`);
  h += row(t("ui.phase_angle"), `${num(b.phase_deg, 1)}°`);
  // brightness parameters, and the size they imply
  if (b.kind === "comet") {
    h += row("M1 / K1", `${num(e.M1, 1)} / ${num(e.K1, 1)}`);
  } else if (e.H != null) {
    h += row("H / G", `${num(e.H, 2)} / ${num(e.G, 2)}`);
    // D = 1329/sqrt(pV) * 10^(-H/5): a standard estimate, and only that
    // — the albedo is assumed, not measured, so it is labelled as such
    const pV = 0.15;
    const d = 1329 / Math.sqrt(pV) * Math.pow(10, -e.H / 5);
    h += row(t("ui.sb_diameter"),
      `≈ ${d >= 10 ? d.toFixed(0) : d.toFixed(1)} km ` +
      `<span class="pop-dim">(${t("ui.sb_albedo_assumed", { p: pV })})</span>`);
  }
  h += `<br><span class="pop-dim">${t("ui.sb_elements")}</span>`;
  h += row("q / e", `${num(e.q_au, 4)} au / ${num(e.e, 4)}`);
  h += row("i / Ω / ω",
    `${num(e.incl_deg, 2)}° / ${num(e.node_deg, 2)}° / ` +
    `${num(e.argp_deg, 2)}°`);
  if (e.a_au != null)
    h += row("a / Q", `${num(e.a_au, 4)} au / ${num(e.Q_au, 4)} au`);
  if (e.period_yr != null)
    h += row(t("ui.sb_period"), `${num(e.period_yr, 2)} ` + t("ui.years"));
  h += row("Tp", `JD ${num(e.tp_jd_tt, 3)}`);
  if (e.epoch_jd_tt != null)
    h += row(t("ui.sb_epoch"), `JD ${num(e.epoch_jd_tt, 1)}`);
  return h;
}

/* The observer's position, from whichever source can supply it.
 *
 * navigator.geolocation is the browser's answer and works on the web.
 * Inside the app it often does not: the permission belongs to the host
 * process, and WKWebView's own call fails when the host has never asked
 * for it.  So the host offers /native/location, which asks CoreLocation
 * properly.  Either way this is only ever called from a button press —
 * the chart never demands a position, and refusing one costs nothing
 * because coordinates can be typed in instead.
 */
function getPosition(timeoutMs = 20000) {
  const viaBrowser = () => new Promise((resolve, reject) => {
    if (!navigator.geolocation) { reject(new Error("unsupported")); return; }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude,
                         lon: pos.coords.longitude,
                         alt: pos.coords.altitude,
                         accuracy: pos.coords.accuracy }),
      (e) => reject(new Error(e && e.message ? e.message : "denied")),
      { timeout: timeoutMs, maximumAge: 120000 });
  });
  const viaHost = async () => {
    const r = await fetch("/native/location");
    if (!r.ok) throw new Error(`host ${r.status}`);
    const d = await r.json();
    if (!d.ok) throw new Error(d.error || "unavailable");
    return { lat: d.lat, lon: d.lon,
             alt: d.alt_m == null ? null : d.alt_m,
             accuracy: d.accuracy_m };
  };
  return viaBrowser().catch((e1) =>
    viaHost().catch(() => { throw e1; }));
}

/* --- minor planets and comets from their sources -------------------
 *
 * The MPC serves its comet file with a permissive CORS header, so the
 * page fetches that itself.  JPL's small-body services do not, and the
 * WebAssembly core has no sockets, so those go through the host's relay
 * (/native/jpl — the Python dev server and the iOS app both answer it).
 */
const MPC_COMETS_URL =
  "https://www.minorplanetcenter.net/iau/MPCORB/CometEls.txt";

async function jplRelay(params) {
  const q = new URLSearchParams(params);
  const r = await fetch(`/native/jpl?${q}`);
  if (!r.ok) throw new Error(`relay ${r.status}`);
  const d = await r.json();
  if (!d.ok) throw new Error(d.error || "relay failed");
  return d.body;
}

/* Look one object up in the JPL Small-Body Database by name or
 * designation, and return it in the element shape the catalogue uses. */
async function jplLookup(query) {
  // phys-par is not returned unless asked for, and it carries the
  // magnitude parameters without which the object plots but never gets
  // a brightness
  const raw = await jplRelay({ path: "sbdb.api", sstr: query,
                               "full-prec": "1", "phys-par": "1" });
  const d = JSON.parse(raw);
  if (d.code || !d.object || !d.orbit) return null;
  const el = {};
  for (const e of d.orbit.elements || []) el[e.name] = parseFloat(e.value);
  // SBDB spells the class as a two-letter code: "an"/"au" asteroid,
  // "cn"/"cu" comet
  const kind = String(d.object.kind || "").toLowerCase().startsWith("c")
    ? "comet" : "asteroid";
  const rec = {
    name: (d.object.fullname || d.object.des || query).trim(),
    pdes: d.object.des, kind,
    q_au: el.q, e: el.e, incl_deg: el.i, node_deg: el.om,
    argp_deg: el.w, tp_jd_tt: el.tp,
    epoch_jd_tt: parseFloat(d.orbit.epoch),
  };
  const pp = d.phys_par || [];
  const H = pp.find((x) => x.name === "H");
  const M1 = pp.find((x) => x.name === "M1");
  const G = pp.find((x) => x.name === "G");
  const K1 = pp.find((x) => x.name === "K1");
  if (kind === "comet") {
    rec.M1 = M1 ? parseFloat(M1.value) : (H ? parseFloat(H.value) : null);
    rec.K1 = K1 ? parseFloat(K1.value) : 10.0;
  } else {
    rec.H = H ? parseFloat(H.value) : null;
    rec.G = G ? parseFloat(G.value) : 0.15;
  }
  if (![rec.q_au, rec.e, rec.incl_deg, rec.node_deg, rec.argp_deg,
        rec.tp_jd_tt].every((v) => isFinite(v))) return null;
  return rec;
}

/* ---------------- 黄道12星座のサイン ----------------
 * The dates are the tropical signs of astrology, which is what someone
 * means by "my sign": they are tied to the equinox, not to where the
 * Sun is against the stars — precession has moved the two apart by
 * about a month, and the constellations are not equal in size either.
 * The card says so rather than letting the chart imply otherwise. */
const ZODIAC = {
  Ari: { sign: "\u2648", ja: "牡羊座", en: "Aries",
         from: [3, 21], to: [4, 19] },
  Tau: { sign: "\u2649", ja: "牡牛座", en: "Taurus",
         from: [4, 20], to: [5, 20] },
  Gem: { sign: "\u264a", ja: "双子座", en: "Gemini",
         from: [5, 21], to: [6, 21] },
  Cnc: { sign: "\u264b", ja: "蟹座", en: "Cancer",
         from: [6, 22], to: [7, 22] },
  Leo: { sign: "\u264c", ja: "獅子座", en: "Leo",
         from: [7, 23], to: [8, 22] },
  Vir: { sign: "\u264d", ja: "乙女座", en: "Virgo",
         from: [8, 23], to: [9, 22] },
  Lib: { sign: "\u264e", ja: "天秤座", en: "Libra",
         from: [9, 23], to: [10, 23] },
  Sco: { sign: "\u264f", ja: "蠍座", en: "Scorpio",
         from: [10, 24], to: [11, 21] },
  Sgr: { sign: "\u2650", ja: "射手座", en: "Sagittarius",
         from: [11, 22], to: [12, 21] },
  Cap: { sign: "\u2651", ja: "山羊座", en: "Capricorn",
         from: [12, 22], to: [1, 19] },
  Aqr: { sign: "\u2652", ja: "水瓶座", en: "Aquarius",
         from: [1, 20], to: [2, 18] },
  Psc: { sign: "\u2653", ja: "魚座", en: "Pisces",
         from: [2, 19], to: [3, 20] },
};

/* The constellation card: what the sky culture says about the figure,
 * plus — for the twelve of the zodiac — the sign it carries. */
function constellationCardHtml(abbr, fallbackName) {
  const info = state.conInfo && state.conInfo[abbr];
  const ja = state.lang === "ja";
  let ch = `<b>${esc(fallbackName || abbr)}</b>`;
  if (info) {
    ch = `<b>${esc(ja ? info.name_ja : info.name_en)}</b>` +
      (info.genitive
        ? ` <span class="pop-dim">(${esc(info.genitive)})</span>` : "") +
      `<br>${(ja ? info.desc_ja : info.desc_en) || ""}`;
    const hl = (ja ? info.highlights_ja : info.highlights_en) || [];
    if (hl.length)
      ch += `<br><b>${t("ui.highlights")}</b>: ` +
        hl.join(ja ? "、" : ", ");
    if (info.best_month)
      ch += `<br>${t("ui.best_month")}: ${info.best_month}` +
        (ja ? "月" : "");
  }
  return ch + zodiacCardHtml(abbr);
}

function zodiacCardHtml(abbr) {
  const z = ZODIAC[abbr];
  if (!z) return "";
  const ja = state.lang === "ja";
  const md = ([m, d]) => ja ? `${m}月${d}日`
    : `${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep",
         "Oct", "Nov", "Dec"][m - 1]} ${d}`;
  return `<div class="zodiac"><span class="zo-sign">${z.sign}</span>` +
    `<span class="zo-name">${esc(ja ? z.ja : z.en)}</span>` +
    `<div class="zo-dates">${t("ui.zodiac_period")}: ` +
    `${md(z.from)} – ${md(z.to)}</div>` +
    `<div class="zo-note">${t("ui.zodiac_note")}</div></div>`;
}

/* ---------------- credits ----------------
 * Attribution that travels with the app rather than sitting in a
 * repository file: CC BY and CC BY-SA ask for credit, and the Free Art
 * License under which the constellation artwork is published asks for
 * the licence itself to accompany the work. */
/* the credit strings come from a bundled data file rather than from the
 * page, but they are still text going into innerHTML */
function esc(v) {
  return String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;",
    '"': "&quot;", "'": "&#39;" }[c]));
}

const CREDIT_KINDS = [["catalog", "ui.credits_catalog"],
                      ["ephemeris", "ui.credits_ephemeris"],
                      ["imagery", "ui.credits_imagery"],
                      ["artwork", "ui.credits_artwork"],
                      ["library", "ui.credits_library"]];

function creditLink(url) {
  if (!url || !/^https?:\/\//.test(url)) return esc(url || "");
  return `<a href="${esc(url)}" target="_blank" rel="noopener">` +
         `${esc(url)}</a>`;
}

/* A credit field in the reader's language.  Licence names like "MIT"
 * are the same in both and are held once, so `<key>` is the fallback for
 * a missing `<key>_ja` / `<key>_en`. */
function creditField(r, key, ja) {
  const v = r[`${key}_${ja ? "ja" : "en"}`];
  return v != null && v !== "" ? v : (r[key] || "");
}

async function renderCredits() {
  const box = $("#credits-body");
  if (!box || box.dataset.filled === state.lang) return;
  let d;
  try { d = await api("credits"); } catch (_) { return; }
  if (!d.available) return;
  const ja = state.lang === "ja";
  const parts = [];
  if (d.app)
    parts.push(`<div class="cr-intro">${esc(ja ? d.app.note_ja
                                               : d.app.note_en)}</div>`);
  for (const [kind, key] of CREDIT_KINDS) {
    const rows = (d.entries || []).filter((x) => x.kind === kind);
    if (!rows.length) continue;
    parts.push(`<h4>${esc(t(key))}</h4>`);
    for (const r of rows) {
      const note = ja ? r.note_ja : r.note_en;
      const version = creditField(r, "version", ja);
      parts.push('<div class="cr">' +
        `<div class="cr-name">${esc(ja ? r.name_ja : r.name_en)}</div>` +
        `<div class="cr-lic">${esc(creditField(r, "license", ja))}` +
        (r.license_url ? ` — ${creditLink(r.license_url)}` : "") + "</div>" +
        (version || r.retrieved
          ? `<div class="cr-ver">${esc(version)}` +
            (version && r.retrieved ? " · " : "") +
            (r.retrieved ? `${esc(t("ui.credits_retrieved"))} ${
              esc(r.retrieved)}` : "") + "</div>"
          : "") +
        (r.source ? `<div class="cr-src">${creditLink(r.source)}</div>` : "") +
        (note ? `<div class="cr-note">${esc(note)}</div>` : "") +
      "</div>");
    }
  }
  const foot = ja ? (d.app && d.app.footer_ja) : (d.app && d.app.footer_en);
  if (foot) {
    // the author's line closes the list; the handle is a live link
    const linked = esc(foot).replace(/(https?:\/\/\S+)/,
      '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
    parts.push(`<div class="cr-foot">${linked}</div>`);
  }
  box.innerHTML = parts.join("");
  box.dataset.filled = state.lang;
}

/* ---------------- speech (spec §9) ---------------- */
let _voices = [];
function _refreshVoices() {
  if ("speechSynthesis" in window) _voices = speechSynthesis.getVoices();
}
if ("speechSynthesis" in window) {
  _refreshVoices();                 // may be empty until voiceschanged
  speechSynthesis.addEventListener("voiceschanged", _refreshVoices);
}
function speak(text, opts = {}) {
  if (!("speechSynthesis" in window) || !text) return;
  const vlang = $("#voice-lang").value;
  const tag = vlang === "ja" ? "ja-JP" : "en-US";
  if (vlang === "en") text = text.replace(/–/g, " to ");
  const u = new SpeechSynthesisUtterance(text);
  u.lang = tag;
  u.rate = parseFloat($("#voice-rate").value);
  u.volume = parseFloat($("#voice-vol").value);
  if (!_voices.length) _refreshVoices();
  // exact BCP-47 match first, then any voice of the same language
  const v = _voices.find((x) => x.lang.replace("_", "-") === tag) ||
    _voices.find((x) => x.lang.replace("_", "-").startsWith(vlang));
  if (v) u.voice = v;
  if (opts.interrupt) speechSynthesis.cancel();
  speechSynthesis.speak(u);
}
/* ---------------- boot ---------------- */
(async function boot() {
  bind();
  await loadI18n();
  renderFOVList();                     // needs i18n for tooltips
  renderSelected();                    // empty-state hint (needs i18n)
  api("satellites", { site: state.site, meta: 1 })
    .then((d) => {                     // group list / fetch dates only
      state.sat.groupMeta = d.groups || [];
      state.sat.loaded = d.loaded || 0;
      renderSatUI();
      if (state.sat.on) fetchSatellites().catch(() => {});
    }).catch(() => renderSatUI());
  if (state.opts.conart) loadConstellationArt();
  await loadSites();
  await fetchSky();
  updatePlayButtons();
  refreshInfo().catch(() => {});
  refreshEvents().catch(() => {});
  loadHorizonMask();                   // terrain silhouette (per site)
  loadDsoPhotos();                     // メシエ天体の写真 (may be absent)
  api("satellite_events", { site: state.site, days: 7, minalt: 25 })
    .then((d) => {                     // passes to show in the demo tour
      const evs = d.events || [];
      state.demoPass = evs.find((e) => e.kind === "iss") || evs[0] || null;
      // brightest train: the launches are only this bright for a week or
      // two, so the brightest one on offer is the one worth showing
      state.demoTrain = evs.filter((e) => e.kind === "starlink_train")
        .sort((a, b) => (a.mag == null ? 99 : a.mag) -
                        (b.mag == null ? 99 : b.mag))[0] || null;
    }).catch(() => { state.demoPass = null; state.demoTrain = null; });
  loadPlanetTextures();                // 天体面のテクスチャ (may be absent)
  api("constellations_info").then((d) => {   // 星座解説 (may be absent)
    state.conInfo = d && d.available ? d.constellations : null;
  }).catch(() => { state.conInfo = null; });
  requestAnimationFrame(tick);
})();
