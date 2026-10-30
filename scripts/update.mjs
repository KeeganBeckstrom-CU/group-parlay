// Pulls the NFL schedule and final scores from ESPN's public scoreboard and writes games.json.
// It only contacts ESPN when there's something to do:
//   - a game should be over (3+ hours after kickoff) but isn't marked final yet, or
//   - the once-a-day schedule check is due (picks up next week's games and time changes).
// Live, in-progress scores are ignored on purpose.
// Once a week (Tuesdays, or when STATS=1) it also refreshes team records and top players in teams.json.
// Runs inside GitHub Actions on a timer. Safe to run by hand: `node scripts/update.mjs`.
import { readFile, writeFile, appendFile } from "node:fs/promises";

// In GitHub Actions, also surface messages as annotations so they show on the run summary.
const GH = !!process.env.GITHUB_ACTIONS;
const warn = (m) => { console.error(m); if (GH) console.log(`::warning::${String(m).replace(/\n/g, " ")}`); };
const note = (m) => { console.log(m); if (GH) console.log(`::notice::${String(m).replace(/\n/g, " ")}`); };
process.on("uncaughtException", (e) => { console.log(`::error::Update failed: ${e && e.stack ? e.stack.split("\n").slice(0, 3).join(" | ") : e}`); process.exit(1); });
process.on("unhandledRejection", (e) => { console.log(`::error::Update failed: ${e && e.stack ? e.stack.split("\n").slice(0, 3).join(" | ") : e}`); process.exit(1); });

const ROOT = new URL("../", import.meta.url);
const GAMES = new URL("games.json", ROOT);
const TEAMS = new URL("teams.json", ROOT);
const FIXTURES = process.env.FIXTURE_DIR; // tests only
const API = "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard";

// ESPN abbreviation -> the site's abbreviation
const ABBR = { WSH: "WAS" };
const KNOWN = new Set(["ARI","ATL","BAL","BUF","CAR","CHI","CIN","CLE","DAL","DEN","DET","GB","HOU","IND","JAX","KC","LV","LAC","LAR","MIA","MIN","NE","NO","NYG","NYJ","PHI","PIT","SF","SEA","TB","TEN","WAS"]);
const ab = (a) => ABBR[a] || a;

async function getJSON(url, fixtureName) {
  if (FIXTURES) return JSON.parse(await readFile(`${FIXTURES}/${fixtureName}`, "utf8"));
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await fetch(url, { headers: { "user-agent": "group-parlay-bot" } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) {
      if (attempt === 3) throw new Error(`${url}: ${e.message}`);
      await new Promise((res) => setTimeout(res, 2000 * attempt));
    }
  }
}
const readJSON = async (u, fallback) => { try { return JSON.parse(await readFile(u, "utf8")); } catch { return fallback; } };

// Regular season weeks are 1-18. Playoff rounds are stored as weeks 19-22 so they sort after.
const siteWeek = (type, n) => (type === 3 ? 18 + n : n);

function toGame(ev, weekNo) {
  const c = ev.competitions?.[0];
  if (!c) return null;
  const home = c.competitors.find((t) => t.homeAway === "home");
  const away = c.competitors.find((t) => t.homeAway === "away");
  if (!home || !away) return null;
  const h = ab(home.team.abbreviation), a = ab(away.team.abbreviation);
  if (!KNOWN.has(h) || !KNOWN.has(a)) return null; // skips Pro Bowl etc.
  const st = c.status?.type || ev.status?.type || {};
  const g = {
    id: `w${weekNo}-${a}-${h}`.toLowerCase(),
    away: a,
    home: h,
    kickoff: new Date(c.date || ev.date).toISOString(),
    status: st.completed ? "final" : st.name === "STATUS_POSTPONED" || st.name === "STATUS_CANCELED" ? "off" : "scheduled",
  };
  if (g.status === "final") g.score = { away: Number(away.score) || 0, home: Number(home.score) || 0 };
  if (g.status === "final") g.winner = home.winner ? "home" : away.winner ? "away" : g.score.home > g.score.away ? "home" : g.score.away > g.score.home ? "away" : "tie";
  return { game: g, records: { [h]: home.records?.[0]?.summary, [a]: away.records?.[0]?.summary } };
}

async function fetchWeek(type, n, year) {
  const data = await getJSON(`${API}?seasontype=${type}&week=${n}&dates=${year}`, `scoreboard-${type}-${n}.json`);
  const weekNo = siteWeek(type, n);
  const games = [], records = {};
  for (const ev of data.events || []) {
    const r = toGame(ev, weekNo);
    if (!r) continue;
    games.push(r.game);
    Object.assign(records, r.records);
  }
  games.sort((x, y) => x.kickoff.localeCompare(y.kickoff) || x.id.localeCompare(y.id));
  return { week: weekNo, label: type === 3 ? ["Wild Card", "Divisional", "Conference", "Pro Bowl", "Super Bowl"][n - 1] : undefined, games, records };
}

// ---------- weekly player stats (best effort) ----------
const SLUG = { WAS: "wsh" };
function flat(sg) { const o = {}; const walk = (a) => { for (const s of a) { if (s.stats && !("value" in s)) walk(s.stats); else if (s.name) o[s.name] = s.value; } }; walk(sg.stats || []); return o; }
async function teamLeaders(abbr) {
  const r = await fetch(`https://www.espn.com/nfl/team/stats/_/name/${SLUG[abbr] || abbr.toLowerCase()}`, { headers: { "user-agent": "Mozilla/5.0 group-parlay-bot" } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const h = await r.text();
  const i = h.indexOf("window['__espnfitt__']=");
  if (i < 0) throw new Error("stats blob not found");
  const s = h.indexOf("{", i), e = h.indexOf(";</script>", s);
  const stats = JSON.parse(h.slice(s, e)).page.content.stats;
  const P = {};
  const get = (n) => (P[n] = P[n] || { o: 0, d: 0, pos: "", line: {} });
  for (const grp of stats.playerStats) for (const row of grp) {
    const a = row.athlete, g = row.statGroups, t = Array.isArray(g.type) ? "defense" : g.type, v = flat(g), p = get(a.name);
    p.pos = a.position || p.pos;
    if (t === "passing") { p.o += (v.passingYards || 0) / 25 + (v.passingTouchdowns || 0) * 4 - (v.interceptions || 0) * 2; p.line.pass = `${v.passingYards || 0} pass yds, ${v.passingTouchdowns || 0} TD, ${v.interceptions || 0} INT`; }
    if (t === "rushing") { p.o += (v.rushingYards || 0) / 10 + (v.rushingTouchdowns || 0) * 6; if (v.rushingYards >= 100) p.line.rush = `${v.rushingYards} rush yds, ${v.rushingTouchdowns || 0} TD`; }
    if (t === "receiving") { p.o += (v.receivingYards || 0) / 10 + (v.receptions || 0) * 0.5 + (v.receivingTouchdowns || 0) * 6; if (v.receivingYards >= 80) p.line.rec = `${v.receptions || 0} rec, ${v.receivingYards} yds, ${v.receivingTouchdowns || 0} TD`; }
    if (t === "defense") {
      p.d += (v.totalTackles || 0) + (v.sacks || 0) * 4 + (v.tacklesForLoss || 0) * 1.5 + (v.interceptions || 0) * 5 + (v.passesDefended || 0) * 1.5 + (v.fumblesForced || 0) * 3 + (v.fumblesRecovered || 0) * 2 + (v.interceptionTouchdowns || 0) * 6;
      const b = [`${v.totalTackles || 0} tkl`]; if (v.sacks) b.push(`${v.sacks} sk`); if (v.interceptions) b.push(`${v.interceptions} INT`); if (v.passesDefended) b.push(`${v.passesDefended} PD`); if (v.fumblesForced) b.push(`${v.fumblesForced} FF`);
      p.line.def = b.join(", ");
    }
  }
  const arr = Object.entries(P);
  const off = arr.filter(([, p]) => p.o > 0 && !["K", "P", "LS"].includes(p.pos)).sort((x, y) => y[1].o - x[1].o).slice(0, 3)
    .map(([n, p]) => ({ n, p: p.pos, s: [p.pos === "QB" ? p.line.pass : null, p.line.rush, p.line.rec].filter(Boolean).join(" · ") }));
  const def = arr.filter(([, p]) => p.d > 0).sort((x, y) => y[1].d - x[1].d).slice(0, 3).map(([n, p]) => ({ n, p: p.pos, s: p.line.def }));
  if (off.length < 3 || def.length < 3) throw new Error("not enough players");
  return { off, def };
}

// ---------- main ----------
const games = await readJSON(GAMES, { season: null, weeks: [] });
const teams = await readJSON(TEAMS, { teams: {} });
const beforeGames = JSON.stringify(games.weeks), beforeTeams = JSON.stringify(teams);

const now = process.env.NOW ? new Date(process.env.NOW) : new Date();
const HOUR = 36e5;
const fromSite = (w) => (w > 18 ? [3, w - 18] : [2, w]);

// 1) Games that should be over by now but don't have a final yet (checked for up to 2 days after kickoff).
const due = new Set();
for (const w of games.weeks) for (const g of w.games || []) {
  const age = now - new Date(g.kickoff);
  if (g.status === "scheduled" && age >= 3 * HOUR && age <= 48 * HOUR) due.add(w.week);
}

// 2) Once-a-day schedule check (first run after 10:00 UTC, about 6 AM Eastern), or if forced.
const lastSched = games.scheduleChecked ? new Date(games.scheduleChecked) : new Date(0);
const schedDue = process.env.FORCE === "1" || !games.weeks.length ||
  (now - lastSched >= 20 * HOUR && now.getUTCHours() >= 10);

if (!due.size && !schedDue) {
  console.log("Nothing to check right now");
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, "changed=false\n");
  process.exit(0);
}

const targets = new Map(); // "type-n" -> [type, n]
let year = games.season;
if (schedDue) {
  const cur = await getJSON(API, "scoreboard-default.json");
  year = cur.season?.year;
  const type = cur.season?.type, n = cur.week?.number;
  const add = (t, w) => targets.set(`${t}-${w}`, [t, w]);
  if (type === 2) { add(2, n); if (n < 18) add(2, n + 1); else add(3, 1); if (n > 1) add(2, n - 1); }
  else if (type === 3) { add(3, n); if (n < 5) add(3, n + 1); if (n > 1) add(3, n - 1); else add(2, 18); }
  else if (type === 1) add(2, 1); // preseason: just load Week 1
  if (games.season && games.season !== year) games.weeks = []; // new season, start fresh
  games.season = year;
}
for (const w of due) { const [t, n] = fromSite(w); targets.set(`${t}-${n}`, [t, n]); }
note(`Checking ${[...targets.keys()].join(", ")}${schedDue ? " (daily schedule check)" : " (games that should be over)"}`);

const records = {};
for (const [t, w] of targets.values()) {
  try {
    const wk = await fetchWeek(t, w, year);
    if (!wk.games.length) continue;
    Object.assign(records, wk.records);
    const i = games.weeks.findIndex((x) => x.week === wk.week);
    const entry = { week: wk.week, ...(wk.label ? { label: wk.label } : {}), games: wk.games };
    if (i >= 0) games.weeks[i] = entry; else games.weeks.push(entry);
  } catch (e) {
    warn(`Week ${t}-${w} failed: ${e.message}`);
  }
}
games.weeks.sort((a, b) => a.week - b.week);

for (const [k, rec] of Object.entries(records)) if (rec && teams.teams[k]) teams.teams[k].rec = rec;

const daysOld = teams.updated ? (now - new Date(teams.updated)) / 864e5 : 99;
if (!FIXTURES && (process.env.STATS === "1" || (now.getUTCDay() === 2 && daysOld > 4))) {
  let ok = 0;
  for (const k of KNOWN) {
    try { const l = await teamLeaders(k); teams.teams[k] = { ...(teams.teams[k] || {}), ...l }; ok++; }
    catch (e) { warn(`Stats for ${k} failed: ${e.message}`); }
  }
  if (ok >= 28) {
    teams.updated = now.toISOString().slice(0, 10);
    const done = games.weeks.filter((w) => w.week <= 18 && w.games.length && w.games.every((g) => g.status === "final" || g.status === "off")).map((w) => w.week);
    if (done.length) teams.through = `Week ${Math.max(...done)}`;
  }
  note(`Refreshed stats for ${ok} teams`);
}

const changedGames = JSON.stringify(games.weeks) !== beforeGames;
if (schedDue) games.scheduleChecked = now.toISOString();
const changedTeams = JSON.stringify(teams) !== beforeTeams;
if (changedGames) games.updated = now.toISOString();
if (changedGames || schedDue) await writeFile(GAMES, JSON.stringify(games, null, 1) + "\n");
if (changedTeams) await writeFile(TEAMS, JSON.stringify(teams) + "\n");
const changed = changedGames || changedTeams || schedDue;
note(changed ? "Updated games/teams" : "No changes");
if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `changed=${changed}\n`);
