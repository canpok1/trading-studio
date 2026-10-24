// MCP の道具の入力の形のうち、取引の決まり（選べる値・既定値）から作るもの

import type { MarketRegime, Timeframe } from "@trading-studio/core";
import {
	brokerOf,
	DURATIONS,
	LIMITS,
	MARKET_REGIMES,
	marketOf,
	TIMEFRAMES,
} from "@trading-studio/core";
import * as z from "zod";
import {
	COLLECTED_IDS,
	DEFAULT_INSTRUMENT,
} from "../market-data/instrument-domain";

export const regimeSchema = z.enum(
	MARKET_REGIMES as [MarketRegime, ...MarketRegime[]],
);

export const timeframeSchema = z.enum(
	TIMEFRAMES as unknown as [Timeframe, ...Timeframe[]],
);

export const durationSchema = z.enum(DURATIONS);

/** 銘柄の id。価格を集めている銘柄だけ */
export const instrumentIdSchema = z.enum(COLLECTED_IDS);

/** 候補の銘柄の id の並び */
export const instrumentIdsSchema = z.array(instrumentIdSchema);

/** DVOL の平均の日数。戦略の条件 DVOL（平均との比）と同じ範囲 */
export const dvolAverageDaysSchema = z
	.number()
	.int()
	.min(LIMITS.dvolDays.min)
	.max(LIMITS.dvolDays.max);

const DEFAULT_FEES = brokerOf(marketOf(DEFAULT_INSTRUMENT)).fees;

/** 手数料率（ppm）。省けばバックテストの銘柄の口座の先の既定の率 */
export const feeSchema = {
	limitFeePpm: z.number().int().default(DEFAULT_FEES.limitPpm),
	marketFeePpm: z.number().int().default(DEFAULT_FEES.marketPpm),
};
