// アドバイスと一緒に AI が出す「改善案を反映した戦略設定」。結果画面から改善版でバックテストするのに使う

import type { ConditionSet } from "@trading-studio/core";
import {
	CONDITION_GROUP_LABELS,
	CONDITION_GROUPS,
	conditionSetChanges,
	JUDGES,
	JUDGMENT_CONDITION_VALUES,
	parseConditionSet,
	SATOSHI_PER_BTC,
	TIMEFRAME_LABELS,
	TIMEFRAMES,
	validateConditionSet,
} from "@trading-studio/core";
import type { ResponseSchema } from "../news/gemini";
import type { ImprovedStrategy } from "./types";

const str = (description: string, values?: readonly string[]) => ({
	type: "STRING",
	description,
	...(values ? { enum: [...values] } : {}),
});
const int = (description: string) => ({ type: "INTEGER", description });
const num = (description: string) => ({ type: "NUMBER", description });
const opt = <T extends object>(s: T) => ({ ...s, nullable: true });

const FREQUENCY: ResponseSchema = {
	type: "OBJECT",
	properties: {
		value: int("数"),
		unit: str("単位。s=秒・m=分・h=時間", ["s", "m", "h"]),
	},
	required: ["value", "unit"],
};

/** 条件1つ。種類ごとに使う項目だけ入れ、残りは null */
const CONDITION: ResponseSchema = {
	type: "OBJECT",
	properties: {
		type: str(
			[
				"条件の種類。",
				"emaCross=短期EMA fast 本が長期EMA slow 本を上抜けた(direction=up)/下抜けた(down)。",
				"breakout=終値が直近 lookback 本の最高値を上抜けた(direction=high)/最安値を下抜けた(low)。",
				"rsi=RSI period 本が threshold 以上(direction=above)/以下(below)。",
				"rsiCross=RSI period 本が直近 bars 本以内に threshold を上抜けた(direction=up)/下抜けた(down)。bars=1 なら今の足だけ。",
				"emaPosition=終値が EMA period 本より上(direction=above)/下(below)。",
				"emaSlope=EMA period 本が bars 本前より percent % 以上上がっている(direction=up)/下がっている(down)。percent=0 なら向きだけ。",
				"bollinger=終値がボリンジャーバンド period 本・sigma σ の上限以上(band=upper)/下限以下(lower)。",
				"entryChange=買値から percent % 上がった(direction=up)/下がった(down)。売りの条件だけ。",
				"trailingStop=買ってからの最高値から percent % 下がった。最高値が買値から activatePercent % 以上になってから発動（0 は買った直後から）。売りの条件だけ。",
				"holdingBars=買ってから bars 本経った。売りの条件だけ。",
				"judgment=judge の判定が values のどれか",
			].join(""),
			[
				"emaCross",
				"breakout",
				"rsi",
				"rsiCross",
				"emaPosition",
				"emaSlope",
				"bollinger",
				"entryChange",
				"trailingStop",
				"holdingBars",
				"judgment",
			],
		),
		fast: opt(int("短期EMAの本数")),
		slow: opt(int("長期EMAの本数")),
		lookback: opt(int("直近の本数")),
		period: opt(int("RSI・EMA・ボリンジャーバンドの本数")),
		threshold: opt(int("RSI のしきい値")),
		sigma: opt(num("ボリンジャーバンドの σ")),
		band: opt(str("ボリンジャーバンドの上限・下限", ["upper", "lower"])),
		percent: opt(num("%")),
		activatePercent: opt(
			num("trailingStop を発動する、最高値の買値からの %。0 は買った直後から"),
		),
		bars: opt(
			int(
				"本数（holdingBars の保有本数・emaSlope の何本前と比べるか・rsiCross の何本以内か）",
			),
		),
		direction: opt(
			str("向き", ["up", "down", "high", "low", "above", "below"]),
		),
		judge: opt(str("判定。sentiment=センチメント・risk=リスク", JUDGES)),
		values: opt({
			type: "ARRAY",
			description:
				"判定の値。sentiment: +2=強い強気・+1=やや強気・0=中立・-1=やや弱気・-2=強い弱気 / risk: normal=平常・caution=警戒・crisis=危機 / どれでも none=データなし（採点の記録が始まる前）",
			items: {
				type: "STRING",
				enum: [...new Set(Object.values(JUDGMENT_CONDITION_VALUES).flat())],
			},
		}),
	},
	required: ["type"],
};

const group = (label: string): ResponseSchema => ({
	type: "OBJECT",
	description: label,
	properties: {
		match: str("組み合わせ方。all=すべて満たす・any=どれか1つ", ["all", "any"]),
		conditions: { type: "ARRAY", items: CONDITION },
	},
	required: ["match", "conditions"],
});

/** 構造化出力で強制する形。画面の項目との対応は description で伝える */
export const IMPROVED_STRATEGY_SCHEMA: ResponseSchema = {
	type: "OBJECT",
	properties: {
		timeframe: str(
			`足の粒度。${TIMEFRAMES.map((t) => `${t}=${TIMEFRAME_LABELS[t]}`).join("・")}`,
			TIMEFRAMES,
		),
		frequency: {
			type: "OBJECT",
			description: "足と判定の間隔",
			properties: {
				flat: { ...FREQUENCY, description: "保有なしのとき" },
				holding: { ...FREQUENCY, description: "保有中のとき" },
			},
			required: ["flat", "holding"],
		},
		orderSizeBtc: num("1回の注文量（BTC）"),
		maxPositions: int("最大ロット数"),
		dailyLossLimitYen: int("1日の損失上限（円）"),
		stopLossCooldownBars: int(
			"損切り後に買わない本数。損切り（建値ストップを含む）の売りを出してから、足の粒度でこの本数のあいだ新しい買いを出さない。0 は止めない",
		),
		...Object.fromEntries(
			CONDITION_GROUPS.map((k) => [k, group(CONDITION_GROUP_LABELS[k])]),
		),
		partialSell: {
			type: "OBJECT",
			description:
				"一部利確の売り方。partialTakeProfit の条件が空なら使わない。一部利確は1ロットにつき1回だけ",
			properties: {
				percent: int("ロットの何 % を売るか（1〜99）"),
				breakevenStop: {
					type: "BOOLEAN",
					description: "一部利確の後、買値を下回ったら残りを損切りとして売るか",
				},
			},
			required: ["percent", "breakevenStop"],
		},
		buyOrder: {
			type: "OBJECT",
			description: "買い注文の出し方",
			properties: {
				lines: {
					type: "ARRAY",
					description: "注文1, 注文2, …",
					items: {
						type: "OBJECT",
						properties: {
							type: str("market=成行・limit=指値", ["market", "limit"]),
							belowPercent: opt(num("指値を現在値から何 % 下に出すか")),
						},
						required: ["type"],
					},
				},
				expireBars: int("指値を取り消すまでの本数"),
			},
			required: ["lines", "expireBars"],
		},
	},
	required: [
		"timeframe",
		"frequency",
		"orderSizeBtc",
		"maxPositions",
		"dailyLossLimitYen",
		"stopLossCooldownBars",
		...CONDITION_GROUPS,
		"partialSell",
		"buyOrder",
	],
};

/** null の項目を落とす。AI は使わない項目を null で埋めてくる */
function dropNulls(v: unknown): unknown {
	if (Array.isArray(v)) return v.map(dropNulls);
	if (typeof v !== "object" || v === null) return v;
	return Object.fromEntries(
		Object.entries(v)
			.filter(([, x]) => x !== null)
			.map(([k, x]) => [k, dropNulls(x)]),
	);
}

/**
 * AI の出した戦略設定を読み、検証する。使えなければ理由を返す。
 * アドバイスの文章は使えるので、ここで失敗してもアドバイス全体は失敗にしない
 */
export function readImprovedStrategy(
	raw: unknown,
	base: ConditionSet,
): ImprovedStrategy {
	const fail = (reason: string): ImprovedStrategy => ({ ok: false, reason });
	if (typeof raw !== "object" || raw === null)
		return fail("AI の応答に改善版の戦略が無い");
	const { orderSizeBtc, dailyLossLimitYen, ...rest } = dropNulls(raw) as Record<
		string,
		unknown
	>;
	const params = parseConditionSet({
		...rest,
		orderSize:
			typeof orderSizeBtc === "number"
				? Math.round(orderSizeBtc * SATOSHI_PER_BTC)
				: undefined,
		dailyLossLimit: dailyLossLimitYen,
	});
	if (!params) return fail("AI の出した改善版の戦略の形が正しくない");
	const errors = validateConditionSet(params);
	if (errors.length > 0)
		return fail(
			`AI の出した改善版の戦略が設定として正しくない（${errors.map((e) => e.message).join("・")}）`,
		);
	if (conditionSetChanges(base, params).length === 0)
		return fail("改善案に戦略設定の変更が無い");
	return { ok: true, params };
}
