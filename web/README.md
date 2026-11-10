# Planner web app (Phase 2, slice a)

The calendar: Day, Week, Month and Agenda views, item details with history, add, edit, complete and
delete, the Needs review queue, and filters. React with Vite, hosted on Vercel, installable as an app.

## Before deploying

In the Supabase SQL editor, paste and run the contents of `supabase/migrations/0004_realtime_and_trash.sql`
(and `0003_item_timezone.sql` and `0005_possible_items.sql` if you have not already).

## Deploy (about 15 minutes, once)

1. **Put the project on GitHub.** Create a new *private* repository called `planner`, then on your Mac,
   inside the unzipped `planner` folder:
   ```
   git init && git add . && git commit -m "Planner"
   git branch -M main
   git remote add origin https://github.com/YOUR-USERNAME/planner.git
   git push -u origin main
   ```
   `.env` files are ignored by git, so no keys are uploaded. Check with `git status` before pushing.
2. **Import it in Vercel.** New Project, pick the `planner` repository, and set **Root Directory** to `web`.
3. **Add two environment variables** in Vercel (Settings > Environment Variables):
   - `VITE_SUPABASE_URL`: your project URL, e.g. `https://abcd.supabase.co`
   - `VITE_SUPABASE_PUBLISHABLE_KEY`: the publishable key (or legacy `anon` `public` key).
     Never the secret key. Anything in a `VITE_` variable is visible to every visitor.
4. **Deploy**, and copy the address Vercel gives you (like `https://planner-xyz.vercel.app`).
5. **Tell Supabase about that address.** Authentication > URL Configuration: set **Site URL** to it and
   add it under **Redirect URLs**. Without this the sign-in link opens the wrong place.
6. Open the address, enter your email, and use the link that arrives. Only the account you created in
   Supabase can sign in; other addresses are refused.

Every later `git push` redeploys, and pull requests get their own preview address.

## Install as an app

- **iPhone:** open the address in Safari, Share, Add to Home Screen.
- **Mac:** Safari, File, Add to Dock. Or Chrome, the install icon in the address bar.
- **Windows:** Edge or Chrome, the install icon in the address bar.

## Using it

- **Add:** the + button, or `N`. On Day and Week you can also double-click an empty time.
- **Move around:** arrows or the left and right keys; `T` jumps to today; `1` to `4` switch views.
- **Complete:** tick the circle on a task, or open anything and choose Mark as done.
- **Edit:** open an item, Edit. Fields you change are kept even if a later email says otherwise;
  the item shows them under "Edited by you" with a Revert button.
- **Delete:** moves it to Trash for 30 days. The message that appears has an Undo.
- **Needs review:** uncertain items wait there, off the calendar, until you Accept or Dismiss.
- **Possible events:** dashed items are things you could go to, not plans. Open one and choose I'm going
  or Not interested. Untick "Possible events" in the sidebar to hide them all.
- **Filters:** untick a category, course, source or priority to hide it. On a phone, the sliders button.

## Try it without an account

`npm install && npm run dev`, then open the printed address with `?demo` on the end. With no
environment variables set, the app always runs on sample data and saves nothing.

## Tests

`npm test` runs the calendar logic tests. `npm run build` type-checks and builds.

## Not in this slice

Quick add, search, drag to reschedule, a Trash screen, full offline editing, recurring events,
reminders, and the operations dashboard. The app does open with no connection and shows the last
items it loaded, but changes need a connection for now.
