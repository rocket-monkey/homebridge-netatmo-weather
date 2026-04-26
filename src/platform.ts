import * as http from "node:http";

import {
  API,
  DynamicPlatformPlugin,
  Logging,
  PlatformAccessory,
  PlatformConfig,
  Service,
  Characteristic,
} from "homebridge";

import {
  PLATFORM_NAME,
  PLUGIN_NAME,
  DEFAULT_POLL_INTERVAL_SECONDS,
  MIN_POLL_INTERVAL_SECONDS,
  MIN_LUX,
  DEFAULT_INDOOR_NAME,
  DEFAULT_OUTDOOR_NAME,
} from "./settings.js";
import { WeatherService, WeatherResponse } from "./weatherService.js";

/**
 * The plugin exposes three accessories driven by a single weather endpoint:
 *
 *   1. Light sensor ("Netatmo Weather") — lux value encodes a blinds
 *      recommendation (blind_lux). Used for HomeKit automations.
 *   2. Indoor module (configurable name) — Temp + Humidity + CO₂ services,
 *      sourced from response.indoor.*.
 *   3. Outdoor module (configurable name) — Temp + Humidity services,
 *      sourced from response.current.*.
 *
 * The indoor + outdoor accessories are a cloud-fed replacement for the
 * native Netatmo HomeKit pairings — needed because those pair directly
 * device-to-iPhone over IP and break when the devices move to an isolated
 * IoT VLAN. Here, the data comes from the Netatmo cloud via the scanner
 * container, and Homebridge sits on the iPhone's VLAN, so no cross-VLAN
 * reachability is required.
 */
export class NetatmoWeatherPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  private readonly weatherService: WeatherService;
  private readonly pollIntervalMs: number;

  private readonly lightName: string;
  private readonly indoorName: string;
  private readonly outdoorName: string;

  // Cached accessories (Homebridge restores these across restarts).
  private lightAccessory: PlatformAccessory | undefined;
  private indoorAccessory: PlatformAccessory | undefined;
  private outdoorAccessory: PlatformAccessory | undefined;
  private co2AlertAccessory: PlatformAccessory | undefined;

  // Running-latest values, updated by poll(), read by onGet handlers.
  private currentLux = MIN_LUX;
  private indoorTemp = 0;
  private indoorHumidity = 0;
  private indoorCO2 = 0;
  // Tracks the last "alert" state so we only fire StatelessProgrammableSwitch
  // events on the transitions, not on every poll. null until the first poll
  // gives us a baseline (avoids firing a spurious "back to normal" on startup).
  private prevCO2Abnormal: boolean | null = null;
  private outdoorTemp = 0;
  private outdoorHumidity = 0;

  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    public readonly log: Logging,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;

    this.lightName = (config.name as string) || "Netatmo Weather";
    this.indoorName = (config.indoorName as string) || DEFAULT_INDOOR_NAME;
    this.outdoorName = (config.outdoorName as string) || DEFAULT_OUTDOOR_NAME;

    const endpoint = config.weatherEndpoint as string;
    if (!endpoint) {
      this.log.error("No weatherEndpoint configured — plugin will not start.");
      this.weatherService = new WeatherService("");
      this.pollIntervalMs = 0;
      return;
    }

    this.weatherService = new WeatherService(endpoint);
    const seconds = Math.max(
      (config.pollInterval as number) || DEFAULT_POLL_INTERVAL_SECONDS,
      MIN_POLL_INTERVAL_SECONDS,
    );
    this.pollIntervalMs = seconds * 1000;

    this.api.on("didFinishLaunching", () => {
      this.setupLightAccessory();
      this.setupIndoorAccessory();
      this.setupOutdoorAccessory();
      this.setupCO2AlertAccessory();
      this.poll();
      this.timer = setInterval(() => this.poll(), this.pollIntervalMs);

      const debugPort = Number(config.debugPort) || 0;
      if (debugPort > 0) {
        this.startDebugServer(debugPort);
      }
    });
  }

  // Local-only HTTP endpoint for forcing characteristic values during
  // HomeKit-automation debugging. Bound to 127.0.0.1 so it's only reachable
  // from the same host running Homebridge.
  //   curl -X POST 'http://127.0.0.1:<port>/lux?value=0'
  private startDebugServer(port: number): void {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
      if (req.method === "POST" && url.pathname === "/lux") {
        const value = Number(url.searchParams.get("value"));
        if (!Number.isFinite(value)) {
          res.writeHead(400, { "Content-Type": "text/plain" });
          res.end("bad or missing ?value=\n");
          return;
        }
        this.updateLux(value);
        this.log.warn("[Debug] Lux forced to %s via HTTP", value);
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end(`lux=${value}\n`);
        return;
      }
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found\n");
    });
    server.on("error", (err) => this.log.error("[Debug] HTTP server error: %s", err));
    server.listen(port, "127.0.0.1", () =>
      this.log.warn("[Debug] HTTP server listening on 127.0.0.1:%d", port),
    );
  }

  /**
   * Called by Homebridge for each cached accessory on restart. Match by UUID
   * so we bind the right handler back to each restored accessory instead of
   * letting Homebridge create duplicates.
   */
  configureAccessory(accessory: PlatformAccessory): void {
    const lightUuid = this.api.hap.uuid.generate("netatmo-weather-sensor");
    const indoorUuid = this.api.hap.uuid.generate("netatmo-weather-indoor");
    const outdoorUuid = this.api.hap.uuid.generate("netatmo-weather-outdoor");
    const co2AlertUuid = this.api.hap.uuid.generate("netatmo-weather-co2-alert");

    if (accessory.UUID === lightUuid) {
      this.lightAccessory = accessory;
    } else if (accessory.UUID === indoorUuid) {
      this.indoorAccessory = accessory;
    } else if (accessory.UUID === outdoorUuid) {
      this.outdoorAccessory = accessory;
    } else if (accessory.UUID === co2AlertUuid) {
      this.co2AlertAccessory = accessory;
    } else {
      // Stale accessory from a prior version (e.g. renamed). Drop it so
      // HomeKit can garbage-collect the tombstone instead of showing it
      // as "No Response" forever.
      this.log.info("Removing stale cached accessory: %s", accessory.displayName);
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    }
  }

  // ── Accessory setup ────────────────────────────────────────────────

  private setupLightAccessory(): void {
    const uuid = this.api.hap.uuid.generate("netatmo-weather-sensor");

    if (!this.lightAccessory) {
      this.lightAccessory = new this.api.platformAccessory(this.lightName, uuid);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [this.lightAccessory]);
      this.log.info("Registered new accessory: %s", this.lightName);
    }

    this.lightAccessory.getService(this.Service.AccessoryInformation)!
      .setCharacteristic(this.Characteristic.Manufacturer, "Netatmo Weather")
      .setCharacteristic(this.Characteristic.Model, "Light Sensor (blind_lux)")
      .setCharacteristic(this.Characteristic.SerialNumber, "NW-001");

    const service =
      this.lightAccessory.getService(this.Service.LightSensor) ||
      this.lightAccessory.addService(this.Service.LightSensor, this.lightName);

    service
      .getCharacteristic(this.Characteristic.CurrentAmbientLightLevel)
      .onGet(() => this.currentLux);
  }

  private setupIndoorAccessory(): void {
    const uuid = this.api.hap.uuid.generate("netatmo-weather-indoor");

    if (!this.indoorAccessory) {
      this.indoorAccessory = new this.api.platformAccessory(this.indoorName, uuid);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [this.indoorAccessory]);
      this.log.info("Registered new accessory: %s", this.indoorName);
    }

    this.indoorAccessory.getService(this.Service.AccessoryInformation)!
      .setCharacteristic(this.Characteristic.Manufacturer, "Netatmo")
      .setCharacteristic(this.Characteristic.Model, "Indoor Module (via cloud)")
      .setCharacteristic(this.Characteristic.SerialNumber, "NW-IN-001");

    const temp =
      this.indoorAccessory.getService(this.Service.TemperatureSensor) ||
      this.indoorAccessory.addService(this.Service.TemperatureSensor, `${this.indoorName} Temp`);
    temp
      .getCharacteristic(this.Characteristic.CurrentTemperature)
      .onGet(() => this.indoorTemp);

    const humidity =
      this.indoorAccessory.getService(this.Service.HumiditySensor) ||
      this.indoorAccessory.addService(this.Service.HumiditySensor, `${this.indoorName} Humidity`);
    humidity
      .getCharacteristic(this.Characteristic.CurrentRelativeHumidity)
      .onGet(() => this.indoorHumidity);

    const co2 =
      this.indoorAccessory.getService(this.Service.CarbonDioxideSensor) ||
      this.indoorAccessory.addService(this.Service.CarbonDioxideSensor, `${this.indoorName} CO₂`);
    co2.getCharacteristic(this.Characteristic.CarbonDioxideLevel).onGet(() => this.indoorCO2);
    // HomeKit wants a binary "detected" signal too. 1000 ppm is ASHRAE's
    // upper bound for "well-ventilated" — a reasonable threshold for the
    // Detected characteristic. Hysteresis is applied in poll() (1000 ↑ /
    // 800 ↓) so the value doesn't flap when CO₂ hovers at the threshold.
    co2.getCharacteristic(this.Characteristic.CarbonDioxideDetected)
      .onGet(() =>
        this.prevCO2Abnormal
          ? this.Characteristic.CarbonDioxideDetected.CO2_LEVELS_ABNORMAL
          : this.Characteristic.CarbonDioxideDetected.CO2_LEVELS_NORMAL,
      );

    // ── Migrate away from prior 1.3.x / 1.4.0 experiments ─────────────
    // 1.3.x added two StatelessProgrammableSwitch services + ServiceLabel.
    // 1.4.0 added a MotionSensor as a secondary service on the indoor
    // accessory — but iOS Home's automation picker hides secondary services
    // when the accessory's primary type (CO₂ sensor) doesn't match. Those
    // stale services are stripped here; the dual-direction trigger now lives
    // on its own accessory in setupCO2AlertAccessory().
    let dirty = false;
    for (const subtype of ["co2-high", "co2-normal"] as const) {
      const stale = this.indoorAccessory.getServiceById(
        this.Service.StatelessProgrammableSwitch, subtype,
      );
      if (stale) {
        this.indoorAccessory.removeService(stale);
        dirty = true;
      }
    }
    const staleLabel = this.indoorAccessory.getService(this.Service.ServiceLabel);
    if (staleLabel) {
      this.indoorAccessory.removeService(staleLabel);
      dirty = true;
    }
    const staleMotion = this.indoorAccessory.getServiceById(
      this.Service.MotionSensor, "co2-alert",
    );
    if (staleMotion) {
      this.indoorAccessory.removeService(staleMotion);
      dirty = true;
    }
    if (dirty) {
      this.log.info("[CO₂] Stripped legacy services from indoor accessory; persisting.");
      this.api.updatePlatformAccessories([this.indoorAccessory]);
    }
  }

  // Dedicated CO₂ alert accessory — a standalone MotionSensor whose
  // MotionDetected mirrors the hysteresis-driven CO₂ alert state. iOS
  // Home renders this as a separate sensor in the automation picker and
  // offers BOTH "Erkennt Bewegung" and "Erkennt keine Bewegung mehr" as
  // dual-direction triggers — the same UX as a real motion sensor.
  private setupCO2AlertAccessory(): void {
    const uuid = this.api.hap.uuid.generate("netatmo-weather-co2-alert");
    const name = `${this.indoorName} CO₂ Alert`;

    if (!this.co2AlertAccessory) {
      this.co2AlertAccessory = new this.api.platformAccessory(name, uuid);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [this.co2AlertAccessory]);
      this.log.info("Registered new accessory: %s", name);
    }

    this.co2AlertAccessory.getService(this.Service.AccessoryInformation)!
      .setCharacteristic(this.Characteristic.Manufacturer, "Netatmo")
      .setCharacteristic(this.Characteristic.Model, "CO₂ Alert (derived)")
      .setCharacteristic(this.Characteristic.SerialNumber, "NW-CO2-001");

    const hadMotion = !!this.co2AlertAccessory.getService(this.Service.MotionSensor);
    const motion =
      this.co2AlertAccessory.getService(this.Service.MotionSensor) ||
      this.co2AlertAccessory.addService(this.Service.MotionSensor, name);
    motion.getCharacteristic(this.Characteristic.MotionDetected)
      .onGet(() => this.prevCO2Abnormal ?? false);
    if (!hadMotion) {
      // addService on a newly-registered accessory races the initial cache
      // write; force a republish so HAP exposes MotionSensor to controllers.
      this.api.updatePlatformAccessories([this.co2AlertAccessory]);
    }
  }

  private setupOutdoorAccessory(): void {
    const uuid = this.api.hap.uuid.generate("netatmo-weather-outdoor");

    if (!this.outdoorAccessory) {
      this.outdoorAccessory = new this.api.platformAccessory(this.outdoorName, uuid);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [this.outdoorAccessory]);
      this.log.info("Registered new accessory: %s", this.outdoorName);
    }

    this.outdoorAccessory.getService(this.Service.AccessoryInformation)!
      .setCharacteristic(this.Characteristic.Manufacturer, "Netatmo")
      .setCharacteristic(this.Characteristic.Model, "Outdoor Module (via cloud)")
      .setCharacteristic(this.Characteristic.SerialNumber, "NW-OUT-001");

    const temp =
      this.outdoorAccessory.getService(this.Service.TemperatureSensor) ||
      this.outdoorAccessory.addService(this.Service.TemperatureSensor, `${this.outdoorName} Temp`);
    temp
      .getCharacteristic(this.Characteristic.CurrentTemperature)
      .onGet(() => this.outdoorTemp);

    const humidity =
      this.outdoorAccessory.getService(this.Service.HumiditySensor) ||
      this.outdoorAccessory.addService(this.Service.HumiditySensor, `${this.outdoorName} Humidity`);
    humidity
      .getCharacteristic(this.Characteristic.CurrentRelativeHumidity)
      .onGet(() => this.outdoorHumidity);
  }

  // ── Poll + update ──────────────────────────────────────────────────

  private async poll(): Promise<void> {
    let data: WeatherResponse;
    try {
      data = await this.weatherService.fetch();
    } catch (err) {
      this.log.error("[Weather] Failed to fetch: %s", err);
      return;
    }

    this.log.info(
      "[Weather] %s, outdoor %s°C / %s%% RH, indoor %s°C / %s%% RH / %s ppm CO₂, blind_lux %s, lux %s",
      data.weather_today,
      data.current?.temperature?.toFixed(1) ?? "?",
      data.current?.humidity?.toFixed(0) ?? "?",
      data.indoor?.temperature?.toFixed(1) ?? "?",
      data.indoor?.humidity?.toFixed(0) ?? "?",
      data.indoor?.co2?.toFixed(0) ?? "?",
      data.blind_lux,
      data.lux,
    );

    // Light sensor — blind_lux recommendation from the scanner. Values are
    // pre-scaled at the source (0 / 1000 / 40000) to be well-separated,
    // since HomeKit's threshold-automation engine was empirically unreliable
    // at small magnitudes.
    this.updateLux(data.blind_lux);

    // Indoor module — guard each field so a partial response doesn't crash
    // the poll with a NaN write to HomeKit (which the HAP layer rejects).
    if (data.indoor) {
      if (isFiniteNumber(data.indoor.temperature)) {
        this.indoorTemp = data.indoor.temperature;
        this.indoorAccessory
          ?.getService(this.Service.TemperatureSensor)
          ?.updateCharacteristic(this.Characteristic.CurrentTemperature, this.indoorTemp);
      }
      if (isFiniteNumber(data.indoor.humidity)) {
        this.indoorHumidity = clampPercent(data.indoor.humidity);
        this.indoorAccessory
          ?.getService(this.Service.HumiditySensor)
          ?.updateCharacteristic(
            this.Characteristic.CurrentRelativeHumidity,
            this.indoorHumidity,
          );
      }
      if (isFiniteNumber(data.indoor.co2)) {
        this.indoorCO2 = data.indoor.co2;
        const co2Service = this.indoorAccessory?.getService(this.Service.CarbonDioxideSensor);
        co2Service?.updateCharacteristic(this.Characteristic.CarbonDioxideLevel, this.indoorCO2);

        // Hysteresis: cross 1000 upward to enter ABNORMAL, fall below 800
        // to return to NORMAL. Between 800 and 1000 we hold the previous
        // state. Avoids flapping notifications when CO₂ sits near the
        // threshold.
        let nextAbnormal: boolean;
        if (this.indoorCO2 > 1000) {
          nextAbnormal = true;
        } else if (this.indoorCO2 < 800) {
          nextAbnormal = false;
        } else {
          nextAbnormal = this.prevCO2Abnormal ?? false;
        }

        co2Service?.updateCharacteristic(
          this.Characteristic.CarbonDioxideDetected,
          nextAbnormal
            ? this.Characteristic.CarbonDioxideDetected.CO2_LEVELS_ABNORMAL
            : this.Characteristic.CarbonDioxideDetected.CO2_LEVELS_NORMAL,
        );

        // Mirror the alert state onto the dedicated CO₂ Alert accessory's
        // MotionSensor — iOS Home renders that accessory as a standalone
        // motion sensor with both "detected" and "no longer detected"
        // automation triggers.
        this.co2AlertAccessory
          ?.getService(this.Service.MotionSensor)
          ?.updateCharacteristic(this.Characteristic.MotionDetected, nextAbnormal);

        // First poll establishes the baseline silently.
        if (this.prevCO2Abnormal !== null && this.prevCO2Abnormal !== nextAbnormal) {
          this.log.info(
            "[CO₂] Transition %s → %s at %s ppm",
            this.prevCO2Abnormal ? "ABNORMAL" : "NORMAL",
            nextAbnormal ? "ABNORMAL" : "NORMAL",
            this.indoorCO2.toFixed(0),
          );
        }
        this.prevCO2Abnormal = nextAbnormal;
      }
    }

    // Outdoor module.
    if (data.current) {
      if (isFiniteNumber(data.current.temperature)) {
        this.outdoorTemp = data.current.temperature;
        this.outdoorAccessory
          ?.getService(this.Service.TemperatureSensor)
          ?.updateCharacteristic(this.Characteristic.CurrentTemperature, this.outdoorTemp);
      }
      if (isFiniteNumber(data.current.humidity)) {
        this.outdoorHumidity = clampPercent(data.current.humidity);
        this.outdoorAccessory
          ?.getService(this.Service.HumiditySensor)
          ?.updateCharacteristic(
            this.Characteristic.CurrentRelativeHumidity,
            this.outdoorHumidity,
          );
      }
    }
  }

  private updateLux(lux: number): void {
    const clamped = Math.max(lux, MIN_LUX);
    this.currentLux = clamped;
    this.lightAccessory
      ?.getService(this.Service.LightSensor)
      ?.updateCharacteristic(this.Characteristic.CurrentAmbientLightLevel, clamped);
  }
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function clampPercent(v: number): number {
  if (v < 0) return 0;
  if (v > 100) return 100;
  return v;
}
