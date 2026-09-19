# MAHNGUELOH Developer API — Railway Ready (v1.5)

A Node.js/Express API and web dashboard for retrieving files from **publicly accessible HTTP/HTTPS URLs**.
It does not bypass authentication, DRM, paywalls, private resources, or other access controls, and it refuses to fetch anything on private/internal networks.

## Deploy on Railway

**1. Put the files at the ROOT of your GitHub repo.**
When you open the repo on GitHub you must see `package.json`, `railway.json` and `src/` immediately, not inside another folder.
If you see a single folder (e.g. `MAHNGUELOH-DEVELOPER-API-RAILWAY-READY/`), Railway cannot detect the app and the build fails with
"Railpack failed to prepare the build". Unzip first and upload the *contents* of the folder.

**2.** In Railway: New Project → Deploy from GitHub repo → pick the repo.

**3.** Add these variables (Service → Variables):

| Variable | Value |
| --- | --- |
| `ADMIN_API_KEY` | **Required.** A long random secret. Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `DATA_DIR` | `/data` (see step 4) |
| `MAX_FILE_MB`, `DOWNLOAD_TIMEOUT_MS`, `FILE_TTL_SECONDS`, `RATE_LIMIT_PER_MINUTE` | Optional, defaults are fine |
| `DEMO_API_KEY` | Optional test key. Leave unset in production. |

Do **not** set `PORT`. Railway provides it.

**4. (Recommended) Add a Volume** mounted at `/data`. API keys are saved there (hashed), so they survive redeploys. Without a volume, every redeploy deletes all developer keys.

**5.** Settings → Networking → Generate Domain. Open `/health` to confirm it is running.

## Create a developer API key

`POST /api/keys` with header `Authorization: Bearer YOUR_ADMIN_API_KEY` and body `{"name":"My Developer"}`.
The response contains the new key **once**. Only a hash is stored, so it cannot be shown again.

## Download endpoint

`POST /v1/download`

Headers: `Authorization: Bearer YOUR_API_KEY`, `Content-Type: application/json`
Body: `{"url":"https://example.com/file.zip"}`

The response contains a temporary `download_url`.

| Status | Meaning |
| --- | --- |
| 400 | Invalid or disallowed URL (private address, non-HTTP, etc.) |
| 401 | Missing or invalid API key |
| 429 | Rate limit hit, or too many downloads running |
| 502 | The remote file could not be fetched (timeout, too large, remote error) |
| 503 | Temporary storage full |

## AI endpoint

Provider keys stay on the server (Railway variables). Set at least one of `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, or the `COMPAT_*` trio. Check `/health`: the `ai_providers` list shows which are active.

`POST /v1/ai` with `Authorization: Bearer YOUR_API_KEY`:

`{"prompt":"who are you?","system":"(optional)","history":[{"role":"user","content":"..."},{"role":"assistant","content":"..."}]}`

Response: `{"success":true,"answer":"...","provider":"gemini","model":"..."}`

If no `system` is sent, the AI introduces itself as `AI_NAME` (default MAHNGUELOH VANTA), built by `AI_OWNER`.

**Drop-in routes for existing bots:** `GET /ai/claude3opus`, `/ai/deepseekcoder`, `/ai/chat` with `?apikey=KEY&prompt=TEXT` return the same `{success, answer}` shape. Point a bot at this API by setting its base URL and key. The `provider`/`model` fields always tell the truth about which model answered. Keys in URLs can show up in logs, so use `POST /v1/ai` for anything new.

## Interactive docs

Open `/docs` on your deployed URL: categories, a Try-it-out panel per endpoint, and a copyable curl command. Paste your API key once at the top. The list comes from `src/catalog.js`, so new endpoints show up there automatically once added.

## Sports

Football data from football-data.org, same paths the old relay used: `/sports/matches` (Premier League), `/sports/laliga-matches`, `/sports/bundesliga-matches`, `/sports/seriea-matches`, `/sports/ligue1-matches`, `/sports/champions-league-matches`, `/sports/epl-standings`, `/sports/epl-scorers`.
Matches take `dateFrom` + `dateTo` (YYYY-MM-DD, used together) and `status` (SCHEDULED, LIVE, FINISHED...). Replies are `{"success":true,"data":{...}}`.
Set `FOOTBALL_DATA_TOKEN` in Railway. Results are cached (1 min for matches, 5 min for standings/scorers) and upstream calls are capped so the free plan is not exhausted.

## Music

`GET /music/search?apikey=KEY&q=chill+piano` searches openly-licensed catalogs (Jamendo and Openverse) and returns `results[]` with `title`, `artist`, `duration`, `thumbnail`, `audio:[{quality,url}]`, `license`, `license_url` and a ready-made `attribution` line. Options: `limit` (1-25) and `commercial=true` (only licences that allow commercial use).
Creative Commons music must be credited, so show the `attribution` text wherever you play or share a track. This catalog is independent and Creative Commons music, not mainstream chart songs. To host a copy, pass a result's `audio[0].url` to `POST /v1/download`.

## Reply envelope

Every JSON reply that has a `success` field also carries `operator`, `timestamp` and `responseTime`.

## Storage note

Downloaded files live on the service's temporary disk and expire after `FILE_TTL_SECONDS`. They are also cleared on restart or redeploy. This is intentional: files are short-lived delivery artifacts, not permanent storage.

## Security

- Blocks localhost, private ranges, cloud metadata (169.254.x.x) and `*.internal` hosts, including via DNS tricks and redirects.
- API keys are stored as SHA-256 hashes. Admin key comparison is constant-time.
- Per-key and per-IP rate limits, concurrency cap, storage cap, size cap, idle and total timeouts.
- Keep `ADMIN_API_KEY` private and never commit `.env`.
