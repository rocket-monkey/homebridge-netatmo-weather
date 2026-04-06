import { SUNNY_CODES } from "./settings.js";

export interface WeatherResponse {
  date: string;
  weather_today: string;
  current: {
    temperature: number;
    humidity: number;
    min_temp: number;
    max_temp: number;
    temp_trend: string;
    battery_percent: number | null;
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
    daily: DailyForecast[];
    hourly: HourlyForecast[];
  };
}

export interface DailyForecast {
  date: string;
  condition: string;
  weather_code: number;
  temp_min: number;
  temp_max: number;
  precipitation_mm: number;
  precipitation_probability: number;
  sunrise: string;
  sunset: string;
  wind_speed_max: number;
  wind_dir: string;
  uv_index_max: number;
  sunshine_hours: number;
}

export interface HourlyForecast {
  time: string;
  condition: string;
  weather_code: number;
  temperature: number;
  precipitation_probability: number;
  wind_speed: number;
  wind_dir: string;
  uv_index: number;
}

export type BlindsRecommendation = "none" | "winter_tilt" | "summer_auto";

export interface WeatherEvaluation {
  recommendation: BlindsRecommendation;
  temperature: number;
  isSunnyNow: boolean;
  isSunnyAhead: boolean;
  reason: string;
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

  evaluate(data: WeatherResponse, hotThreshold: number, lookaheadHours: number): WeatherEvaluation {
    const now = new Date();
    const temperature = data.current.temperature;

    // Find hourly entries from now through the lookahead window
    const upcoming = data.forecast.hourly.filter((h) => {
      const hourTime = new Date(h.time);
      return hourTime >= now && hourTime <= new Date(now.getTime() + lookaheadHours * 60 * 60 * 1000);
    });

    // Current hour: the most recent entry before or at now
    const currentHour = data.forecast.hourly
      .filter((h) => new Date(h.time) <= now)
      .pop();

    const isSunnyNow = currentHour ? SUNNY_CODES.has(currentHour.weather_code) : false;
    const isSunnyAhead = upcoming.some((h) => SUNNY_CODES.has(h.weather_code));
    const isSunny = isSunnyNow || isSunnyAhead;

    if (!isSunny) {
      return {
        recommendation: "none",
        temperature,
        isSunnyNow,
        isSunnyAhead,
        reason: "No sun expected",
      };
    }

    if (temperature > hotThreshold) {
      return {
        recommendation: "summer_auto",
        temperature,
        isSunnyNow,
        isSunnyAhead,
        reason: `Sunny and hot (${temperature}°C > ${hotThreshold}°C)`,
      };
    }

    return {
      recommendation: "winter_tilt",
      temperature,
      isSunnyNow,
      isSunnyAhead,
      reason: `Sunny and cool (${temperature}°C ≤ ${hotThreshold}°C)`,
    };
  }
}
