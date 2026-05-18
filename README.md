# homebridge-netatmo-weather

A Homebridge plugin that brings your Netatmo Weather Station into HomeKit **via the Netatmo cloud**, so your accessories don't need to live on the same VLAN as your iPhone.

Exposes four accessories from a single local weather endpoint (five if you configure a second indoor module):

1. **Indoor module** — temperature, humidity, CO₂ (with a `CarbonDioxideDetected` flag that trips above a configurable threshold, default 1500 ppm).
2. **Outdoor module** — temperature, humidity.
3. **CO₂ Alert** — standalone MotionSensor accessory whose `motion` flips on/off in lockstep with the indoor CO₂ ABNORMAL state. Enables iOS Home automations in **both** directions ("CO₂ went high → notify, open window" AND "CO₂ went back down → all clear"), which a single `CarbonDioxideDetected` characteristic can't trigger on its own.
4. **Blinds recommendation** (light sensor) — a synthetic lux value (`blind_lux`) pre-computed by the upstream weather endpoint, useful for automations like "close the blinds when the sun gets direct."
5. **Bedroom module** *(optional, 1.8.0+)* — second indoor module accessory (temp + humidity + CO₂), registered only when the upstream weather endpoint emits a `bedroom` block. Intended for an NIM01-WW Smart Indoor Air Quality Monitor placed elsewhere.

The data path is:

```
Netatmo cloud  →  your weather endpoint (eg. netatmo-scanner)  →  this plugin  →  HomeKit
```

No device-to-iPhone LAN reachability is required — which matters if you've isolated Netatmo devices on their own IoT VLAN.

## Why cloud-fed instead of the native HomeKit pairing

Netatmo Weather Stations ship with a native HomeKit pairing that talks IP-direct between the device and your iPhone. If you put the device on an isolated IoT VLAN, that direct path breaks (`Keine Antwort` / *No Response*) unless you add an mDNS reflector and cross-VLAN firewall holes. This plugin avoids that entirely — all communication flows through Homebridge, which you can host on the same VLAN as your iPhone.

## Configuration

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `weatherEndpoint` | string | *required* | URL of the weather API endpoint |
| `pollInterval` | number | `60` | Polling interval in seconds |
| `name` | string | `"Netatmo Weather"` | Display name of the light-sensor accessory |
| `indoorName` | string | `"Netatmo Indoor"` | Display name of the indoor module accessory |
| `outdoorName` | string | `"Netatmo Outdoor"` | Display name of the outdoor module accessory |
| `bedroomName` | string | `"Netatmo Bedroom"` | Display name of the optional bedroom indoor module accessory. Only registered when the upstream emits a `bedroom` block. |
| `co2AbnormalAt` | number | `1500` | ppm threshold above which CO₂ accumulates toward ABNORMAL. Raised from the ASHRAE 1000 ppm guideline because Netatmo's raw `/getmeasure` CO₂ values run ~4× higher than what the Netatmo iOS app displays. Tune lower if your sensor is well-calibrated. |
| `co2NormalAt` | number | `1200` | ppm threshold below which CO₂ accumulates toward NORMAL. The gap between `co2NormalAt` and `co2AbnormalAt` forms a hysteresis band where the prior state is held. |
| `co2AbnormalSamples` | number | `3` | Consecutive polls past the threshold required before flipping `CarbonDioxideDetected`. Suppresses single-poll spikes. |
| `debugPort` | number | *unset* | If set, exposes a `127.0.0.1`-only HTTP endpoint for forcing lux values (`POST /lux?value=N`). Leave empty to disable. |

### Example config

```json
{
  "platform": "NetatmoWeather",
  "name": "Netatmo Weather",
  "indoorName": "Office",
  "outdoorName": "Loggia",
  "bedroomName": "Bedroom",
  "weatherEndpoint": "http://192.168.1.123:8087/weather",
  "pollInterval": 60,
  "co2AbnormalAt": 1500,
  "co2NormalAt": 1200,
  "co2AbnormalSamples": 3
}
```

### Expected weather-endpoint response shape

```json
{
  "weather_today": "Sunny",
  "blind_lux": 20,
  "lux": 1,
  "current": {
    "temperature": 19.1,
    "humidity": 45,
    "pressure": 1014
  },
  "indoor": {
    "temperature": 25.5,
    "humidity": 41,
    "co2": 551,
    "noise": 38
  },
  "bedroom": {
    "temperature": 21.8,
    "humidity": 52,
    "co2": 720
  }
}
```

Fields inside `current.*`, `indoor.*`, and `bedroom.*` are optional — a missing value for a given sensor just skips that HomeKit update on that poll. Omit the `bedroom` block entirely if you don't have a second indoor module; the bedroom accessory simply won't register.

## Blinds-recommendation lux values

The `blind_lux` field encodes a pre-computed blinds strategy rather than actual ambient light:

| Lux | Condition | Blinds action | HomeKit trigger |
|-----|-----------|---------------|-----------------|
| **0** | No sun expected | Open blinds | — |
| **20** | Sunny + cool | Tilt to 60% | `> 10 lux` |
| **200** | Sunny + hot | Full sun protection | `> 100 lux` |

## HomeKit automation example

- **Lux ≥ 200** → Close blinds fully (sun protection)
- **Lux ≥ 20** → Tilt blinds to 60% (let warmth in)
- **Lux < 20** → Open blinds fully
- **CO₂ > `co2AbnormalAt`** → Notify to open a window (use the CO₂ Alert MotionSensor to also trigger an "all clear" automation when CO₂ drops back below `co2NormalAt`).
