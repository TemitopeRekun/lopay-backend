# Push notifications (Firebase Cloud Messaging)

How a money event becomes a notification on a parent's phone, what has to be
configured for that to work, and how to tell which link in the chain is broken.

Covers both repos: `lopay-backend` sends, `Lopay` (web + Android shell) receives.

---

## 1. What was already here, and what was added

The backend has been able to send FCM pushes for a long time —
`FirebaseModule`, `NotificationsService.sendPushNotification`, the `DeviceToken`
table and `POST /device-tokens` all predate this work.

None of it did anything. **No client had ever registered a device token**, so
`getTokensForUser` always returned `[]` and every send returned early. The
Settings screen said as much: "Device push notifications aren't available yet."

What changed:

| Area | Change |
| --- | --- |
| Web client | Firebase JS SDK, a locally-bundled `firebase-messaging-sw.js`, token registration, foreground pop-up |
| Android shell | `@capacitor/push-notifications`, `POST_NOTIFICATIONS`, notification channel with sound, status-bar icon |
| Both | Soft-ask permission card, real Settings toggles, token lifecycle bound to sign-in/sign-out |
| Backend | Per-platform payload: web click-through URL, Android channel + sound, `data` block for routing |
| Assets | Locally rasterised icons (the PWA manifest previously loaded them from `ui-avatars.com`) and a synthesised chime |

---

## 2. Configuration checklist

Everything below lives in **one** Firebase project: `lopay-auth`. The backend's
service account already belongs to it. A web app registered in a *different*
project mints tokens this backend cannot send to — and the failure is silent,
because FCM accepts the send and simply never delivers.

### 2.1 Firebase console — status

Provisioned on 2026-08-08 against project `lopay-auth` via the Firebase
management API (`firebase-tools`, authenticated with the backend's existing
Admin SDK service account — interactive `firebase login` was not available):

| Item | Status |
| --- | --- |
| Web app `Lopay Web` (`1:891944287716:web:e79cf39ed1fcc6d60e1bf1`) | already existed; config read and committed to `netlify.toml` |
| Android app `Lopay Android` (`1:891944287716:android:51e874f5b6e1ff7c0e1bf1`, `com.lopay.app`) | **created**; `google-services.json` written to `Lopay/android/app/` |
| Web Push (VAPID) key pair | ⚠️ **outstanding — console only** |

**The one remaining manual step.** Firebase console → Project settings → Cloud
Messaging → Web configuration → Web Push certificates → **Generate key pair**,
then set it as `VITE_FIREBASE_VAPID_KEY` (Netlify UI for production,
`Lopay/.env.local` for local) and rebuild.

There is genuinely no automated path: `firebase-tools` has no command for it,
and both `fcm.googleapis.com/v1/projects/{p}/webPushKeyPairs` and
`firebase.googleapis.com/v1beta1/projects/{p}/webPushCertificates` return 404 —
Web Push certificates are not exposed by any public API.

Do **not** work around it by omitting the key and letting the SDK fall back to
its built-in default. That fallback is real, but the Firebase JS SDK docs state
that push services *including Chrome's* require a non-default key — so it would
fail on this app's primary browser while appearing configured.

Until it is set, `resolvePushConfig` returns `null`, the app never offers push,
and the build prints exactly which var is missing. The **service worker** is
configured regardless, since it only receives and never calls `getToken`.

The web config was verified live, not just transcribed: a real
`POST firebaseinstallations.googleapis.com/v1/projects/lopay-auth/installations`
(the first call the FCM SDK makes) returned 200 with an issued auth token.

### 2.2 Web client (`Lopay`)

Five of the six are now **committed to `netlify.toml`** under
`[build.environment]`, for the same reason `VITE_API_URL` is: `.env*` is
gitignored, so a value living only in the Netlify UI is one forgotten setting
away from a build that silently ships without push. They do not vary by deploy
context — there is one Firebase project — so every context inherits them, and a
Netlify UI variable of the same name still overrides.

```
VITE_FIREBASE_API_KEY              = AIzaSyAOBO038w5ORRnBBS-mDIfG35qVvyrJ1As
VITE_FIREBASE_AUTH_DOMAIN          = lopay-auth.firebaseapp.com
VITE_FIREBASE_PROJECT_ID           = lopay-auth
VITE_FIREBASE_MESSAGING_SENDER_ID  = 891944287716
VITE_FIREBASE_APP_ID               = 1:891944287716:web:e79cf39ed1fcc6d60e1bf1
VITE_FIREBASE_VAPID_KEY            = <SET THIS IN THE NETLIFY UI — see 2.1>
```

The same values are in `Lopay/.env.local` for local development.

None of these is a secret — the web config and the VAPID *public* key are
designed to ship to browsers. The credential that can **send** a push is the
backend's `FIREBASE_PRIVATE_KEY`, and it must never appear in a `VITE_*` var.

All five required vars must be present. A partial config is treated as no config
at all (`resolvePushConfig` returns `null`), because FCM's failure mode for a
half-configured project is an opaque `messaging/token-subscribe-failed` thrown
from deep inside `getToken` — long after the UI has told the user push is on.

**A build without them still succeeds** and ships an app that never offers push.
That is deliberate: push is an enhancement, and a missing env var must not white-
screen the payment flow.

### 2.3 Android shell (`Lopay/android`)

Already done — `Lopay/android/app/google-services.json` was downloaded from the
newly created `Lopay Android` app and verified to carry `project_id: lopay-auth`
and `package_name: com.lopay.app`.

That path is already load-bearing — `android/app/build.gradle` applies the
`com.google.gms.google-services` plugin only `if (file('google-services.json').exists())`.
Without the file the app builds and runs fine and receives nothing.

The file is **not** a secret in the credential sense — it holds the same public
project identifiers as the web config, and Google's own guidance is that it may
be committed. `Lopay/android/.gitignore` does **not** currently exclude it, so
committing it is the path of least surprise; if you would rather keep it out of
git, add the ignore rule *and* a CI step that materialises it, or Android builds
will silently ship without push.

The plugin is already wired into Gradle (`npx cap sync android` has been run —
`capacitor.build.gradle` lists `:capacitor-push-notifications`). Re-run
`npx cap sync android` after any dependency change.

### 2.4 Backend (`lopay-backend`)

Already set: `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`.

One optional addition:

```
WEB_APP_URL="https://lopay.netlify.app"
```

This is the origin a **web** push opens when tapped. It falls back to the first
entry in `CORS_ORIGINS`, which is the web client by definition — so it only
needs setting once `CORS_ORIGINS` lists more than one origin, otherwise a push
may open whichever happens to be first.

---

## 3. How it works

### 3.1 Send path

`NotificationsService.create()` writes the `Notification` row, emits it over the
realtime socket, then calls `sendPushNotification` → `buildPushMessage`.

Every send carries **both** blocks, and the reason matters:

- **`notification`** is what the OS displays while the app is closed, with none
  of our code running. A data-only message would need our service worker (web)
  or a background handler (Android) to survive and execute — and if either
  failed, Chrome posts its own generic *"This site has been updated in the
  background"* notice instead.
- **`data`** is what the app reads when it *is* running, to draw the in-app
  pop-up and route the tap. FCM requires every `data` value to be a string, so
  absent fields are omitted rather than stringified to `"undefined"`.

Per-platform:

| Block | Purpose |
| --- | --- |
| `android.notification.channelId` | `lopay-payments`. Android 8+ **silently drops** a notification naming a channel that does not exist, and FCM still reports success. |
| `android.notification.sound` | `lopay_alert` → `res/raw/lopay_alert.wav` |
| `android.priority: high` | Heads-up banner; `normal` lets Doze hold it until the next maintenance window |
| `webpush.fcmOptions.link` | `<WEB_APP_URL>/#<link>` — through the **hash**, because the app is on `HashRouter` |
| `webpush.notification.tag` | Collapses repeats about one notification instead of stacking |
| `apns` | Unused today; present so an iOS launch does not discover it missing |

### 3.2 Receive path

| App state | Web | Android |
| --- | --- | --- |
| Closed / backgrounded | Service worker; FCM SDK displays it. OS notification sound. | Android displays it from the payload. Channel sound (`lopay_alert.wav`). |
| Open and focused | `onMessage` → in-app pop-up + chime. FCM shows nothing. | `pushNotificationReceived` → in-app pop-up + chime. Android shows nothing. |
| Tapped | Service worker focuses/opens `fcmOptions.link` | `pushNotificationActionPerformed` → `navigate()` |

The socket (`useRealtime`) and FCM overlap in the foreground — a focused tab can
get the same event twice. That is deliberate, not a bug to design out: the
socket is the fast path, FCM is the one that survives a dropped connection. The
pop-up simply replaces whatever was showing.

### 3.3 Token lifecycle

```
sign-in  → syncToken()  → acquireToken() → POST   /device-tokens   (upsert, reassigns owner)
sign-out → clear()      → releaseToken() + DELETE /device-tokens
opt-in   → enable()     → prompt → token → POST   /device-tokens
opt-out  → disable()    → DELETE /device-tokens + releaseToken()
```

Both halves of sign-out matter. Leaving the backend row means the next account
on a shared device inherits the previous one's notifications; leaving the FCM
token means `getToken` hands back the *same* value on next sign-in.

`enable()` reports success **only** if all three steps land. Permission alone is
not the feature working — a granted browser with no registered token receives
nothing, and claiming otherwise is exactly what the old placeholder toggle did.

### 3.4 The service worker

`sw/firebase-messaging-sw.ts` is a real TypeScript module, bundled with the
Firebase SDK inlined by a second Vite pass (`vite.sw.config.ts`) into
`dist/firebase-messaging-sw.js`.

Firebase's own docs have you `importScripts` the SDK from `gstatic.com`. This
repo does not: `index.html` already refuses third-party CDN scripts, the CSP
ships `script-src 'self'`, and a worker fetching its runtime from another origin
is a supply-chain dependency on the notification path.

The bundle is **IIFE, not ESM** — module service workers are still not safe to
assume, and a worker that fails to install takes every background notification
with it.

`npm run build` runs both passes. `npm run typecheck` also runs twice, because
the worker needs `lib: WebWorker` and the app needs `lib: DOM`; loading both
produces hundreds of duplicate-identifier errors, and loading DOM alone silently
types `self` as `Window`.

---

## 4. Notification sound

| Context | What plays | Controllable? |
| --- | --- | --- |
| App open (web or Android) | `public/sounds/lopay-alert.wav` via `services/push/sound.ts` | Yes — Settings toggle |
| Android, app closed | The `lopay-payments` channel sound | At channel creation only |
| Web, app closed | The OS default notification sound | **No** |

The web limitation is not an oversight. The Notification API's `sound` property
was specified, never implemented by any shipping browser, and has since been
removed from the standard; a service worker has neither `Audio` nor
`AudioContext`. The Settings copy says so rather than implying control we do not
have.

Two Android facts worth knowing before anyone tries to change the sound:

- A channel's sound and importance are **immutable once created**. Android
  ignores changes on re-create by design, so a user's own tweaks are never
  overwritten. Changing either requires a **new channel id** — in all three
  places it appears (client config, backend send, manifest meta-data).
- For an existing channel the **channel's** sound wins over
  `android.notification.sound` in the payload. The payload field matters on the
  first delivery before the app has ever run, and on pre-Oreo devices.

The clip is synthesised (two struck bell tones, A5 → D6, ~0.95 s), so there is
no third-party audio licence in the app.

---

## 5. Verifying end to end

1. **Is the client registered?**
   ```sql
   SELECT "userId", platform, "createdAt" FROM "DeviceToken" ORDER BY "createdAt" DESC LIMIT 10;
   ```
   Empty after opting in ⇒ the failure is client-side (§6).

2. **Send a real one.** Sign in as a school owner and confirm a pending payment,
   or use the admin broadcast screen (`/admin/broadcast`) which fans out to every
   parent.

3. **Check all three states** for each platform: app closed, app open, and tap.
   Closed-app delivery is the one that exercises the channel, the icon and the
   click-through URL — the three things that fail silently.

---

## 6. Troubleshooting

Symptoms are grouped by where the chain actually breaks.

**Nothing arrives, and `DeviceToken` is empty**

- `VITE_FIREBASE_*` missing or partial → the app never offers push. Confirm with
  `getMissingPushKeys()` in the browser console, or look for the build-time
  warning `[lopay-sw] No VITE_FIREBASE_* config found`.
- Permission denied. A denial is **permanent per origin** and cannot be
  re-prompted from script — the user must clear it in browser/device settings.
  This is why the soft-ask card exists.
- Android: no `google-services.json` ⇒ `registrationError`, usually
  `MISSING_INSTANCEID_SERVICE`, or no event at all (the 15 s timeout in
  `acquireNativeToken` then resolves `null`).

**`getToken` rejects with `messaging/token-subscribe-failed`**

- VAPID key belongs to a different project, or is truncated.
- CSP is blocking `firebaseinstallations.googleapis.com` /
  `fcmregistrations.googleapis.com`. Both are in `build/csp.ts` and pinned by a
  test — note this class of bug **only reproduces in a built app**, because
  `vite dev` injects no CSP at all.

**`DeviceToken` has rows, FCM reports success, nothing shows**

- Android: channel id mismatch. `lopay-payments` must be identical in
  `services/push/config.ts`, `notifications.service.ts` and `AndroidManifest.xml`.
  A mismatch is dropped by the OS with no error anywhere.
- Web: check the registered worker in DevTools → Application → Service Workers.
  A stale worker from before the config was set will keep running; the
  `Cache-Control: max-age=0` header in `netlify.toml` prevents this going
  forward, but an already-registered one needs "Unregister" once.

**Tapping a notification lands on the wrong screen**

- `WEB_APP_URL` unset and `CORS_ORIGINS` starting with something other than the
  web client.
- A link missing the `/#` — the app is on `HashRouter`, so `/notifications`
  without the hash falls through the SPA rewrite to the default screen.

**Status-bar icon is a white square (Android)**

Expected if `default_notification_icon` is missing: from API 21 Android masks the
small icon to its alpha channel, so a full-colour launcher icon renders as a
solid block. `ic_stat_lopay` is the flat white silhouette that shape requires.

---

## 7. Files

**Backend**
- `src/notifications/notifications.service.ts` — `buildPushMessage`, send, token pruning
- `src/firebase/firebase.module.ts` — Admin SDK wiring
- `src/device-tokens/` — register / unregister

**Web + Android client**
- `services/push/` — `config` · `webPush` · `nativePush` · `sound` · `index` (facade)
- `sw/firebase-messaging-sw.ts` + `vite.sw.config.ts` — background worker
- `store/pushStore.ts` — opt-in lifecycle and soft-ask policy
- `hooks/usePushNotifications.ts` — session binding and tap routing
- `components/PushPermissionPrompt.tsx` · `PushNotificationPopup.tsx` · `PushSettingsSection.tsx`
- `build/csp.ts` — FCM origins and `worker-src`
- `android/app/src/main/{AndroidManifest.xml,res/drawable/ic_stat_lopay.xml,res/raw/lopay_alert.wav}`
