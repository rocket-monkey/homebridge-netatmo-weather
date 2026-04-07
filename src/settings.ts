export const PLATFORM_NAME = "NetatmoWeather";
export const PLUGIN_NAME = "homebridge-netatmo-weather";

// Lux values that encode the blinds recommendation.
// HomeKit automations trigger on these thresholds.
export const LUX_NONE = 0.0001;      // no action (HomeKit requires > 0)
export const LUX_WINTER_TILT = 20;   // sunny + cool → tilt 60%
export const LUX_SUMMER_AUTO = 200;  // sunny + hot  → auto sun position

// WMO weather codes considered "sunny"
export const SUNNY_CODES = new Set([0, 1, 2]); // clear, mainly clear, partly cloudy

// Default config values
export const DEFAULT_POLL_INTERVAL = 30;    // minutes
export const DEFAULT_HOT_THRESHOLD = 25;    // °C
export const DEFAULT_LOOKAHEAD_HOURS = 3;
