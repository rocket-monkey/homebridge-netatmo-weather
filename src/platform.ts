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
} from "./settings.js";
import { WeatherService } from "./weatherService.js";

export class NetatmoWeatherPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  private readonly weatherService: WeatherService;
  private readonly pollIntervalMs: number;

  private accessory: PlatformAccessory | undefined;
  private lightSensorService: Service | undefined;
  private currentLux = MIN_LUX;
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
      this.setupAccessory();
      this.poll();
      this.timer = setInterval(() => this.poll(), this.pollIntervalMs);
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

    this.accessory.getService(this.Service.AccessoryInformation)!
      .setCharacteristic(this.Characteristic.Manufacturer, "Netatmo Weather")
      .setCharacteristic(this.Characteristic.Model, "Light Sensor")
      .setCharacteristic(this.Characteristic.SerialNumber, "NW-001");

    this.lightSensorService =
      this.accessory.getService(this.Service.LightSensor) ||
      this.accessory.addService(this.Service.LightSensor, name);

    this.lightSensorService
      .getCharacteristic(this.Characteristic.CurrentAmbientLightLevel)
      .onGet(() => this.currentLux);
  }

  private async poll(): Promise<void> {
    try {
      const data = await this.weatherService.fetch();

      this.log.info("[Weather] %s, %s°C, blind_lux: %s, lux: %s",
        data.weather_today,
        data.current.temperature.toFixed(1),
        data.blind_lux,
        data.lux,
      );

      if (data.blind_lux == null) {
        this.log.warn("[Weather] blind_lux missing in response — skipping lux update");
        return;
      }

      this.updateLux(data.blind_lux);
    } catch (err) {
      this.log.error("[Weather] Failed to fetch: %s", err);
    }
  }

  private updateLux(lux: number): void {
    const clamped = Math.max(lux, MIN_LUX);
    this.currentLux = clamped;
    this.lightSensorService
      ?.getCharacteristic(this.Characteristic.CurrentAmbientLightLevel)
      .updateValue(clamped);
  }
}
