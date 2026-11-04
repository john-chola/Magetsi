# Next steps

Status on 2026-11-04: Magetsi runs on my Windows PC and is online through ngrok at
https://yearling-amount-craving.ngrok-free.dev. Tested and working on a real Android phone:
the app, `/dashboard`, `/admin` (sign-in), SMS commands in log mode, and push alerts with the app closed.

## Starting it after a restart

Open two PowerShell windows in the `magetsi` folder.

```powershell
# Window 1: Magetsi
$env:TRUST_PROXY = "1"; $env:VAPID_SUBJECT = "mailto:john.chola.mulenga@cs.unza.zm"; npm start
```

```powershell
# Window 2: public link
ngrok http 3000 --url https://yearling-amount-craving.ngrok-free.dev
```

Keep the PC awake (Settings → System → Power & sleep → Sleep: Never).

## To do, in order

1. **Real schedule data.** The towns, areas and groups in `public/core.js` (`TOWN_AREAS`) are only examples.
   Get ZESCO's published area and group lists, put them in `TOWN_AREAS`, then import the real schedule CSV on `/admin`.
   Until then the alert times are not real.
2. **Real SMS (free sandbox).** Make an Africa's Talking account, set `AT_USERNAME=sandbox` and `AT_API_KEY`,
   and test `JOIN` / `TIMES` / `STOP` with their phone simulator.
3. **iPhone push.** On an iPhone (iOS 16.4+): Share → Add to Home Screen, open Magetsi from the icon, allow notifications, and tap Test.
4. **One-click start.** Make a `start-public.ps1` that opens both windows above.
5. **Always-on hosting for the public launch.** The PC goes off during load-shedding, so move to a free
   Oracle Cloud "Always Free" server (controlled from Windows with `ssh`), with a free DuckDNS address and HTTPS.
6. **Backups.** Copy `magetsi.db` regularly (stop Magetsi first). It holds all data, admin accounts and push keys.
7. **Later.** A USSD menu (`*xxx#`) for basic phones.
