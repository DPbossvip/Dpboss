# Market Result Board — mobile and bug-fix update

## Features added
- Dynamic market manager (add, rename, change open/close times, delete)
- Starter markets: Mahadev (3 PM–6 PM) and Mahadev Night (7 PM–10 PM)
- Per-market manual result entry: Open Panna, Jodi, Close Panna
- Draft / publish / unpublish controls
- Public result board and date-wise history with market filter and search
- Admin dashboard counts
- Admin change log
- Download JSON backup and restore from a JSON backup file
- Responsive mobile layout with safe-area spacing and horizontally contained history tables

## Install / run in Termux
```sh
pkg update
pkg install nodejs-lts unzip nano openssl
termux-setup-storage
cd ~
unzip ~/storage/downloads/dpboss-market-board.zip
cd ~/dpboss-market-board
cp .env.example .env
```
Set your credentials without opening nano using this command (it asks for the password invisibly):
```sh
cd ~/dpboss-market-board
read -s -p "Admin password (12+ chars): " APASS; echo
[ ${#APASS} -ge 12 ] || { echo "Password too short"; unset APASS; exit 1; }
printf "PORT=3002\nSESSION_SECRET=%s\nADMIN_USERNAME=dpbossadmin\nADMIN_PASSWORD=%s\n" "$(openssl rand -hex 32)" "$APASS" > .env
chmod 600 .env
unset APASS
npm install
npm start
```
Open `http://127.0.0.1:3002`; admin login is at `http://127.0.0.1:3002/login`.
Username is `dpbossadmin`; password is the one you entered.

## Important
This is a local testing starter. It uses Express's default in-memory session store and local JSON data; do not expose it directly to the public internet. Before online hosting, add persistent sessions, HTTPS secure cookies, rate limiting, CSRF protection, backups and production configuration. Keep `.env` and backup files private.

## Automatic panna calculation
- Admin enters only Open Panna and Close Panna.
- Open Ank = sum of the three digits, last digit (sum modulo 10). Example: 119 -> 1.
- Close Ank is calculated independently. Example: 169 -> 6.
- Jodi is generated as Open Ank + Close Ank; example above gives 16.
- Panna input accepts any three digits, including digits in any order (for example, 391, 910 or 111). The input is not sorted or rearranged.
- This is a deterministic display calculation based on the entered panna, not a prediction of a future result.


## v1.4 change notes
- Removed the outdated public bottom-navigation label.
- Removed the ascending-digit rule for Open/Close Panna; the entered three-digit value is retained exactly as typed.
- Fixed strict calendar date validation so impossible dates such as 2026-02-30 are rejected.
- Uses India Standard Time (Asia/Kolkata) for the default result date rather than a UTC date.
- Fixed result-preview targeting when multiple market forms are shown on the admin page.
- Improved narrow-screen spacing and contained wide history tables so they do not widen the whole page.

History is still shown newest-date-first; that ordering is separate from the three digits inside a Panna.


## v1.6 chart update
- Jodi and Panel shortcuts now open dedicated chart pages for the selected market.
- Jodi chart groups saved, published results by Monday-to-Saturday weeks, matching the six-column reference layout. Sunday results, when present, are listed separately so they are not lost.
- Panel chart groups results by Monday-to-Sunday week, with date ranges and Open Panna / Jodi / Close Panna values in each day cell.
- Both chart tables are responsive and fit the phone screen width without horizontal page scrolling.
- Chart rows use only result data already saved and published; no historical values are fabricated.


## Deploy on Render with GitHub
1. Upload this project folder's contents to a private GitHub repository. Do not commit `.env`, `data/`, passwords, or backups.
2. In Render, create **New + → Web Service** and connect that repository.
3. Use Runtime `Node`, Build Command `npm install`, Start Command `npm start`.
4. Add environment variables in Render: `NODE_ENV=production`, `SESSION_SECRET` (a random value of at least 32 characters), `ADMIN_USERNAME` (your chosen admin username), and `ADMIN_PASSWORD` (a unique password of at least 12 characters). Do not use the example password. Render supplies `PORT` automatically.
5. Deploy, then open the `onrender.com` URL. Admin login is at `/login`.

### Important data warning
The app stores results in a JSON file. Render's ordinary filesystem may be ephemeral, so results can be lost on redeploy/restart unless you attach a persistent disk and set `DATA_DIR` to its mount path (for example `/var/data`, if that is the disk mount path configured in Render). Back up results before deployment. Sessions use the default in-memory store, so admin sessions end when the service restarts; for higher reliability, use a persistent session store before production use.


## v2.4 Jodi chart date layout\n- Added a readable Date column to the Jodi chart with a weekly date range.\n- Jodi table uses a fixed minimum width and horizontal scrolling on narrow phones so date labels do not wrap into many lines.\n\n## v2.0 five-year sample chart
- Added a public 5-Year Sample Chart page for 2022–2026 with a year selector and phone-friendly monthly grid.
- Values are deterministic synthetic sample numbers, clearly labelled as sample-only; they are not actual historical results.
- Existing market results, admin routes, and saved data structures are unchanged.

## DPBOSS-style redesign notes
- Rebranded the interface as DPBOSS with a responsive orange/cream/navy market-board layout.
- Public navigation includes Home, Jodi Chart, Panel Chart and History.
- Jodi and Panel charts use only saved, published results; the synthetic five-year sample chart has been removed.
- Configure API credentials only in Render Environment or a private local `.env`; never commit trial keys.
- This is an independent implementation inspired by common market-result board layouts, not DPBOSS proprietary source code or assets.

## SattaAPI live result integration

The project uses only the SattaAPI endpoint supplied in the PHP integration kit:

`https://matkaapi.sattaapi.com/wp-json/satta/v1/results`

Configure these private environment variables in Render (do not commit real credentials):

- `SATTA_API_URL` = the endpoint above
- `SATTA_API_KEY` = your active API key
- `SATTA_DOMAIN_KEY` = your active domain key
- `SATTA_API_DOMAIN` = `dpboss-54z9.onrender.com`
- `SATTA_API_REFRESH_MS` = refresh interval in milliseconds (default 300000 / 5 minutes; minimum 60000)

The server sends a JSON POST body with `api_key`, `domain_key`, and `domain`, matching the PHP kit. It reads results from `results.data`. Admins can run an immediate sync from Admin → API Sync. Automatic sync starts only when all three credentials are configured. Existing admin-entered results are protected; an API refresh will not overwrite them. An already saved close result is retained if the provider temporarily returns an empty close value. Existing market names and configured timings are preserved.

Never commit real API credentials to GitHub. Rotate credentials that have been shared in chat or public locations.
