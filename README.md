# Group Parlay

Friends make a profile (name + favorite white hooper) and vote on every NFL game. The majority side of each game becomes a leg of the week's group parlay.

**Games and results update by themselves.** A GitHub job wakes every 5 minutes but only contacts ESPN's public scoreboard when there's something to do:
- **After games:** once a game is 3 hours past kickoff, it checks every 5 minutes until the final score is in, then marks the winner.
- **Once a day:** around 6 AM Eastern it picks up next week's games and any time changes.

It doesn't track live, in-progress scores. On Tuesdays it also refreshes team records and each team's top 3 players on offense and defense.

## How it fits together

| Piece | Job |
|---|---|
| GitHub Pages | Hosts the website (free) |
| GitHub Actions | Runs the update job (`.github/workflows/update.yml`) |
| Firebase | Stores profiles and votes |

## Files

| File | What it is |
|---|---|
| `index.html` | The app |
| `firebase-config.js` | Connection to your Firebase project |
| `firestore.rules` | Database security rules (pasted into Firebase) |
| `games.json` | Schedule and results, written by the update job |
| `teams.json` | Team records and top players, written by the update job |
| `scripts/update.mjs` | The update job |

## Running the job by hand

On GitHub, go to **Actions → Update games and publish site → Run workflow**. Tick **Re-check the schedule now** to pick up schedule changes right away, or **Also refresh team records and top players** to pull fresh stats.

## Good to know

- Results usually show up 5–10 minutes after a game ends. GitHub sometimes runs timed jobs a few minutes late.
- Votes lock **Sunday at 12:45 PM Eastern**, 15 minutes before the 1 PM games. Games that kick off earlier (Thursday night, London) lock at their own kickoff. They count toward the leaderboard but aren't on the parlay slip.
- The site has three tabs: **Vote**, **Leaderboard** (each person's record by week and overall, plus slip history) and **Parlay Slip** (projected until the lock, then locked and graded as games finish).
- If the majority pick ties its game, that leg counts as a push and doesn't bust the slip.
- A tied vote between friends keeps that game off the slip until someone breaks the tie.
- Profiles are tied to the browser they were made in.
- ESPN's scoreboard isn't an official public API. If it ever changes, the job will log an error under **Actions**, and the site keeps working with the last saved results.
