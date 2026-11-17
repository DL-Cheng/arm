# RoboHand Control

Mobile-first PWA for controlling the ESP32 robotic hand over MQTT. The web app is aligned with the firmware currently in this project: **continuous-rotation actuator jog commands**, not absolute servo-angle commands.

## What is implemented

- Balanced white, red, and black responsive dashboard with MQTT broker and ESP32 connection indicators.
- Per-motor hold-to-jog controls for five fingers and the wrist, adjustable jog speed, and the firmware stop-all command.
- Live display of motor direction and firmware-reported travel estimates.
- Optional phone camera hand tracking with MediaPipe Hand Landmarker; finger state, common gesture label, and confidence are shown in the browser.
- Phone-side Rock-Paper-Scissors with a countdown, random robotic move, camera gesture input, and scoreboard.
- PWA install support and mobile camera permission handling.
- UI clearly marks position-dependent presets, high-five, grip/release, and touch/force sensing as unavailable until hardware is verified.

## Hardware and control limitations

The sketch documents ESP32 Dev Module Wi-Fi/MQTT and six **continuous-rotation** MG996R actuators on these pins:

| Motor | ESP32 GPIO |
|---|---:|
| Thumb | 25 |
| Index | 26 |
| Middle | 27 |
| Ring | 32 |
| Pinky | 33 |
| Wrist | 13 |

These are not absolute-position commands. The firmware sends a pulse width for direction/speed and estimates travel from elapsed time. The dashboard therefore reports estimated travel, not measured finger position.

The sketch does not document finger-position sensors, a physical emergency disconnect, touch sensor, or grip-force sensor. Camera tracking currently **does not move the hand**; automatic imitation remains disabled to avoid sending uncalibrated position targets to actuators that do not report position. RPS runs in the phone UI and does not actuate the robotic move. High-five, calibrated pose, and object-grip buttons are intentionally disabled.

If the physical servos are standard positional servos (not converted for continuous rotation), confirm that before implementing pose control: the control model, safe angle limits, calibration, and firmware must then be changed and validated on the actual mechanism.

## Power and safety

- Power the servos from an appropriate external supply, not the ESP32 board. The prior wiring notes recommend 5–6 V and at least 5 A; confirm the actual servo stall-current requirements and supply capacity for your build.
- Connect external servo-supply ground to ESP32 ground.
- Test with mechanical linkages unloaded and at reduced speed first. Keep hands clear of pinch points.
- `STOP ALL` publishes the firmware `S` command. It is not latched and is not a physical emergency stop. Install a suitably rated hardware power disconnect for emergency shutdown.
- The firmware's travel limits are configured broadly by default, so its travel estimate does not guarantee protection from mechanical overtravel.
- The example broker is public and the current sketch uses unencrypted MQTT. Do not rely on a device ID as authentication; use an authenticated TLS-capable broker before operating outside a controlled demonstration.

## Firmware setup

1. Install Arduino IDE and ESP32 board support; select **ESP32 Dev Module**.
2. Install **ESP32Servo** and **PubSubClient** from the Arduino Library Manager.
3. Open [`robotarm_esp32/robotarm_jog.ino`](./robotarm_esp32/robotarm_jog.ino).
4. Set `WIFI_SSID`, `WIFI_PASS`, and a unique `DEVICE_ID`.
5. Upload and check the serial monitor at 115200 baud for Wi-Fi/MQTT connection status.
6. Confirm the configured stop pulses, direction signs, actuator wiring, and travel limits with the mechanical linkage unloaded.

## Web app setup

The app is static and can be deployed to GitHub Pages:

1. Publish `index.html`, `style.css`, `app.js`, `gesture-tracker.js`, `mqtt.min.js`, `manifest.json`, `sw.js`, and `icons/`.
2. Open the published HTTPS URL on the phone.
3. Under **Connection settings**, use the same device ID as the firmware and the broker's MQTT WebSocket URL.
4. Wait for both Broker and Hand indicators to show online.
5. Press and hold a direction control to jog a motor. Releasing sends a stop for that motor. `STOP ALL` sends the firmware stop command.

The app's motor order is Thumb, Index, Middle, Ring, Pinky, Wrist (firmware indices 0–5). The app and ESP32 must use the exact same `DEVICE_ID`; set Wi-Fi credentials and a unique device ID in the sketch, upload it, then use that ID in the phone's connection settings. The default public MQTT broker is shared and unauthenticated, so do not use a predictable/shared device ID for a powered hand.

Only the per-motor **Reverse/Forward** hold buttons jog the physical actuators. Rock-Paper-Scissors is phone-only, while pose and gesture actuation buttons remain disabled until position-controlled hardware is verified and calibrated. Because the current actuators are continuous-rotation servos, jog buttons run only while held; they do not command a finger to a target position.

Camera access requires HTTPS (or localhost) and user permission. The MediaPipe JavaScript bundle, WASM runtime, and hand-landmarker model are loaded from their configured public CDN/model URLs at runtime; initial camera startup therefore requires internet access. On first use, allow the model to finish loading before expecting recognition.

## MQTT contract implemented by this app and sketch

Topic base: `shutech/robotarm-jog/<DEVICE_ID>`

| Topic | Direction | Payload |
|---|---|---|
| `/cmd` | App → ESP32 | Text commands: `M,<motor 0–5>,<direction -1/0/1>`, `V,<pulse offset>`, `S` |
| `/status` | ESP32 → App | JSON fields `t` (estimated travel ×10), `m` (direction), `v` (pulse offset) |
| `/online` | ESP32 → App | Retained `1`/`0` availability |

While a jog button is held, the page repeats its command every 100 ms. Firmware also has its own command timeout and stops on MQTT disconnect. Movement depends on network delivery and the firmware's stop behavior; do not treat this as a safety-rated control system.

## Future hardware-dependent work

Before enabling calibrated presets, independent finger positioning, camera imitation, high-five, or robot-actuated RPS:

1. Confirm the installed servo type and whether it can hold a target position.
2. Confirm per-finger mechanical limits and calibrate unloaded, low-speed movement.
3. Add a firmware position-command protocol with limits, bounded speed, mode arbitration, timeout, and safe startup behavior.
4. Consider position feedback and an independent physical stop.
5. Add force/pressure sensing before reporting whether an object is securely held; add a touch sensor only with a reviewed safe trigger action.
