import { describe, expect, test } from "bun:test";
import type { ConditionSet } from "./condition-strategy";
import {
	DEFAULT_BUY_ORDER,
	DEFAULT_PARTIAL_SELL,
	singleBuy,
} from "./condition-strategy";
import { conditionScreenText, conditionSetChanges } from "./screen-text";

const BASE: ConditionSet = singleBuy({
	frequency: {
		flat: { value: 1, unit: "h" },
		holding: { value: 1, unit: "h" },
	},
	orderSize: 1_000_000,
	maxPositions: 1,
	dailyLossLimit: 30_000,
	stopLossCooldownBars: 0,
	stopLossCooldownTimeframe: "1h",
	buy: {
		match: "all",
		conditions: [
			{
				type: "emaCross",
				timeframe: "1h",
				fast: 12,
				slow: 48,
				direction: "up",
			},
		],
	},
	buyOrder: DEFAULT_BUY_ORDER,
	partialTakeProfit: { match: "all", conditions: [] },
	partialSell: DEFAULT_PARTIAL_SELL,
	takeProfit: {
		match: "any",
		conditions: [{ type: "entryChange", percent: 5, direction: "up" }],
	},
	stopLoss: { match: "any", conditions: [] },
});
const rule = (p: ConditionSet) => p.buys[0] as ConditionSet["buys"][number];

describe("戦略設定の変更点", () => {
	test("同じなら無い", () => {
		expect(conditionSetChanges(BASE, structuredClone(BASE))).toEqual([]);
	});

	test("値を変えた条件は、変える前と後の行で出す", () => {
		const after = structuredClone(BASE);
		rule(after).buy.conditions[0] = {
			type: "emaCross",
			timeframe: "1h",
			fast: 20,
			slow: 48,
			direction: "up",
		};
		rule(after).maxPositions = 3;
		expect(conditionSetChanges(BASE, after)).toEqual([
			{
				section: "注文量とロット数",
				removed: ["最大ロット数: 1"],
				added: ["最大ロット数: 3"],
			},
			{
				section: "買い注文する条件",
				removed: ["1時間足で 短期EMA 12 本が 長期EMA 48 本を上抜けた"],
				added: ["1時間足で 短期EMA 20 本が 長期EMA 48 本を上抜けた"],
			},
		]);
	});

	test("先頭に条件を足しても、残りの条件は変わったことにしない。組み合わせ方の変更も出す", () => {
		const after = structuredClone(BASE);
		rule(after).takeProfit = {
			match: "all",
			conditions: [
				{
					type: "rsi",
					timeframe: "1h",
					period: 14,
					threshold: 70,
					direction: "above",
				},
				...rule(BASE).takeProfit.conditions,
			],
		};
		rule(after).stopLoss.conditions = [
			{ type: "trailingStop", percent: 3, activatePercent: 0 },
		];
		expect(conditionSetChanges(BASE, after)).toEqual([
			{
				section: "売り注文（利確）する条件",
				removed: ["組み合わせ方: どれか1つ"],
				added: ["組み合わせ方: すべて満たす", "1時間足で RSI 14 本が 70 以上"],
			},
			{
				section: "売り注文（損切り）する条件",
				removed: ["条件なし"],
				added: ["買ってからの最高値から 3% 下がった"],
			},
		]);
	});
	test("消した買いの見出しは、その行を消したものとして出す", () => {
		const two = structuredClone(BASE);
		two.buys.push({ ...structuredClone(rule(BASE)), id: "b2", name: "買い2" });
		const one = structuredClone(two);
		one.buys.pop();
		one.buys[0] = { ...rule(one), name: "押し目" };
		two.buys[0] = { ...rule(two), name: "押し目" };
		const changes = conditionSetChanges(two, one);
		const sections = changes.map((c) => c.section);
		expect(sections).toContain("【買い2】注文量とロット数");
		expect(
			changes.find((c) => c.section === "【買い2】注文量とロット数")?.added,
		).toEqual([]);
		expect(
			changes.every((c) => c.removed.length > 0 || c.added.length > 0),
		).toBe(true);
	});
});

describe("条件の文言", () => {
	test("ATR の条件は足を ATR の前に置く", () => {
		expect(
			conditionScreenText({
				type: "entryAtr",
				timeframe: "1h",
				period: 14,
				multiple: 2,
				direction: "down",
			}),
		).toBe("買値から 1時間足の ATR 14 本の 2 倍 下がった");
		expect(
			conditionScreenText({
				type: "trailingAtr",
				timeframe: "1h",
				period: 14,
				multiple: 3,
				activateMultiple: 1,
			}),
		).toBe(
			"買ってからの最高値から 1時間足の ATR 14 本の 3 倍 下がった（最高値が買値から ATR の 1 倍以上になってから発動）",
		);
	});

	test("ADX は足・本数・しきい値・以上/以下で書く", () => {
		expect(
			conditionScreenText({
				type: "adx",
				timeframe: "1h",
				period: 14,
				threshold: 20,
				direction: "above",
			}),
		).toBe("1時間足で ADX 14 本が 20 以上");
	});

	test("予定イベントの前後は種類と前後の時間で書く", () => {
		expect(
			conditionScreenText({
				type: "eventWindow",
				events: ["fomc", "boj"],
				beforeHours: 0,
				afterHours: 24,
				allowNoCalendar: false,
			}),
		).toBe("予定イベント（FOMC 声明・日銀会合）の後 24 時間でない");
		expect(
			conditionScreenText({
				type: "eventWindow",
				events: ["cpi"],
				beforeHours: 0,
				afterHours: 24,
				allowNoCalendar: true,
			}),
		).toBe(
			"予定イベント（米 CPI）の後 24 時間でない（暦切れのときは成立とみなす）",
		);
	});
});
