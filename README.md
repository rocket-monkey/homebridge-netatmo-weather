# homebridge-netatmo-weather

A Homebridge plugin that exposes a virtual Light Sensor whose lux value encodes a blinds recommendation based on weather data from a Netatmo weather endpoint.

## How it works

The plugin polls a weather endpoint that returns a `blind_lux` value — a pre-computed blinds recommendation based on current and forecasted conditions. This value is exposed as a HomeKit Light Sensor, so you can build automations that trigger on lux thresholds.

## Lux values

| Lux | Condition | Blinds action | HomeKit trigger |
|-----|-----------|---------------|-----------------|
| **0** | No sun expected | Open blinds | — |
| **20** | Sunny + cool | Tilt to 60% | `> 10 lux` |
| **200** | Sunny + hot | Full sun protection | `> 100 lux` |

## Configuration

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `weatherEndpoint` | string | *required* | URL of the weather API endpoint |
| `pollInterval` | number | `60` | Polling interval in minutes |

### Example config

```json
{
  "platform": "NetatmoWeather",
  "name": "Netatmo Weather",
  "weatherEndpoint": "http://192.168.1.123:8087/weather",
  "pollInterval": 60
}
```

## HomeKit automation example

Create automations based on the light sensor value:

- **Lux ≥ 200** → Close blinds fully (sun protection)
- **Lux ≥ 20** → Tilt blinds to 60% (let warmth in)
- **Lux < 20** → Open blinds fully
