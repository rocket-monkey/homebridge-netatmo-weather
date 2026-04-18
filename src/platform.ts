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

  // Running-latest values, updated by poll(), read by onGet handlers.
  private currentLux = MIN_LUX;
  private indoorTemp = 0;
  private indoorHumidity = 0;
  private indoorCO2 = 0;
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
      this.poll();
      this.timer = setInterval(() => this.poll(), this.pollIntervalMs);
    });
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

    if (accessory.UUID === lightUuid) {
      this.lightAccessory = accessory;
    } else if (accessory.UUID === indoorUuid) {
      this.indoorAccessory = accessory;
    } else if (accessory.UUID === outdoorUuid) {
      this.outdoorAccessory = accessory;
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
    // Detected characteristic.
    co2.getCharacteristic(this.Characteristic.CarbonDioxideDetected)
      .onGet(() =>
        this.indoorCO2 > 1000
          ? this.Characteristic.CarbonDioxideDetected.CO2_LEVELS_ABNORMAL
          : this.Characteristic.CarbonDioxideDetected.CO2_LEVELS_NORMAL,
      );
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

    // Light sensor — blind_lux recommendation. Null-guard because older
    // scanner versions may still return without this field.
    if (data.blind_lux != null) {
      this.updateLux(data.blind_lux);
    } else {
      this.log.warn("[Weather] blind_lux missing in response — skipping lux update");
    }

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
        co2Service?.updateCharacteristic(
          this.Characteristic.CarbonDioxideDetected,
          this.indoorCO2 > 1000
            ? this.Characteristic.CarbonDioxideDetected.CO2_LEVELS_ABNORMAL
            : this.Characteristic.CarbonDioxideDetected.CO2_LEVELS_NORMAL,
        );
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
