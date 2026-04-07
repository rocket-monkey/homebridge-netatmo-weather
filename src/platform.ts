import {
  API,
  DynamicPlatformPlugin,
  Logging,
  PlatformAccessory,
  PlatformConfig,
  Service,
  Characteristic,
} from "homebridge";

import { PLATFORM_NAME, PLUGIN_NAME, DEFAULT_POLL_INTERVAL } from "./settings.js";
import { WeatherService } from "./weatherService.js";

export class NetatmoWeatherPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  private readonly weatherService: WeatherService;
  private readonly pollInterval: number;

  private accessory: PlatformAccessory | undefined;
  private lightSensorService: Service | undefined;
  private currentLux = 0;
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
      return;
    }

    this.weatherService = new WeatherService(endpoint);
    this.pollInterval = ((config.pollInterval as number) || DEFAULT_POLL_INTERVAL) * 60 * 1000;

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

    this.updateLux(0);
  }

  private async poll(): Promise<void> {
    try {
      const data = await this.weatherService.fetch();
      const blindLux = data.blind_lux ?? 0;

      this.log.info("[Weather] %s, %s°C, blind_lux: %s, lux: %s",
        data.weather_today,
        data.current.temperature.toFixed(1),
        blindLux,
        data.lux,
      );

      this.updateLux(blindLux);
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
