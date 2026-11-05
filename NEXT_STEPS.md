# Next steps

Status on 2026-11-05: Magetsi runs on my Windows PC and is online through ngrok at
https://yearling-amount-craving.ngrok-free.dev. Tested and working on a real Android phone:
the app, `/dashboard`, `/admin` (sign-in), SMS commands in log mode, and push alerts with the app closed.

## Starting it after a restart

Double-click `start-public.cmd` in the `magetsi` folder. It opens two windows, "Magetsi" and "ngrok".
To stop, press Ctrl+C in each window.

**Always-on demo for your CV:** https://john-chola.github.io/Magetsi/ (GitHub Pages, rebuilt automatically on every
push to `main`, works when the PC is off). It runs in the browser only: no push, SMS or admin.

**Live demo for interviews:** double-click `start-demo.cmd` instead. Same public link, but with a made-up schedule and
reports (kept in `magetsi-demo.db`) and a "Demo data" banner on every page. Only one of the two can run at a time:
close the Magetsi window (Ctrl+C) before switching. The demo has its own admin account; the setup token is printed
in its window the first time.

Settings that should stay off GitHub (for example `AT_USERNAME` and `AT_API_KEY`) go in a file named `.env`
in the same folder, one `KEY=VALUE` per line. The script reads it every time it starts.

Keep the PC awake (Settings → System → Power & sleep → Sleep: Never).

## Backups

Run `npm run backup` in the `magetsi` folder. It saves a copy to `backups\magetsi-<date>-<time>.db` and keeps the newest 30.
You don't need to stop Magetsi first. Copy the `backups` folder to a USB stick or Google Drive now and then:
the database holds all data, admin accounts and push keys.

To restore: stop Magetsi, delete `magetsi.db`, `magetsi.db-wal` and `magetsi.db-shm`, copy a backup in as `magetsi.db`, and start again.

## To do, in order

Magetsi is a portfolio project, so these are optional.

1. **Schedule.** Done on 2026-11-05: the 164 areas and per-town groups come from ZESCO's March 2024 list. No schedule
   is loaded, because ZESCO has none in force (June 2026: no nationwide load management expected). If one is published,
   write it as a pattern file and run `npm run schedule` (see README).
2. **Real SMS (free sandbox).** Make an Africa's Talking account and put `AT_USERNAME=sandbox` and `AT_API_KEY=...`
   in `.env`. Restart and test `JOIN` / `TIMES` / `STOP` with their phone simulator.
3. **iPhone push.** On an iPhone (iOS 16.4+): Share → Add to Home Screen, open Magetsi from the icon, allow notifications, and tap Test.
4. **Daily automatic backup (optional).** In Task Scheduler, create a daily task that runs `npm run backup` in the `magetsi` folder.
5. **Always-on hosting for the public launch.** The PC goes off during load-shedding, so move to a free
   Oracle Cloud "Always Free" server (controlled from Windows with `ssh`), with a free DuckDNS address and HTTPS.
6. **Later.** A USSD menu (`*xxx#`) for basic phones.
