# Spin DJ 🎛️

Put a phone flat on a table and physically rotate it. The gyroscope turns it
into a record platter:

- **Spin clockwise** (viewed from above) → the song plays forward.
- **Spin counter-clockwise** → it scrubs in reverse.
- **Spin faster** → the pitch climbs. Whip it and you get the ridiculous
  chipmunk remix. Spin slow and everything drags like molasses.
- **Stop spinning** → the record stops (silence, like a real needle parked in
  the groove).
- **One revolution every 1.8 s** (33⅓ RPM, like a real single) = normal speed
  and pitch.

You can also **drag the record** with a finger/mouse, **scroll** on desktop, or
let the **33⅓** button cruise for you at listening speed (it's on by default —
tap it to turn cruising off and rely on spinning alone).

## Run it

```sh
python3 server.py
```

Then open the printed URL. Defaults to HTTPS on port 8443 with a self-signed
certificate (created for you on first run — browsers only expose gyro data on
secure origins, so HTTPS is required for the phone to spin).

- **On this computer:** `https://localhost:8443` — accept the cert warning once.
  Spin by dragging the record in circles or using the scroll wheel.
- **On your phone:** open `https://<your-mac-ip>:8443` (same Wi-Fi), accept the
  certificate warning (iOS: **Show Details → visit this website**), then tap
  **🌀 Enable motion sensors** and allow the permission.

Options: `--port 9000` for a different port, `--http` for plain HTTP (desktop
testing only — phone gyro will not work over plain HTTP).

## Loading your MP3s

On the library screen:

- **Desktop / Android Chrome:** tap **📁 Choose folder** and pick the folder.
- **iPhone (Safari):** tap **🎵 Choose songs**, then in the Files picker use
  **⋯ → Select** to tick every MP3 in your folder at once, and tap Open.
  (Safari can't open folders directly, but multi-select works.)

Supported: `.mp3 .m4a .aac .wav .ogg .flac .webm`. Songs are decoded on the
phone, nothing is uploaded anywhere.

## Recording your own

Tap **🎙️ Record**, make some noise (up to 30 seconds), then **Stop & spin**.
The take is added to the library as "Recording 1, 2, …" and drops straight
onto the platter — where you can scrub it back and forth like any other song.
The mic is only used while the red dot is pulsing; recordings live in memory
for the session and are never uploaded.

## How it works

- `deviceorientation` events give the phone's orientation; the app projects the
  device's right-edge axis into the world horizontal plane and tracks that
  azimuth (unwrapped) as the platter angle. Scaling by the phone's flatness²
  means standing the phone up doesn't spin the record.
- Angular velocity → playback rate (signed). Reverse playback uses a reversed
  copy of the decoded audio buffer; crossing zero speed swaps buffers at the
  mirrored needle position, which gives you real vinyl-style scratch.
- Speed also drives a low-pass filter (slow = dark) and the RPM/pitch badges.

Tunables live at the top of `app.js` (`CONFIG`): `REV_SEC` (spin sensitivity),
`MAX_RATE` (chipmunk ceiling), inertia decay, etc.

## Notes

- Songs loop forever at the edges — the platter never runs out of groove.
- Keep the screen awake is requested automatically while a song is loaded.
- Works best in landscape-free, flat-on-a-table mode. A phone case thicker than
  the table adds wobble — that's physics, not a bug.
