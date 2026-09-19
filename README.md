# MAHNGUELOH Developer API — Railway Ready (v1.2)

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

## Storage note

Downloaded files live on the service's temporary disk and expire after `FILE_TTL_SECONDS`. They are also cleared on restart or redeploy. This is intentional: files are short-lived delivery artifacts, not permanent storage.

## Security

- Blocks localhost, private ranges, cloud metadata (169.254.x.x) and `*.internal` hosts, including via DNS tricks and redirects.
- API keys are stored as SHA-256 hashes. Admin key comparison is constant-time.
- Per-key and per-IP rate limits, concurrency cap, storage cap, size cap, idle and total timeouts.
- Keep `ADMIN_API_KEY` private and never commit `.env`.
