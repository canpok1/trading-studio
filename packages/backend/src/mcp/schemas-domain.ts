// MCP の道具の入力の形のうち、取引の決まり（選べる値・既定値）から作るもの

import type { MarketRegime, Timeframe } from "@trading-studio/core";
import {
	DEFAULT_FEE_RATES,
	DURATIONS,
	MARKET_REGIMES,
	TIMEFRAMES,
} from "@trading-studio/core";
import * as z from "zod";

export const regimeSchema = z.enum(
	MARKET_REGIMES as [MarketRegime, ...MarketRegime[]],
);

export const timeframeSchema = z.enum(
	TIMEFRAMES as unknown as [Timeframe, ...Timeframe[]],
);

export const durationSchema = z.enum(DURATIONS);

/** 手数料率（ppm）。省けば既定の率 */
export const feeSchema = {
	limitFeePpm: z.number().int().default(DEFAULT_FEE_RATES.limitPpm),
	marketFeePpm: z.number().int().default(DEFAULT_FEE_RATES.marketPpm),
};
