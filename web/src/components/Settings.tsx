import { useEffect, useState } from 'react';
import { functionsUrl, isDemo, type AppSettings, type DataSource } from '../lib/data';
import { newToken, scriptableScript } from '../lib/widget';
import { Close } from './Icons';

const b64ToBytes = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=')), (c) => c.charCodeAt(0));
const deviceName = () => (/iPhone|iPad/.test(navigator.userAgent) ? 'iPhone' : /Mac/.test(navigator.userAgent) ? 'Mac' : /Windows/.test(navigator.userAgent) ? 'Windows' : /Android/.test(navigator.userAgent) ? 'Android' : 'Browser');
const standalone = () => matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;

export function SettingsPanel({ data, say, close }: { data: DataSource; say: (t: { text: string }) => void; close: () => void }) {
  const [st, setSt] = useState<AppSettings | null>(null);
  const [on, setOn] = useState(false); // is THIS device subscribed
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [script, setScript] = useState('');
  const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const needsInstall = /iPhone|iPad/.test(navigator.userAgent) && !standalone();

  useEffect(() => {
    data.settings().then(setSt, () => setNote('Settings could not be loaded. Has 0009_notifications_widget.sql been run?'));
    if (supported && !isDemo) void navigator.serviceWorker.getRegistration().then((r) => r?.pushManager.getSubscription()).then((s) => setOn(!!s)).catch(() => {}); // some contexts have no service worker
  }, [data, supported]);
  useEffect(() => { if (st?.widget_token) setScript(scriptableScript(`${functionsUrl}/widget`, st.widget_token, location.origin)); }, [st?.widget_token]);

  const save = (patch: Partial<AppSettings>) => { setSt((s) => (s ? { ...s, ...patch } : s)); void data.saveSettings(patch).catch(() => say({ text: 'That setting could not be saved.' })); };

  const enable = async () => {
    setBusy(true); setNote('');
    try {
      if (!st?.push_public_key) throw new Error('the server has not published its push key yet. Check the worker is running the latest version, wait a minute, and reopen this panel');
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') throw new Error(permission === 'denied' ? 'notifications are blocked for this app. Allow them in your device or browser settings, then try again' : 'permission was not given');
      const reg = await navigator.serviceWorker.ready;
      const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(st.push_public_key) }));
      const j = sub.toJSON();
      await data.pushSubscribe({ endpoint: sub.endpoint, p256dh: j.keys?.p256dh ?? '', auth: j.keys?.auth ?? '', device: deviceName() });
      setOn(true);
      await data.saveSettings({ push_test_at: new Date().toISOString() });
      setNote('On. A test notification should arrive within a minute.');
    } catch (e) { setNote(`Could not turn notifications on: ${(e as Error).message}.`); }
    setBusy(false);
  };
  const disable = async () => {
    setBusy(true);
    try {
      const sub = await (await navigator.serviceWorker.ready).pushManager.getSubscription();
      if (sub) { await data.pushUnsubscribe(sub.endpoint); await sub.unsubscribe(); }
      setOn(false); setNote('Off for this device.');
    } catch (e) { setNote(`Could not turn them off: ${(e as Error).message}.`); }
    setBusy(false);
  };
  const test = async () => { await data.saveSettings({ push_test_at: new Date().toISOString() }).then(() => setNote('Asked for a test. It should arrive within a minute.'), () => setNote('The test could not be requested.')); };
  const makeToken = () => save({ widget_token: newToken() });
  const copy = async () => { try { await navigator.clipboard.writeText(script); say({ text: 'Script copied' }); } catch { say({ text: 'Copy failed. Select the text and copy it by hand.' }); } };

  return (
    <div className="editor">
      <header className="sheet-bar"><b>Notifications and widget</b><button className="btn-round" onClick={close} aria-label="Close"><Close /></button></header>

      <section>
        <h2>Notifications on this device</h2>
        {isDemo ? <p className="hint">Not available with sample data.</p>
          : !supported || needsInstall ? <p className="hint">{needsInstall ? 'On an iPhone, notifications only work from the Home Screen app. In Safari choose Share, then Add to Home Screen, open Planner from there, and come back to this panel.' : 'This browser does not support notifications.'}</p>
          : (
            <div className="group">
              <div className="field-row"><span>{on ? 'On' : 'Off'}<small>{on ? 'Reminders and the morning summary come to this device.' : 'Turn on to get reminders here. Each device is switched on separately.'}</small></span>
                <button className="btn-text is-strong" disabled={busy} onClick={() => void (on ? disable() : enable())}>{busy ? 'Working' : on ? 'Turn off' : 'Turn on'}</button></div>
              {on && <div className="field-row"><span>Send a test</span><button className="btn-text" onClick={() => void test()}>Send</button></div>}
            </div>
          )}
        {note && <p className="hint">{note}</p>}
      </section>

      <section>
        <h2>What to send</h2>
        <div className="group">
          <label className="field-row"><span>Remind me before timed items</span>
            <select value={st?.remind_minutes ?? 30} onChange={(e) => save({ remind_minutes: Number(e.target.value) })}>{[0, 5, 10, 15, 30, 45, 60, 120].map((m) => <option key={m} value={m}>{m === 0 ? 'Never' : m < 60 ? `${m} minutes` : `${m / 60} hour${m === 60 ? '' : 's'}`}</option>)}</select></label>
          <label className="field-row"><span>Morning summary</span><input type="checkbox" className="switch" checked={!!st?.daily_summary_time} onChange={(e) => save({ daily_summary_time: e.target.checked ? '08:00' : null })} /></label>
          {st?.daily_summary_time && <label className="field-row"><span>Send it at</span><input type="time" value={st.daily_summary_time} onChange={(e) => e.target.value && save({ daily_summary_time: e.target.value })} /></label>}
        </div>
        <p className="hint">Possible events never send reminders. Problems, such as an inbox that needs signing in again, are also sent.</p>
      </section>

      <section>
        <h2>Home Screen widget</h2>
        <p className="hint">Shows today on your iPhone Home Screen, using the free Scriptable app.</p>
        {!st?.widget_token ? <button className="btn btn-wide is-fill" style={{ marginTop: '0.75rem' }} disabled={!st} onClick={makeToken}>Set up the widget</button> : (
          <>
            <ol className="steps">
              <li>Install <b>Scriptable</b> from the App Store.</li>
              <li>Tap <b>Copy script</b> below. In Scriptable tap +, paste, and name it Planner.</li>
              <li>On the Home Screen, press and hold, tap Edit then Add Widget, and choose Scriptable.</li>
              <li>Press and hold the new widget, tap Edit Widget, and pick Planner as the script.</li>
            </ol>
            <button className="btn btn-wide is-fill" onClick={() => void copy()}>Copy script</button>
            <textarea className="field script-box" readOnly rows={5} value={script} aria-label="Widget script" onFocus={(e) => e.currentTarget.select()} />
            <div className="group"><div className="field-row"><span>Replace the widget's key<small>Stops any widget using the old script. Copy the script again afterwards.</small></span><button className="btn-text" onClick={makeToken}>Replace</button></div></div>
          </>
        )}
      </section>
    </div>
  );
}
