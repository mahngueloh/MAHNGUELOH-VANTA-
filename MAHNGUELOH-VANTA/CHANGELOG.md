# MAHNGUELOH VANTA 3.4.3 — Merged Release Notes

## What's genuinely new in this release
- Sports commands are now generated from one league/type registry (`getSportsCommands()`),
  so the command list can't drift out of sync with what's actually implemented.
  Added aliases (`.pl`, `.prem`, `.liga`, `.bundes`, `.champions`, `.europa`, `.worldcup`, etc.)
  and type aliases (`table`, `results`, `fixtures`, `next`).
- Match results/upcoming are now explicitly sorted by kickoff date before display
  (previously assumed the API already returned them sorted).
- `.sports` / `.sport` shows the valid command family.
- Added a lightweight, optional personality layer on plain text replies — toggle with
  `.funmode on|off` (default: on, ~45% of replies get a line, configurable via
  `FUN_RESPONSES` / `FUN_RESPONSE_CHANCE` in `.env`).
- `npm run audit:bot` — syntax-checks every file, validates the sports registry, and
  scans for hardcoded credential literals **everywhere**, config.js included.
- **Session ID no longer overwrites a live, already-registered `auth_info/creds.json`
  on every reconnect.** This was a real bug: every reconnect was re-decoding the
  original SESSION_ID snapshot and rewriting it over the current (more advanced)
  Signal session state — which can roll the ratchet backward and manufacture the
  exact Bad MAC symptoms this project spent a long time chasing.
- Bad MAC recovery is now targeted: it identifies the specific `session-*.json`
  file(s) implicated by the error instead of wiping the whole auth database, with
  a cooldown so recovery attempts can't storm.
- `connect()` is now serialized (a single in-flight connection attempt at a time)
  and stale sockets from a previous generation can no longer interfere with a
  newer one.
- Updated Baileys 6.7.23 → 6.7.24.

## Correcting a claim from an earlier version of these notes
An earlier changelog claimed hardcoded AI credentials had been "removed from
config.js." **That was not accurate** — the previous release still shipped a real,
live OpenAI key hardcoded as a fallback default in `config.js`. It's genuinely
removed now (verified via `npm run audit:bot`, which itself was previously
written to skip scanning config.js — that exemption has been removed too, since
this project gets pushed to GitHub via `.updatecode` and handed out as a
template, so "centralized in one file" was never actually safe).

**If you're the person who deployed this in earlier form: rotate your OpenAI key.**

## An advertised feature that was never actually implemented
An earlier changelog also claimed a "persistent AI Code Agent" with `.agent`,
`.remember`, `.agentrefresh`, and `.agentstatus` commands. None of those exist
anywhere in the delivered code — no trace of them at all. Treat that changelog
entry as false; it isn't in this release either, since it was never real.

## Setup
1. `.env` ships with this zip, blank, ready to fill in — no `npm install`/Start
   cycle needed just to see it.
2. Fill in **either** `SESSION_ID` or `PHONE_NUMBER` in `.env` (not `config.js` —
   `.env` is git-ignored and never committed; a value pasted into `config.js`
   risks being published the moment this gets pushed anywhere).
3. Start the bot.
4. Optional AI providers: set any of `OPENAI_API_KEY`, `GEMINI_API_KEY`,
   `ANTHROPIC_API_KEY`, `DEEPSEEK_API_KEY`, `SAVAGE_API_KEY` in `.env`. All are
   optional; leaving one blank just disables that provider.

## Round 2: merging a further "Mahngueloh-MD.zip" export
- Added the `.agent`/`.remember`/`.agentrefresh`/`.agentstatus` code agent
  commands — this time they genuinely exist and work (verified: owner-gated,
  built on the existing safe file-exclusion boundary in `lib/codeContext.js`).
- The exact same hardcoded OpenAI/Gemini/Savage keys from before showed up
  again in this export's `config.js`, and `scripts/audit.js` had reverted to
  exempting config.js from its own credential scan. Both fixed again. If
  you're regenerating zips from an earlier saved copy/conversation elsewhere,
  every regeneration is bringing the leaked key back — that source copy
  should be treated as compromised and not reused as a base going forward.
- Two more false claims found and corrected — see `AI_AGENT.md`: a claimed
  Ollama/local-model provider that doesn't exist in the code, and a claimed
  `.mycode` upgrade that never actually happened.
