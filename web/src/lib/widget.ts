/** The script to paste into the Scriptable app. It draws today's items as a home-screen widget. */
export function scriptableScript(feedUrl: string, token: string, appUrl: string): string {
  return `// Planner widget for Scriptable. Paste this whole file into a new script in the Scriptable app.
const FEED = ${JSON.stringify(feedUrl)};
const TOKEN = ${JSON.stringify(token)};
const APP = ${JSON.stringify(appUrl)};

const COLORS = { study: "#007aff", work: "#af52de", personal: "#34c759", finance: "#ff9500", health: "#ff2d55", admin: "#30b0c7", other: "#8e8e93", session: "#5856d6" };
const label = Color.dynamic(new Color("#000000"), new Color("#ffffff"));
const dim = Color.dynamic(new Color("#3c3c43", 0.6), new Color("#ebebf5", 0.6));
const red = Color.dynamic(new Color("#ff3b30"), new Color("#ff453a"));

async function load() {
  const fm = FileManager.local();
  const path = fm.joinPath(fm.cacheDirectory(), "planner-widget.json");
  try {
    const req = new Request(FEED);
    req.headers = { "x-widget-token": TOKEN };
    req.timeoutInterval = 12;
    const data = await req.loadJSON();
    if (!data || !data.today) throw new Error(data && data.error ? data.error : "bad reply");
    fm.writeString(path, JSON.stringify(data));
    return data;
  } catch (e) {
    // No connection: show the last copy rather than an empty widget.
    if (fm.fileExists(path)) { const old = JSON.parse(fm.readString(path)); old.stale = true; return old; }
    return { error: String(e.message || e) };
  }
}

function row(w, item, small) {
  const s = w.addStack();
  s.centerAlignContent();
  const bar = s.addStack();
  bar.size = new Size(3, small ? 13 : 15);
  bar.cornerRadius = 1.5;
  bar.backgroundColor = new Color(COLORS[item.kind === "session" ? "session" : item.category] || COLORS.other, item.possible ? 0.4 : 1);
  s.addSpacer(6);
  const t = s.addText(item.title);
  t.font = Font.systemFont(small ? 12 : 13);
  t.textColor = item.done || item.possible ? dim : label;
  t.lineLimit = 1;
  if (!small) {
    s.addSpacer();
    const time = s.addText(item.time);
    time.font = Font.systemFont(11);
    time.textColor = dim;
    time.lineLimit = 1;
  }
  w.addSpacer(small ? 3 : 4);
}

const data = await load();
const family = config.widgetFamily || "medium";
const small = family === "small";
const room = small ? 4 : family === "large" ? 11 : 4;

const w = new ListWidget();
w.url = APP;
w.setPadding(14, 14, 12, 14);
w.backgroundColor = Color.dynamic(new Color("#ffffff"), new Color("#1c1c1e"));
w.refreshAfterDate = new Date(Date.now() + 15 * 60 * 1000);

if (data.error) {
  const t = w.addText("Planner could not load");
  t.font = Font.semiboldSystemFont(13);
  t.textColor = label;
  const e = w.addText(data.error);
  e.font = Font.systemFont(11);
  e.textColor = dim;
} else {
  const parts = data.today.label.split(" ");
  const head = w.addStack();
  const day = head.addText(parts[0].replace(",", ""));
  day.font = Font.boldSystemFont(small ? 13 : 15);
  day.textColor = red;
  head.addSpacer(5);
  const rest = head.addText(parts.slice(1).join(" "));
  rest.font = Font.systemFont(small ? 13 : 15);
  rest.textColor = dim;
  rest.lineLimit = 1;
  w.addSpacer(8);

  const open = data.today.items.filter((i) => !i.done);
  let used = 0;
  for (const item of open.slice(0, room)) { row(w, item, small); used++; }
  if (open.length > used) {
    const more = w.addText("and " + (open.length - used) + " more");
    more.font = Font.systemFont(11);
    more.textColor = dim;
    used++;
  }
  if (!open.length) {
    const none = w.addText(data.today.items.length ? "All done for today" : "Nothing today");
    none.font = Font.systemFont(13);
    none.textColor = dim;
    w.addSpacer(4);
    used++;
  }
  // With space left over, show what is coming tomorrow.
  const spare = room - used - 1;
  if (spare > 0 && data.tomorrow.items.length) {
    w.addSpacer(2);
    const th = w.addText("Tomorrow");
    th.font = Font.semiboldSystemFont(11);
    th.textColor = dim;
    w.addSpacer(3);
    for (const item of data.tomorrow.items.slice(0, spare)) row(w, item, small);
  }
  w.addSpacer();
  const notes = [];
  if (data.overdue) notes.push(data.overdue + " overdue");
  if (data.stale) notes.push("offline copy");
  if (notes.length) {
    const f = w.addText(notes.join(", "));
    f.font = Font.systemFont(10);
    f.textColor = data.overdue ? red : dim;
  }
}

if (config.runsInWidget) Script.setWidget(w);
else await w.presentMedium();
Script.complete();
`;
}

export function newToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}
