# Planner web app

The calendar and project planner: Day, Week, Month and Agenda views, a Projects tab, item details with history, add, edit, complete and
delete, the Needs review queue, and filters. React with Vite, hosted on Vercel, installable as an app.

## Before deploying

In the Supabase SQL editor, paste and run the contents of `supabase/migrations/0004_realtime_and_trash.sql`
(and `0003_item_timezone.sql`, `0005_possible_items.sql` and `0006_projects.sql` if you have not already).

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

## Signing in on a Home Screen app

An app added to the iPhone Home Screen keeps its own sign-in, separate from Safari. A link in an email
opens Safari, so it can never sign in the Home Screen app. The app therefore asks for a **code**.
For the email to contain one, edit the template once in Supabase:

**Authentication > Emails > Templates > Magic Link**, replace the body with:

```html
<h2>Your Planner sign-in code</h2>
<p style="font-size: 26px; letter-spacing: 4px;"><b>{{ .Token }}</b></p>
<p>Type this code into the app. In a browser you can instead <a href="{{ .ConfirmationURL }}">sign in with this link</a>.</p>
```

## Notifications

Reminders before timed items (30 minutes by default), a morning summary, and warnings such as an inbox that
needs signing in again. They are sent by the worker on the server, so they arrive with every device closed.

1. Run `supabase/migrations/0009_notifications_widget.sql` and redeploy the worker (`make deploy`).
2. On each device, open **Notifications and widget** (bottom of the sidebar, or the filters sheet on a
   phone) and choose **Turn on**. A test notification arrives within a minute.
3. On an iPhone this only works from the Home Screen app, not from a Safari tab.

Possible events never send reminders. Change the lead time or the summary time in the same panel.

## Home Screen widget

iOS only lets native apps provide widgets, so this uses the free **Scriptable** app to draw one.

1. Deploy `supabase/functions/widget/index.ts` as an Edge Function named exactly `widget`, and turn **off**
   "Verify JWT" for it in the function's settings (the widget has no sign-in; it uses its own key instead).
2. In the app, open **Notifications and widget**, choose **Set up the widget**, and follow the four steps.

The widget shows today, then tomorrow if there is room, and refreshes roughly every 15 minutes when iOS
allows. Tapping it opens the app. With no connection it shows its last copy. If the key ever leaks, choose
**Replace** and copy the script again; the old one stops working.

## Assistant

The sparkle button opens a chat that stays the same across your devices. Describe something
("dentist Thursday 3pm", "move my registration meeting to Friday"), ask about your calendar, or attach a
timetable, syllabus or exam schedule as a PDF or photo.

- **You approve everything:** each suggestion is a card with a tick per item. Nothing changes until you
  choose Apply, and **Undo additions** moves everything that card added to Trash.
- **Weekly classes:** a class with a last date becomes one event per week. Each is a separate event, so
  editing one does not change the rest. The card also offers to save class times to Planning settings.
- **Files are not kept:** an attachment is sent to the AI for that one message and discarded. Limit: three
  files, about 4.5 MB in total.
- **Cost:** each message is an AI call (a few cents; more for long PDFs) and counts toward the monthly cap.

Setup, once: run `supabase/migrations/0008_assistant.sql`, then deploy
`supabase/functions/assistant/index.ts` as an Edge Function named exactly `assistant`, the same way as
`plan-project`. It uses the `ANTHROPIC_API_KEY` secret you already saved.

## Projects

The Projects tab turns a piece of work into a timeline. Describe it, give a deadline or ask for one to be
suggested, and choose daily sessions or weekly targets. The app proposes milestones and work sessions;
nothing goes on the calendar until you choose **Add to calendar**.

- **Background:** paste an earlier chat about the project, the brief or your notes into the Background box.
  The estimate reads it.
- **Related items:** attach the deadline, exam or emails a project is about, either while creating it or
  from any item's page with **Plan this as a project**. The estimate reads those items and the emails they
  came from, and a deadline you attach fills in the project's due date. Deleting a project keeps them.
- **Where sessions go:** only inside the hours in **Planning settings**, never on top of a calendar event,
  a class you listed, or another project's session, and never more than your daily limit.
- **Buffer:** the last part of the time before a deadline is left empty (20% by default).
- **When things change:** if the deadline moves, a session is missed, or something new clashes, the project
  shows "Needs a look" and offers **Replan what is left**. Nothing is replanned on its own.
- **Versions:** every plan is kept. Older ones can be restored from the project's page.
- **Time tracking:** when you finish a session, enter the minutes it really took. After three sessions, new
  estimates are adjusted to your pace.

### Setting up the AI estimate (once)

The schedule is computed in the app. Only the "how many hours is this?" estimate uses AI, through a small
Supabase Edge Function, so the API key never reaches the browser.

1. Run `supabase/migrations/0006_projects.sql` and then `0007_project_links.sql` in the SQL editor.
2. In Supabase, open **Edge Functions**, choose **Deploy a new function > Via Editor**, name it exactly
   `plan-project`, replace the sample code with the contents of `supabase/functions/plan-project/index.ts`,
   and deploy.
3. Open **Edge Functions > Secrets** and add `ANTHROPIC_API_KEY` with your key.

Each estimate costs about a cent and counts toward the same monthly cap as email. Without the function,
projects still work: enter the hours yourself and choose **Plan with my hours**.

## Try it without an account

`npm install && npm run dev`, then open the printed address with `?demo` on the end. With no
environment variables set, the app always runs on sample data and saves nothing.

## Tests

`npm test` runs the calendar logic tests. `npm run build` type-checks and builds.

## Not in this slice

Quick add, search, drag to reschedule, a Trash screen, full offline editing, recurring events,
reminders, and the operations dashboard. The app does open with no connection and shows the last
items it loaded, but changes need a connection for now.
