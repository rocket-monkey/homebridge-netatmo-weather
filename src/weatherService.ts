export interface WeatherResponse {
  date: string;
  weather_today: string;
  lux: number;
  blind_lux: number;
  current: {
    temperature: number;
    humidity: number;
    min_temp: number;
    max_temp: number;
    temp_trend: string;
    pressure: number;
    pressure_trend: string;
  };
  indoor: {
    temperature: number;
    co2: number;
    humidity: number;
    noise: number;
  };
  forecast: {
    daily: unknown[];
    hourly: unknown[];
  };
}

export class WeatherService {
  constructor(private readonly endpoint: string) {}

  async fetch(): Promise<WeatherResponse> {
    const response = await globalThis.fetch(this.endpoint);
    if (!response.ok) {
      throw new Error(`Weather endpoint returned ${response.status}`);
    }
    return await response.json() as WeatherResponse;
  }
}
