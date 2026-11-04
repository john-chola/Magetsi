# Magetsi: load-shedding schedule, alerts and outage log (Zambia)

Households see their area's ZESCO load-shedding schedule, get alerts before power goes off and before it comes back, and log real outages with one tap. Those logs show how well each area's schedule is kept: on-schedule %, extra hours, and late restoration.

- **Push alerts** reach phones even when the app is closed (Web Push).
- **SMS alerts** work on any phone, with no data needed (through Africa's Talking).
- **Up to 5 saved areas** per phone (home, work, family). Alerts cover all of them.
- **A public dashboard** at `/dashboard` compares every area, with a CSV download.
- **Towns:** Lusaka, Kitwe, Ndola, Kabwe and Livingstone.

## Run it (Node.js 22.5 or newer, nothing to install)

```bash
npm start            # or: node server.js
# app: http://localhost:3000   admin: /admin   dashboard: /dashboard
npm test             # 43 unit + API tests
npm run build:demo   # dist/magetsi-demo.html, a single file that runs with no server (no push/SMS)
```

- The first run creates `magetsi.db` (SQLite) with 55 areas in 5 towns, a demo 6-group rotation, and 7 days of synthetic household reports. Set `SEED_DEMO=0` for an empty schedule.
- An existing database is upgraded on start: new tables are created and new areas from `public/core.js` are added. Existing data is kept.
- Delete `magetsi.db` to start fresh.
- Runs fine on a low-spec laptop: no npm packages and no build step.

## Settings (environment variables)

| Variable | What it does |
| --- | --- |
| `ADMIN_TOKEN` | Password for signing in at `/admin`. If unset, a random one is printed at start (and changes on every restart). |
| `VAPID_SUBJECT` | `mailto:you@yourdomain` or an `https://` URL. Push services use it to contact you. Set this in production. |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | Optional. If unset, keys are generated once and stored in the database. If you change keys, phones re-subscribe the next time they open the app. |
| `AT_API_KEY`, `AT_USERNAME` | Africa's Talking credentials. With no key, SMS runs in **log mode**: messages are printed and shown on `/admin`, not sent. `AT_USERNAME=sandbox` uses their sandbox. |
| `AT_SENDER_ID` or `AT_SHORTCODE` | Sender for outgoing SMS. `AT_SHORTCODE` is also shown in the app ("text JOIN CHILENJE to …"). |
| `SMS_INBOUND_KEY` | Secret for the incoming-SMS webhook (defaults to `ADMIN_TOKEN`). |
| `SMS_DAILY_LIMIT` | Cost guard: maximum SMS per day (default 2000). |

## How alerts work

Every minute the server works out which alerts are due for every push subscription and SMS subscriber, using the same rules the app uses (`dueAlerts` and `smsDue` in `public/core.js`). Each alert is sent once. A failed send is retried the next minute. Subscriptions the browser has dropped are deleted.

**Push:** when someone allows notifications, the app subscribes and sends the server its saved areas and settings. If push isn't available (demo mode, an unsupported browser, or iPhone without adding Magetsi to the home screen), the phone falls back to its own reminders, which need the app open. The server only sends to browser push services (Google, Mozilla, Microsoft, Apple). Change that list with `PUSH_ENDPOINT_HOSTS`.

**SMS:** there are two messages, each one SMS long:
- today's times, sent once between 05:30 and 07:00;
- a reminder 30 or 60 minutes before each outage (none from 23:00 to 05:00).

There are two ways to sign up:
1. **From the app** (Alerts tab): enter a number and area, then type in the 6-digit code that arrives by SMS. This means nobody can sign up someone else's number.
2. **By texting** the shortcode: `JOIN CHILENJE`, `TIMES`, `STOP`, `HELP`. A bare area name also works, and a leading `MAGETSI` keyword is ignored.

To connect Africa's Talking, set the incoming-messages callback to `https://your-host/api/sms/inbound?key=SMS_INBOUND_KEY`. You can try commands without a shortcode in the "Try an incoming SMS" box on `/admin`.

## Admin page

`/admin` shows only a sign-in form until someone enters `ADMIN_TOKEN`. The admin page itself is in `admin/`, outside `public/`, so it can't be fetched directly.

- Signing in sets a session cookie (HttpOnly, SameSite=Strict, and Secure over HTTPS). It lasts 12 hours, or until **Sign out**. The database stores only a hash of the session id.
- Sign-in allows 10 attempts per IP address per 15 minutes. Behind a tunnel or proxy, every visitor shares the proxy's IP, so a flood of wrong guesses also locks out the real admin for 15 minutes.
- Scripts can call `/api/admin/*` with an `X-Admin-Token` header instead of a session.
- Everyone who signs in shares the same token; there are no individual admin accounts. Use a long random `ADMIN_TOKEN` and serve the site over HTTPS.

## Importing a real schedule

Sign in at `/admin` and paste CSV in Zambia time (CAT, UTC+2):

```
group,date,start,end
B,2026-11-02,06:00,10:00
C,2026-11-02,22:00,02:00   <- end before start = runs past midnight
```

The towns, areas and group mapping in `public/core.js` (`TOWN_AREAS`) are **illustrative**. Replace them with ZESCO's published lists. Area ids must stay stable: only add new areas at the end of a town's list or as a new town, and never reorder.

## Testing on your phone

Browsers allow notifications and push only on `localhost` or HTTPS. To try it on a phone, use a tunnel:
`cloudflared tunnel --url http://localhost:3000`, then open the https link on the phone and choose "Add to Home screen". On iPhone (iOS 16.4+), push only works after adding Magetsi to the home screen.

## Files

| File | What it does |
| --- | --- |
| `server.js` | HTTP server, SQLite, REST API, rate limits, the alert loop, dashboard, 24 h auto-close |
| `lib/webpush.js` | Web Push with no packages: VAPID (RFC 8292) and payload encryption (RFC 8291), with a check against the RFC test vector |
| `lib/sms.js` | Africa's Talking sender, with log mode |
| `public/core.js` | Shared by server and browser: schedule maths, adherence, alert rules, SMS commands, CSV, towns and areas, demo data |
| `public/app.js` | The PWA: Now / Schedule / Reliability / Alerts, saved areas, push subscription, SMS sign-up, demo fallback |
| `public/index.html` | Markup and styles |
| `public/sw.js` | Offline cache, push messages, notification clicks |
| `public/dashboard.html` | Public adherence dashboard |
| `admin/admin.html` | Admin page (sent only to signed-in sessions): schedule CSV import, alert overview, SMS outbox and test box |
| `admin/login.html` | Admin sign-in form |
| `test/` | `node --test` suites |

## API

| Method and path | Does |
| --- | --- |
| `GET /api/areas` | Areas (with town), groups, towns |
| `GET /api/schedule?area=ID&days=7` | Slots for the area's group |
| `GET /api/status?area=ID&device=D` | Scheduled state, next change, live community reports, your open outage |
| `GET /api/stats?area=ID&days=7` | Adherence (hidden under 3 reporting households) |
| `GET /api/dashboard?days=7\|30` | Adherence for every area |
| `GET /api/dashboard.csv?days=7\|30` | The same as a CSV download |
| `POST /api/outages/off` `{area, device}` | Power went off |
| `POST /api/outages/on` `{device}` | Power is back |
| `POST /api/outages` `{area, device, off_at, on_at}` | Log a past outage (ms timestamps) |
| `GET /api/push/key` | VAPID public key |
| `POST /api/push/subscribe` `{device, subscription, areas, settings}` | Save or update this phone's push subscription |
| `POST /api/push/unsubscribe` `{device}` | Remove it |
| `POST /api/push/test` `{device}` | Send a test push |
| `GET /api/sms/info` | SMS mode and shortcode |
| `POST /api/sms/start` `{device, phone, area, daily, before}` | Send a sign-up code |
| `POST /api/sms/verify` `{device, phone, code}` | Confirm the code; alerts start |
| `POST /api/sms/stop` `{device, phone}` | Stop (only from the device that signed up) |
| `POST /api/sms/inbound?key=K` form `from, text` | Africa's Talking incoming-SMS webhook |
| `POST /admin/login` form `token` · `POST /admin/logout` | Sign the admin in or out |
| `POST /api/admin/slots` `{csv, replace}` (admin session or `X-Admin-Token`) | Import schedule |
| `GET /api/admin/overview` (admin session or `X-Admin-Token`) | Subscriber counts and recent SMS |

## Next steps

1. Replace the illustrative areas and groups with ZESCO's published lists for each town.
2. Get an Africa's Talking shortcode and sender ID, and set a budget with `SMS_DAILY_LIMIT`.
3. Host on HTTPS with `VAPID_SUBJECT` set, then test push on Android Chrome and an iPhone added to the home screen.
4. USSD menu (`*xxx#`) as a second channel for basic phones.
