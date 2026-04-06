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
  LUX_NONE,
  LUX_WINTER_TILT,
  LUX_SUMMER_AUTO,
  DEFAULT_POLL_INTERVAL,
  DEFAULT_HOT_THRESHOLD,
  DEFAULT_LOOKAHEAD_HOURS,
} from "./settings.js";

import { WeatherService, BlindsRecommendation } from "./weatherService.js";

export class NetatmoWeatherPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  private readonly weatherService: WeatherService;
  private readonly pollInterval: number;
  private readonly hotThreshold: number;
  private readonly lookaheadHours: number;

  private accessory: PlatformAccessory | undefined;
  private lightSensorService: Service | undefined;
  private currentLux: number = LUX_NONE;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    public readonly log: Logging,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;

    const endpoint = config.weatherEndpoint as string;
    if (!endpoint) {
      this.log.error("No weatherEndpoint configured — plugin will not start.");
      this.weatherService = new WeatherService("");
      this.pollInterval = 0;
      this.hotThreshold = DEFAULT_HOT_THRESHOLD;
      this.lookaheadHours = DEFAULT_LOOKAHEAD_HOURS;
      return;
    }

    this.weatherService = new WeatherService(endpoint);
    this.pollInterval = ((config.pollInterval as number) || DEFAULT_POLL_INTERVAL) * 60 * 1000;
    this.hotThreshold = (config.hotThreshold as number) ?? DEFAULT_HOT_THRESHOLD;
    this.lookaheadHours = (config.lookaheadHours as number) ?? DEFAULT_LOOKAHEAD_HOURS;

    this.api.on("didFinishLaunching", () => {
      this.setupAccessory();
      this.poll();
      this.timer = setInterval(() => this.poll(), this.pollInterval);
    });
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.accessory = accessory;
  }

  private setupAccessory(): void {
    const uuid = this.api.hap.uuid.generate("netatmo-weather-sensor");
    const name = (this.config.name as string) || "Netatmo Weather";

    if (!this.accessory) {
      this.accessory = new this.api.platformAccessory(name, uuid);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [this.accessory]);
      this.log.info("Registered new accessory: %s", name);
    }

    // Accessory information
    this.accessory.getService(this.Service.AccessoryInformation)!
      .setCharacteristic(this.Characteristic.Manufacturer, "Netatmo Weather")
      .setCharacteristic(this.Characteristic.Model, "Light Sensor")
      .setCharacteristic(this.Characteristic.SerialNumber, "NW-001");

    // Light sensor service
    this.lightSensorService =
      this.accessory.getService(this.Service.LightSensor) ||
      this.accessory.addService(this.Service.LightSensor, name);

    this.lightSensorService
      .getCharacteristic(this.Characteristic.CurrentAmbientLightLevel)
      .onGet(() => this.currentLux);

    this.updateLux(LUX_NONE);
  }

  private async poll(): Promise<void> {
    try {
      const data = await this.weatherService.fetch();
      const evaluation = this.weatherService.evaluate(data, this.hotThreshold, this.lookaheadHours);

      this.log.info("[Weather] %s (outdoor: %.1f°C, sunny now: %s, sunny ahead: %s)",
        evaluation.reason,
        evaluation.temperature,
        evaluation.isSunnyNow,
        evaluation.isSunnyAhead,
      );

      const luxMap: Record<BlindsRecommendation, number> = {
        none: LUX_NONE,
        winter_tilt: LUX_WINTER_TILT,
        summer_auto: LUX_SUMMER_AUTO,
      };

      this.updateLux(luxMap[evaluation.recommendation]);
    } catch (err) {
      this.log.error("[Weather] Failed to fetch: %s", err);
    }
  }

  private updateLux(lux: number): void {
    this.currentLux = lux;
    this.lightSensorService
      ?.getCharacteristic(this.Characteristic.CurrentAmbientLightLevel)
      .updateValue(lux);
  }
}
