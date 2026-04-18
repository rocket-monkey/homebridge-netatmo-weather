# homebridge-netatmo-weather

A Homebridge plugin that brings your Netatmo Weather Station into HomeKit **via the Netatmo cloud**, so your accessories don't need to live on the same VLAN as your iPhone.

Exposes three accessories from a single local weather endpoint:

1. **Indoor module** — temperature, humidity, CO₂ (with a `CarbonDioxideDetected` flag at >1000 ppm).
2. **Outdoor module** — temperature, humidity.
3. **Blinds recommendation** (light sensor) — a synthetic lux value (`blind_lux`) pre-computed by the upstream weather endpoint, useful for automations like "close the blinds when the sun gets direct."

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

### Example config

```json
{
  "platform": "NetatmoWeather",
  "name": "Netatmo Weather",
  "indoorName": "Office",
  "outdoorName": "Loggia",
  "weatherEndpoint": "http://192.168.1.123:8087/weather",
  "pollInterval": 60
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
  }
}
```

Fields inside `current.*` and `indoor.*` are optional — a missing value for a given sensor just skips that HomeKit update on that poll.

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
- **CO₂ > 1000 ppm** → Notify to open a window
