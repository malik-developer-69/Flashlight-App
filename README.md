# Pulse Torch

A phone flashlight that drives the real LED, with Torch, Strobe, SOS and Beat sync
(the LED flashes to the beats of a song you pick from your phone).

## Run it

Beat sync decodes audio with `react-native-audio-api`, which is native code, so the app
needs a development build. Expo Go will not run it.

```bash
npm install
npx expo run:android      # phone plugged in with USB debugging on
# or
npx expo run:ios          # needs a Mac and a real iPhone; simulators have no flashlight
```

Cloud build without Android Studio or Xcode:

```bash
npm install -g eas-cli
eas build --profile development --platform android
```

The first launch asks for camera access. The flashlight is part of the camera system, so
this permission is required. The app never takes photos or video.

## How it works

| File | Job |
| --- | --- |
| `App.js` | Screen, mode tabs, and the 60 fps loop that decides whether the LED is on |
| `src/beat.js` | Beat detection: loudness curves for bass, everything and highs, then peak picking |
| `src/player.js` | Decodes and plays the song, and reports the playback position |
| `src/patterns.js` | SOS (Morse) and strobe timing |

The LED lights only while a camera view with `enableTorch` is mounted. `TorchDriver` keeps a
1 px hidden view mounted and the loop flips that prop.

Beat sync reads the song position from the audio clock on every frame, finds the latest
beat, and keeps the LED on for the "Flash length" after it. "Timing nudge" shifts that
timing to cover Bluetooth speaker delay.

## Notes

* The LED is on or off only, so there is no brightness control.
* Everything switches off when the app leaves the foreground.
* Beat detection is tested on a synthetic 124 bpm track: it found 48 of 49 kicks and
  estimated 123 bpm. Real songs vary, so use Sensitivity and Listen for to tune.

## Get an APK from GitHub (no Android Studio)

1. Create a GitHub repository and upload everything in this folder (keep `.github`).
2. Open the repository's **Actions** tab. The "Build Android APK" workflow runs on every push,
   or press **Run workflow**.
3. When it finishes (about 10 to 20 minutes), open the run and download **pulse-torch-apk**
   from Artifacts. Unzip it and install the `.apk` on your phone (allow "install unknown apps").

The APK is signed with a debug key, which is fine for your own phone but not for the Play Store.
