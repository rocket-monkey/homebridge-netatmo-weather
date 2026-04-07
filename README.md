# homebridge-netatmo-weather

A Homebridge plugin that exposes a virtual Light Sensor whose lux value encodes a blinds recommendation based on Netatmo weather data.

## How it works

The plugin polls a weather endpoint and evaluates current and upcoming conditions. Based on temperature and sun forecast, it sets a lux value on a virtual HomeKit Light Sensor. You can then create HomeKit automations that trigger on these lux thresholds.

## Lux values

| Lux | Condition | Blinds action | HomeKit trigger |
|-----|-----------|---------------|-----------------|
| **0** | No sun expected | Open blinds | — |
| **20** | Sunny + cool (≤ 25°C) | Tilt to 60% | `> 10 lux` |
| **200** | Sunny + hot (> 25°C) | Full sun protection | `> 100 lux` |

## Configuration

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `weatherEndpoint` | string | *required* | URL of the weather API endpoint |
| `pollInterval` | number | `30` | Polling interval in minutes |
| `hotThreshold` | number | `25` | Temperature (°C) above which "sunny" triggers summer mode (lux 200) instead of winter tilt (lux 20) |
| `lookaheadHours` | number | `3` | How many hours ahead to check for sun in the hourly forecast |

### Example config

```json
{
  "platform": "NetatmoWeather",
  "name": "Netatmo Weather",
  "weatherEndpoint": "http://192.168.1.123:8087/weather",
  "pollInterval": 30,
  "hotThreshold": 25,
  "lookaheadHours": 3
}
```

## Weather evaluation logic

1. The plugin fetches weather data from the configured endpoint.
2. It checks the current and upcoming hourly forecasts for sunny WMO weather codes (`0` = Clear, `1` = Mainly clear, `2` = Partly cloudy).
3. If sun is expected:
   - **Temperature > hot threshold** → lux `100` (summer auto)
   - **Temperature ≤ hot threshold** → lux `50` (winter tilt)
4. If no sun is expected → lux `0` (no action)

## HomeKit automation example

Create automations based on the light sensor value:

- **Lux ≥ 200** → Close blinds fully (sun protection)
- **Lux ≥ 20** → Tilt blinds to 60% (let warmth in)
- **Lux < 20** → Open blinds fully
