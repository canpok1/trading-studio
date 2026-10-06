// 条件セットの編集欄。「戦略」の画面とバックテストの実行画面で使う

import type {
	BuyOrder,
	BuyOrderLine,
	BuyRule,
	Condition,
	ConditionGroupKey,
	ConditionSet,
	FrequencyUnit,
	Judge,
	JudgmentConditionValue,
	JudgmentValue,
	OrderType,
	PartialSell,
	Timeframe,
	ValidationError,
} from "@trading-studio/core";
import {
	buyRuleName,
	CONDITION_GROUP_LABELS,
	CONDITION_GROUPS,
	DEFAULT_BUY_BELOW_PERCENT,
	DEFAULT_BUY_ORDER,
	DEFAULT_CONDITION_TIMEFRAME,
	DEFAULT_PARTIAL_SELL,
	FREQUENCY_UNIT_LABELS,
	FREQUENCY_UNITS,
	formatBtc,
	hasTimeframe,
	JUDGE_LABELS,
	JUDGES,
	JUDGMENT_CONDITION_VALUES,
	JUDGMENT_VALUE_LABELS,
	LIMITS,
	newBuyRuleId,
	ORDER_TYPE_LABELS,
	partialSellQuantity,
	SATOSHI_PER_BTC,
	TIMEFRAME_LABELS,
	TIMEFRAMES,
} from "@trading-studio/core";
import type { ReactNode } from "react";
import { useId, useState } from "react";
import { formatInt } from "../../lib/number";
import { Help } from "../Help";
import { Modal } from "../Modal";
import { NumberInput } from "../NumberInput";
import { Button, Card, Segmented } from "../ui";

type Props = {
	params: ConditionSet;
	onChange: (p: ConditionSet) => void;
	errors: ValidationError[];
};

const selectClass = "h-9 rounded-lg border border-line bg-surface px-2 text-sm";

function errorsIn(errors: ValidationError[], path: string): ValidationError[] {
	return errors.filter((e) => e.path === path || e.path.startsWith(`${path}.`));
}

/** prefix（「buys.0」）の下のエラーを、prefix を外したパスで返す */
function errorsUnder(
	errors: ValidationError[],
	prefix: string,
): ValidationError[] {
	return errorsIn(errors, prefix).map((e) => ({
		...e,
		path: e.path.slice(prefix.length + 1),
	}));
}

function errorsAt(
	errors: ValidationError[],
	path: string,
	exact = false,
): string[] {
	return (
		exact ? errors.filter((e) => e.path === path) : errorsIn(errors, path)
	).map((e) => e.message);
}

function ErrorText({ messages }: { messages: string[] }) {
	if (messages.length === 0) return null;
	return (
		<span className="text-xs font-semibold text-loss">
			{messages.join("・")}
		</span>
	);
}

/** 足の粒度を選ぶ。条件・指値の取消・損切り後の本数で、本数を数える足に使う */
function TimeframeSelect({
	value,
	onChange,
	label,
	invalid = false,
}: {
	value: Timeframe;
	onChange: (t: Timeframe) => void;
	label: string;
	invalid?: boolean;
}) {
	return (
		<select
			aria-label={label}
			value={value}
			onChange={(e) => onChange(e.target.value as Timeframe)}
			aria-invalid={invalid || undefined}
			className={`${selectClass} ${invalid ? "border-loss" : ""}`}
		>
			{TIMEFRAMES.map((t) => (
				<option key={t} value={t}>
					{TIMEFRAME_LABELS[t]}
				</option>
			))}
		</select>
	);
}

/** 判定の間隔 */
export function FrequencyCard({ params, onChange, errors }: Props) {
	const freq = (k: "flat" | "holding", label: string, tail: string) => {
		const f = params.frequency[k];
		const set = (next: Partial<typeof f>) =>
			onChange({
				...params,
				frequency: { ...params.frequency, [k]: { ...f, ...next } },
			});
		const errs = errorsAt(errors, `frequency.${k}`);
		return (
			<div className="flex flex-col gap-1 rounded-[10px] bg-bg px-3 py-2">
				<div className="flex flex-wrap items-center gap-1.5">
					<span>{label}</span>
					<NumberInput
						value={f.value}
						onChange={(value) => set({ value })}
						invalid={errs.length > 0}
						inputMode="numeric"
						aria-label={`${label}の判定の間隔`}
						className="w-16"
					/>
					<select
						aria-label={`${label}の判定の間隔の単位`}
						value={f.unit}
						onChange={(e) => set({ unit: e.target.value as FrequencyUnit })}
						className={selectClass}
					>
						{FREQUENCY_UNITS.map((u) => (
							<option key={u} value={u}>
								{FREQUENCY_UNIT_LABELS[u]}
							</option>
						))}
					</select>
					<span>{tail}</span>
				</div>
				<ErrorText messages={errs} />
			</div>
		);
	};
	return (
		<Card className="flex flex-col gap-2.5">
			<div className="flex items-center gap-1.5">
				<h2 className="text-[15px] font-bold">判定の間隔</h2>
				<Help label="判定の間隔">
					<p>
						条件の足は条件ごとに選ぶ。判定のたびに、確定した足と今の途中の足で計算する。
					</p>
					<p>
						バックテストでは、この間隔で判定できる足（条件で使う最も細かい足まで）で判定を進める。
					</p>
				</Help>
			</div>
			{freq("flat", "保有なしのとき", "ごとに買いの条件を判定")}
			{freq("holding", "保有中のとき", "ごとに売りの条件を判定")}
		</Card>
	);
}

const SIZE_STEP = 100_000; // 0.001 BTC

/** 買い1つの、1回の注文量と最大ロット数。円換算は最後に取り込んだ足の終値で出す */
function OrderSizeFields({
	rule,
	onChange,
	errors,
	latestPrice,
}: {
	rule: BuyRule;
	onChange: (r: BuyRule) => void;
	errors: ValidationError[];
	latestPrice: number | null;
}) {
	const errs = errorsAt(errors, "orderSize");
	const maxErrs = errorsAt(errors, "maxPositions");
	const size = rule.orderSize;
	const set = (orderSize: number) => onChange({ ...rule, orderSize });
	const step = (d: number) =>
		set(
			Math.max(
				SIZE_STEP,
				(Number.isFinite(size)
					? Math.round(size / SIZE_STEP) * SIZE_STEP
					: SIZE_STEP) +
					d * SIZE_STEP,
			),
		);
	return (
		<div className="flex flex-col gap-2.5">
			<div className="flex items-center gap-1.5">
				<h3 className="text-[15px] font-bold">注文量とロット数</h3>
				<Help label="注文量とロット数">
					<p>
						約定した買い1件がこの量の1ロットになる。最大ロット数はこの買いで同時に持てるロットの数で、この買いの約定待ちの買いも数える。2
						以上にすると保有中も買い、買いの条件が一度外れてから再び成り立ったときに次を買う。売りはロットごとに、そのロットを買った買いの条件で判定する。
					</p>
					<p>
						買いの出し方は「買い注文する条件」で選ぶ。売りは成行。利確・損切りの両方が同時に成り立ったら損切りを優先する。
					</p>
				</Help>
			</div>
			<div className="flex items-center gap-2">
				<Button
					className="w-11 px-0"
					aria-label="0.001 減らす"
					onClick={() => step(-1)}
				>
					−
				</Button>
				<NumberInput
					value={size}
					onChange={set}
					format={(n) => formatBtc(n)}
					parse={parseBtc}
					invalid={errs.length > 0}
					aria-label="1回の注文量（BTC）"
					className="h-11 flex-1 text-[15px]"
				/>
				<Button
					className="w-11 px-0"
					aria-label="0.001 増やす"
					onClick={() => step(1)}
				>
					＋
				</Button>
			</div>
			<span className="num text-xs text-text-2">
				BTC · 約{" "}
				{latestPrice && Number.isFinite(size)
					? formatInt((size / SATOSHI_PER_BTC) * latestPrice)
					: "—"}
				円 （取り込み済みデータの最新の終値で換算）
			</span>
			<ErrorText messages={errs} />
			<div className="flex flex-col gap-1 rounded-[10px] bg-bg px-3 py-2">
				<div className="flex flex-wrap items-center gap-1.5 text-sm">
					<span>最大ロット数</span>
					<NumberInput
						value={rule.maxPositions}
						onChange={(maxPositions) => onChange({ ...rule, maxPositions })}
						invalid={maxErrs.length > 0}
						inputMode="numeric"
						aria-label="最大ロット数"
						className="w-16"
					/>
					<span className="text-xs text-text-2">
						（{LIMITS.maxPositions.min}〜{LIMITS.maxPositions.max}）
					</span>
				</div>
				<ErrorText messages={maxErrs} />
			</div>
		</div>
	);
}

/** 1日の損失上限。戦略の条件とは別に、注文を出す手前で検査する */
export function RiskLimitCard({ params, onChange, errors }: Props) {
	const errs = errorsAt(errors, "dailyLossLimit");
	const cooldownErrs = errorsAt(errors, "stopLossCooldownBars");
	const cooldownTfErrs = errorsAt(errors, "stopLossCooldownTimeframe");
	const id = useId();
	const cooldownId = useId();
	return (
		<Card className="flex flex-col gap-2.5">
			<div className="flex items-center gap-1.5">
				<h2 className="text-[15px] font-bold">リスク上限</h2>
				<Help label="リスク上限">
					<p>
						1日の損失上限: 達したら新しい買い注文を止める（翌 0 時に再開）。
					</p>
					<p>
						その日（0
						時区切り）に売って確定した損益（手数料込み）で数える。含み損は数えない。売り（利確・損切り）は止めない。バックテストにも効く。
					</p>
					<p>
						損切り後に買わない本数:
						損切り（建値ストップを含む）の売りを出してから、選んだ足でこの本数ぶんの時間は、どの買いも新しい買いを出さない。0
						なら止めない。自動取引をオンにし直すと、損切りした時刻を忘れる。
					</p>
				</Help>
			</div>
			<div className="flex flex-col gap-1.5">
				<label htmlFor={id} className="text-[13px] font-semibold">
					1日の損失上限（円）
				</label>
				<NumberInput
					id={id}
					value={params.dailyLossLimit}
					onChange={(dailyLossLimit) => onChange({ ...params, dailyLossLimit })}
					format={formatInt}
					inputMode="numeric"
					invalid={errs.length > 0}
					className="h-11 text-[15px]"
				/>
			</div>
			<ErrorText messages={errs} />
			<div className="flex flex-col gap-1.5">
				<label htmlFor={cooldownId} className="text-[13px] font-semibold">
					損切り後に買わない本数
				</label>
				<div className="flex flex-wrap items-center gap-2">
					<TimeframeSelect
						value={params.stopLossCooldownTimeframe}
						onChange={(stopLossCooldownTimeframe) =>
							onChange({ ...params, stopLossCooldownTimeframe })
						}
						label="損切り後に買わない本数を数える足"
						invalid={cooldownTfErrs.length > 0}
					/>
					<span className="text-sm">で</span>
					<NumberInput
						id={cooldownId}
						value={params.stopLossCooldownBars}
						onChange={(stopLossCooldownBars) =>
							onChange({ ...params, stopLossCooldownBars })
						}
						inputMode="numeric"
						invalid={cooldownErrs.length > 0}
						className="h-11 w-24 text-[15px]"
					/>
					<span className="text-xs text-text-2">
						本（{LIMITS.stopLossCooldownBars.min}〜
						{LIMITS.stopLossCooldownBars.max}、0 は止めない）
					</span>
				</div>
			</div>
			<ErrorText messages={[...cooldownTfErrs, ...cooldownErrs]} />
		</Card>
	);
}

/** BTC の文字列を satoshi へ。読めなければ NaN */
function parseBtc(s: string): number {
	const m = /^\s*(\d+)(?:\.(\d{0,8}))?\s*$/.exec(s);
	if (!m) return Number.NaN;
	return Number(m[1]) * SATOSHI_PER_BTC + Number((m[2] ?? "").padEnd(8, "0"));
}

const GROUP_BORDER: Record<ConditionGroupKey, string> = {
	buy: "border-l-buy",
	partialTakeProfit: "border-l-profit",
	takeProfit: "border-l-profit",
	stopLoss: "border-l-loss",
};

/** 追加の選択肢。市場評価は観点ごとに別の選択肢にする */
type ConditionKind =
	| Exclude<Condition["type"], "judgment">
	| `judgment:${Judge}`;

const CONDITION_NAMES: Record<ConditionKind, string> = {
	emaCross: "EMA のクロス",
	emaPosition: "終値と EMA の位置",
	emaSlope: "EMA の傾き",
	breakout: "直近の高値・安値の突破",
	rsi: "RSI",
	rsiCross: "RSI のクロス",
	bollinger: "ボリンジャーバンド",
	entryChange: "買値からの %",
	trailingStop: "買ってからの最高値からの %（トレーリングストップ）",
	holdingBars: "買ってからの本数",
	"judgment:sentiment": "センチメントが指定のどれか",
	"judgment:risk": "リスクが指定のどれか",
};

const SELL_KINDS: ConditionKind[] = [
	"emaCross",
	"emaPosition",
	"emaSlope",
	"breakout",
	"rsi",
	"rsiCross",
	"bollinger",
	"entryChange",
	"trailingStop",
	"holdingBars",
];

const PRICE_KINDS: Record<ConditionGroupKey, ConditionKind[]> = {
	buy: [
		"emaCross",
		"emaPosition",
		"emaSlope",
		"breakout",
		"rsi",
		"rsiCross",
		"bollinger",
	],
	partialTakeProfit: SELL_KINDS,
	takeProfit: SELL_KINDS,
	stopLoss: SELL_KINDS,
};

const JUDGMENT_KINDS = JUDGES.map((j) => `judgment:${j}` as const);

/** 判定の条件の既定値。売りでは悪い側を選んでおく */
const JUDGMENT_DEFAULTS: {
	[J in Judge]: { buy: JudgmentValue<J>[]; sell: JudgmentValue<J>[] };
} = {
	sentiment: { buy: ["0", "+1", "+2"], sell: ["-2"] },
	risk: { buy: ["calm", "mild", "alert", "severe"], sell: ["crisis"] },
};

function defaultCondition(
	kind: ConditionKind,
	group: ConditionGroupKey,
): Condition {
	const sell = group !== "buy";
	const timeframe = DEFAULT_CONDITION_TIMEFRAME;
	switch (kind) {
		case "emaCross":
			return {
				type: kind,
				timeframe,
				fast: 12,
				slow: 48,
				direction: sell ? "down" : "up",
			};
		case "breakout":
			return {
				type: kind,
				timeframe,
				lookback: 24,
				direction: sell ? "low" : "high",
			};
		case "rsi":
			return sell
				? {
						type: kind,
						timeframe,
						period: 14,
						threshold: 70,
						direction: "above",
					}
				: {
						type: kind,
						timeframe,
						period: 14,
						threshold: 30,
						direction: "below",
					};
		case "rsiCross":
			return {
				type: kind,
				timeframe,
				period: 14,
				threshold: sell ? 70 : 30,
				bars: 1,
				direction: sell ? "down" : "up",
			};
		case "emaPosition":
			return {
				type: kind,
				timeframe,
				period: 200,
				direction: sell ? "below" : "above",
			};
		case "emaSlope":
			return {
				type: kind,
				timeframe,
				period: 50,
				bars: 5,
				percent: 0,
				direction: sell ? "down" : "up",
			};
		case "bollinger":
			return {
				type: kind,
				timeframe,
				period: 20,
				sigma: 2,
				band: sell ? "upper" : "lower",
			};
		case "entryChange":
			return group === "stopLoss"
				? { type: kind, percent: 2, direction: "down" }
				: { type: kind, percent: 4, direction: "up" };
		case "trailingStop":
			return { type: kind, percent: 3, activatePercent: 0 };
		case "holdingBars":
			return { type: kind, timeframe, bars: 24 };
		default: {
			const judge = kind.slice("judgment:".length) as Judge;
			return {
				type: "judgment",
				judge,
				values: [...JUDGMENT_DEFAULTS[judge][sell ? "sell" : "buy"]],
			};
		}
	}
}

function ConditionRow({
	condition: c,
	onChange,
	onRemove,
	errors,
	label,
}: {
	condition: Condition;
	onChange: (c: Condition) => void;
	onRemove: () => void;
	errors: ValidationError[];
	label: string;
}) {
	const bad = (field: string) =>
		errors.some((e) => e.path.endsWith(`.${field}`));
	let body: ReactNode;
	switch (c.type) {
		case "emaCross":
			body = (
				<>
					<span>短期EMA</span>
					<NumberInput
						value={c.fast}
						onChange={(fast) => onChange({ ...c, fast })}
						invalid={bad("fast")}
						inputMode="numeric"
						aria-label="短期EMA の本数"
						className="w-16"
					/>
					<span>本が 長期EMA</span>
					<NumberInput
						value={c.slow}
						onChange={(slow) => onChange({ ...c, slow })}
						invalid={bad("slow")}
						inputMode="numeric"
						aria-label="長期EMA の本数"
						className="w-16"
					/>
					<span>本を</span>
					<select
						aria-label="クロスの向き"
						value={c.direction}
						onChange={(e) =>
							onChange({ ...c, direction: e.target.value as "up" | "down" })
						}
						className={selectClass}
					>
						<option value="up">上抜けた</option>
						<option value="down">下抜けた</option>
					</select>
				</>
			);
			break;
		case "breakout":
			body = (
				<>
					<span>終値が直近</span>
					<NumberInput
						value={c.lookback}
						onChange={(lookback) => onChange({ ...c, lookback })}
						invalid={bad("lookback")}
						inputMode="numeric"
						aria-label="直近の本数"
						className="w-16"
					/>
					<span>本の</span>
					<select
						aria-label="突破の向き"
						value={c.direction}
						onChange={(e) =>
							onChange({ ...c, direction: e.target.value as "high" | "low" })
						}
						className={selectClass}
					>
						<option value="high">最高値を上抜けた</option>
						<option value="low">最安値を下抜けた</option>
					</select>
				</>
			);
			break;
		case "rsi":
			body = (
				<>
					<span>RSI</span>
					<NumberInput
						value={c.period}
						onChange={(period) => onChange({ ...c, period })}
						invalid={bad("period")}
						inputMode="numeric"
						aria-label="RSI の本数"
						className="w-16"
					/>
					<span>本が</span>
					<NumberInput
						value={c.threshold}
						onChange={(threshold) => onChange({ ...c, threshold })}
						invalid={bad("threshold")}
						inputMode="numeric"
						aria-label="RSI のしきい値"
						className="w-16"
					/>
					<select
						aria-label="以上・以下"
						value={c.direction}
						onChange={(e) =>
							onChange({
								...c,
								direction: e.target.value as "above" | "below",
							})
						}
						className={selectClass}
					>
						<option value="above">以上</option>
						<option value="below">以下</option>
					</select>
				</>
			);
			break;
		case "rsiCross":
			body = (
				<>
					<span>RSI</span>
					<NumberInput
						value={c.period}
						onChange={(period) => onChange({ ...c, period })}
						invalid={bad("period")}
						inputMode="numeric"
						aria-label="RSI の本数"
						className="w-16"
					/>
					<span>本が</span>
					<NumberInput
						value={c.threshold}
						onChange={(threshold) => onChange({ ...c, threshold })}
						invalid={bad("threshold")}
						inputMode="numeric"
						aria-label="RSI のしきい値"
						className="w-16"
					/>
					<span>を</span>
					<select
						aria-label="クロスの向き"
						value={c.direction}
						onChange={(e) =>
							onChange({ ...c, direction: e.target.value as "up" | "down" })
						}
						className={selectClass}
					>
						<option value="up">上抜けた</option>
						<option value="down">下抜けた</option>
					</select>
					<span>（直近</span>
					<NumberInput
						value={c.bars}
						onChange={(bars) => onChange({ ...c, bars })}
						invalid={bad("bars")}
						inputMode="numeric"
						aria-label="何本以内に抜けたか"
						className="w-16"
					/>
					<span>本以内）</span>
				</>
			);
			break;
		case "emaPosition":
			body = (
				<>
					<span>終値が EMA</span>
					<NumberInput
						value={c.period}
						onChange={(period) => onChange({ ...c, period })}
						invalid={bad("period")}
						inputMode="numeric"
						aria-label="EMA の本数"
						className="w-16"
					/>
					<span>本より</span>
					<select
						aria-label="上下"
						value={c.direction}
						onChange={(e) =>
							onChange({
								...c,
								direction: e.target.value as "above" | "below",
							})
						}
						className={selectClass}
					>
						<option value="above">上</option>
						<option value="below">下</option>
					</select>
				</>
			);
			break;
		case "emaSlope":
			body = (
				<>
					<span>EMA</span>
					<NumberInput
						value={c.period}
						onChange={(period) => onChange({ ...c, period })}
						invalid={bad("period")}
						inputMode="numeric"
						aria-label="EMA の本数"
						className="w-16"
					/>
					<span>本が</span>
					<NumberInput
						value={c.bars}
						onChange={(bars) => onChange({ ...c, bars })}
						invalid={bad("bars")}
						inputMode="numeric"
						aria-label="何本前と比べるか"
						className="w-16"
					/>
					<span>本前より</span>
					<NumberInput
						value={c.percent}
						onChange={(percent) => onChange({ ...c, percent })}
						invalid={bad("percent")}
						inputMode="decimal"
						aria-label="傾きの %"
						className="w-16"
					/>
					<span>% 以上</span>
					<select
						aria-label="上下"
						value={c.direction}
						onChange={(e) =>
							onChange({ ...c, direction: e.target.value as "up" | "down" })
						}
						className={selectClass}
					>
						<option value="up">上がっている</option>
						<option value="down">下がっている</option>
					</select>
				</>
			);
			break;
		case "bollinger":
			body = (
				<>
					<span>終値がボリンジャーバンド</span>
					<NumberInput
						value={c.period}
						onChange={(period) => onChange({ ...c, period })}
						invalid={bad("period")}
						inputMode="numeric"
						aria-label="ボリンジャーバンドの本数"
						className="w-16"
					/>
					<span>本・</span>
					<NumberInput
						value={c.sigma}
						onChange={(sigma) => onChange({ ...c, sigma })}
						invalid={bad("sigma")}
						inputMode="decimal"
						aria-label="ボリンジャーバンドの σ"
						className="w-16"
					/>
					<span>σ の</span>
					<select
						aria-label="上限・下限"
						value={c.band}
						onChange={(e) =>
							onChange({ ...c, band: e.target.value as "upper" | "lower" })
						}
						className={selectClass}
					>
						<option value="upper">上限以上</option>
						<option value="lower">下限以下</option>
					</select>
				</>
			);
			break;
		case "trailingStop":
			body = (
				<>
					<span>買ってからの最高値から</span>
					<NumberInput
						value={c.percent}
						onChange={(percent) => onChange({ ...c, percent })}
						invalid={bad("percent")}
						aria-label="最高値からの %"
						className="w-16"
					/>
					<span>% 下がった</span>
					<span className="flex basis-full flex-wrap items-center gap-1.5">
						<span>発動: 最高値が買値から</span>
						<NumberInput
							value={c.activatePercent}
							onChange={(activatePercent) =>
								onChange({ ...c, activatePercent })
							}
							invalid={bad("activatePercent")}
							aria-label="発動する最高値の買値からの %"
							className="w-16"
						/>
						<span>% 以上になってから（0 は買った直後から）</span>
					</span>
				</>
			);
			break;
		case "holdingBars":
			body = (
				<>
					<span>買ってから</span>
					<NumberInput
						value={c.bars}
						onChange={(bars) => onChange({ ...c, bars })}
						invalid={bad("bars")}
						inputMode="numeric"
						aria-label="買ってからの本数"
						className="w-16"
					/>
					<span>本経った</span>
				</>
			);
			break;
		case "judgment": {
			const all = JUDGMENT_CONDITION_VALUES[
				c.judge
			] as readonly JudgmentConditionValue[];
			const toggle = (v: JudgmentConditionValue, on: boolean) => {
				const set = new Set<string>(c.values);
				if (on) set.add(v);
				else set.delete(v);
				// 並びは選択肢の並びに揃える
				onChange({ ...c, values: all.filter((x) => set.has(x)) });
			};
			body = (
				<>
					<span>{JUDGE_LABELS[c.judge]}が</span>
					<span className="flex flex-wrap gap-1">
						{all.map((v) => (
							<label
								key={v}
								className="flex h-8 cursor-pointer items-center gap-1 rounded-full border border-line bg-surface px-2.5 text-xs font-semibold has-checked:border-accent has-checked:bg-accent has-checked:text-white has-focus-visible:outline-2 has-focus-visible:outline-accent dark:has-checked:text-accent-ink"
							>
								<input
									type="checkbox"
									className="sr-only"
									checked={(c.values as string[]).includes(v)}
									onChange={(e) => toggle(v, e.target.checked)}
								/>
								{JUDGMENT_VALUE_LABELS[v] ?? v}
							</label>
						))}
					</span>
					<span>のどれか</span>
				</>
			);
			break;
		}
		case "entryChange":
			body = (
				<>
					<span>買値から</span>
					<NumberInput
						value={c.percent}
						onChange={(percent) => onChange({ ...c, percent })}
						invalid={bad("percent")}
						aria-label="買値からの %"
						className="w-16"
					/>
					<span>%</span>
					<select
						aria-label="上下"
						value={c.direction}
						onChange={(e) =>
							onChange({ ...c, direction: e.target.value as "up" | "down" })
						}
						className={selectClass}
					>
						<option value="up">上がった</option>
						<option value="down">下がった</option>
					</select>
				</>
			);
			break;
	}
	return (
		<fieldset className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-1.5 gap-y-1 rounded-[10px] bg-bg py-2 pr-1 pl-3">
			<legend className="sr-only">{label}</legend>
			<div className="flex flex-wrap items-center gap-1.5 text-sm leading-normal">
				{hasTimeframe(c) && (
					<>
						<TimeframeSelect
							value={c.timeframe}
							onChange={(timeframe) => onChange({ ...c, timeframe })}
							label="条件の足"
							invalid={bad("timeframe")}
						/>
						<span>で</span>
					</>
				)}
				{body}
			</div>
			<button
				type="button"
				aria-label="この条件を削除"
				onClick={onRemove}
				className="flex h-9 w-9 items-center justify-center rounded-full text-text-2 hover:bg-surface-2"
			>
				<svg
					width="18"
					height="18"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="2"
					aria-hidden="true"
				>
					<path d="M6 6l12 12M18 6 6 18" />
				</svg>
			</button>
			{errors.length > 0 && (
				<span className="col-span-2">
					<ErrorText messages={errors.map((e) => e.message)} />
				</span>
			)}
		</fieldset>
	);
}

/** 行を足すときの指値の %。最後の指値より 0.5% 下、指値が無ければ既定 */
function nextBelowPercent(lines: BuyOrderLine[]): number {
	const last = lines.findLast((l) => l.type === "limit");
	return last?.type === "limit" && Number.isFinite(last.belowPercent)
		? Math.round((last.belowPercent + 0.5) * 100) / 100
		: DEFAULT_BUY_BELOW_PERCENT;
}

/**
 * 買い注文の出し方。行の数だけ同時に出す。成行は先頭の1行だけ選べ、指値は行ごとに % を入れる。
 * 取消までの本数は指値の行で共通
 */
function BuyOrderLines({
	scope,
	order,
	onChange,
	errors,
}: {
	/** 同じ画面に買いが複数あってもラジオの組が混ざらないよう、name に付ける */
	scope: string;
	order: BuyOrder;
	onChange: (o: BuyOrder) => void;
	errors: ValidationError[];
}) {
	const { lines } = order;
	const expire = [
		...errorsAt(errors, "buyOrder.expireTimeframe"),
		...errorsAt(errors, "buyOrder.expireBars"),
	];
	const setLines = (next: BuyOrderLine[]) =>
		onChange({ ...order, lines: next });
	const setLine = (i: number, next: BuyOrderLine) =>
		setLines(lines.map((l, j) => (j === i ? next : l)));
	const hasLimit = lines.some((l) => l.type === "limit");
	return (
		<div className="flex flex-col gap-1.5 border-t border-line pt-2.5">
			<span className="flex items-center gap-1.5 text-[13px] font-semibold">
				注文
				<Help label="注文">
					<p>条件が成り立つと全部を同時に出す。</p>
					<p>
						成行は1件目だけ選べる。指値は下の行ほど大きい %
						にする。最大ロット数の空きより多ければ、空きの数だけ上から出す。
					</p>
				</Help>
			</span>
			{lines.map((line, i) => {
				const below = errorsAt(errors, `buyOrder.lines.${i}.belowPercent`);
				const lineErrs = errorsAt(errors, `buyOrder.lines.${i}`, true);
				return (
					// 行は並びで識別する（同じ内容の行を一時的に置けるため）
					// biome-ignore lint/suspicious/noArrayIndexKey: 同上
					<div key={i} className="flex flex-col gap-1">
						<div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-1.5 rounded-[10px] bg-bg py-1.5 pr-1 pl-3">
							<div className="flex flex-wrap items-center gap-1.5 text-sm">
								<span className="num text-xs font-bold text-text-2">
									{i + 1}
								</span>
								{i === 0 ? (
									<Segmented<OrderType>
										name={`buy-order-type-${scope}`}
										label="1件目の注文方法"
										size="sm"
										options={(["limit", "market"] as const).map(
											(t) => [t, ORDER_TYPE_LABELS[t]] as const,
										)}
										value={line.type}
										onChange={(type) =>
											setLine(
												0,
												type === "market"
													? { type }
													: {
															type,
															belowPercent: DEFAULT_BUY_BELOW_PERCENT,
														},
											)
										}
									/>
								) : (
									<span>{ORDER_TYPE_LABELS[line.type]}</span>
								)}
								{line.type === "limit" ? (
									<>
										<span>現在値から</span>
										<NumberInput
											value={line.belowPercent}
											onChange={(belowPercent) =>
												setLine(i, { ...line, belowPercent })
											}
											invalid={below.length > 0}
											inputMode="decimal"
											aria-label={`${i + 1}件目の指値を現在値から下げる %`}
											className="w-16"
										/>
										<span>% 下</span>
									</>
								) : (
									<span className="text-xs text-text-2">
										次の約定の価格で買う
									</span>
								)}
							</div>
							{lines.length > 1 ? (
								<button
									type="button"
									aria-label={`${i + 1}件目の注文を削除`}
									onClick={() => setLines(lines.filter((_, j) => j !== i))}
									className="flex h-9 w-9 items-center justify-center rounded-full text-text-2 hover:bg-surface-2"
								>
									<svg
										width="18"
										height="18"
										viewBox="0 0 24 24"
										fill="none"
										stroke="currentColor"
										strokeWidth="2"
										aria-hidden="true"
									>
										<path d="M6 6l12 12M18 6 6 18" />
									</svg>
								</button>
							) : (
								<span className="h-9 w-9" />
							)}
						</div>
						<ErrorText messages={[...lineErrs, ...below]} />
					</div>
				);
			})}
			<ErrorText messages={errorsAt(errors, "buyOrder.lines", true)} />
			{lines.length < LIMITS.buyOrderLines.max && (
				<Button
					size="sm"
					className="self-start"
					onClick={() =>
						setLines([
							...lines,
							{ type: "limit", belowPercent: nextBelowPercent(lines) },
						])
					}
				>
					＋ 指値を追加
				</Button>
			)}
			{hasLimit && (
				<div className="flex flex-col gap-1">
					<div className="flex flex-wrap items-center gap-1.5 text-sm">
						<span>指値は</span>
						<TimeframeSelect
							value={order.expireTimeframe}
							onChange={(expireTimeframe) =>
								onChange({ ...order, expireTimeframe })
							}
							label="指値を取り消すまでの本数を数える足"
							invalid={errors.some(
								(e) => e.path === "buyOrder.expireTimeframe",
							)}
						/>
						<span>で</span>
						<NumberInput
							value={order.expireBars}
							onChange={(expireBars) => onChange({ ...order, expireBars })}
							invalid={expire.length > 0}
							inputMode="numeric"
							aria-label="指値を取り消すまでの本数"
							className="w-16"
						/>
						<span>本のあいだ約定しなければ取消</span>
					</div>
					<ErrorText messages={expire} />
				</div>
			)}
		</div>
	);
}

/** 一部利確の売り方。一部利確の条件があるときだけ出す */
function PartialSellFields({
	rule,
	onChange,
	errors,
}: {
	rule: BuyRule;
	onChange: (v: PartialSell) => void;
	errors: ValidationError[];
}) {
	const ps = rule.partialSell;
	const percentErrs = errorsAt(errors, "partialSell.percent");
	const sold = Number.isInteger(ps.percent)
		? partialSellQuantity(rule.orderSize, ps.percent)
		: null;
	return (
		<div className="flex flex-col gap-2 border-t border-line pt-2.5">
			<div className="flex flex-col gap-1">
				<div className="flex flex-wrap items-center gap-1.5 text-sm">
					<span>成立したらロットの</span>
					<NumberInput
						value={ps.percent}
						onChange={(percent) => onChange({ ...ps, percent })}
						invalid={percentErrs.length > 0}
						inputMode="numeric"
						aria-label="一部利確で売る割合"
						className="w-16"
					/>
					<span>% を売る</span>
				</div>
				{sold !== null && Number.isFinite(rule.orderSize) && (
					<p className="text-xs text-text-2">
						1ロットにつき1回だけ。1回の注文量なら {formatBtc(sold)} BTC を売り、
						{formatBtc(rule.orderSize - sold)} BTC を残す
					</p>
				)}
				<ErrorText messages={percentErrs} />
			</div>
			<label className="flex cursor-pointer items-center gap-2 text-sm">
				<input
					type="checkbox"
					className="h-4 w-4 accent-accent"
					checked={ps.breakevenStop}
					onChange={(e) => onChange({ ...ps, breakevenStop: e.target.checked })}
				/>
				一部利確の後、買値を下回ったら残りを損切りとして売る
			</label>
		</div>
	);
}

/** 買い1つの、買い・一部利確・利確・損切りの4グループ。labelPrefix は買いが複数のとき見出しの頭に付ける */
function RuleGroups({
	rule,
	onChange,
	errors,
	labelPrefix,
}: {
	rule: BuyRule;
	onChange: (r: BuyRule) => void;
	errors: ValidationError[];
	labelPrefix: string;
}) {
	const [adding, setAdding] = useState<ConditionGroupKey | null>(null);
	const params = rule;
	const setGroup = (g: ConditionGroupKey, next: BuyRule[ConditionGroupKey]) =>
		onChange({ ...rule, [g]: next });
	return (
		<>
			{CONDITION_GROUPS.map((g) => {
				const group = params[g];
				return (
					<section
						key={g}
						aria-label={`${labelPrefix}${CONDITION_GROUP_LABELS[g]}`}
						className={`flex flex-col gap-2.5 rounded-xl border border-l-4 border-line bg-surface px-4 py-3.5 ${GROUP_BORDER[g]}`}
					>
						<div className="flex flex-wrap items-center justify-between gap-2">
							<h3 className="text-[15px] font-bold">
								{CONDITION_GROUP_LABELS[g]}
							</h3>
							{group.conditions.length > 1 && (
								<Segmented
									name={`match-${rule.id}-${g}`}
									label="組み合わせ方"
									size="sm"
									options={[
										["all", "すべて満たす"],
										["any", "どれか1つ"],
									]}
									value={group.match}
									onChange={(match) => setGroup(g, { ...group, match })}
								/>
							)}
						</div>
						<div className="flex flex-col gap-1.5">
							{group.conditions.length === 0 && (
								<p className="text-xs text-text-2">条件なし</p>
							)}
							{group.conditions.map((c, i) => (
								// 条件は並びで識別する（同じ内容の条件を2つ置けるため）
								// biome-ignore lint/suspicious/noArrayIndexKey: 同上
								<div key={i} className="flex flex-col gap-1.5">
									{i > 0 && (
										<span className="pl-3 text-[11px] font-bold text-text-2">
											{group.match === "all" ? "かつ" : "または"}
										</span>
									)}
									<ConditionRow
										condition={c}
										label={`${labelPrefix}${CONDITION_GROUP_LABELS[g]} ${i + 1}`}
										errors={errorsIn(errors, `${g}.conditions.${i}`)}
										onChange={(nc) =>
											setGroup(g, {
												...group,
												conditions: group.conditions.map((x, j) =>
													j === i ? nc : x,
												),
											})
										}
										onRemove={() =>
											setGroup(g, {
												...group,
												conditions: group.conditions.filter((_, j) => j !== i),
											})
										}
									/>
								</div>
							))}
						</div>
						<ErrorText messages={errorsAt(errors, g, true)} />
						<Button
							size="sm"
							className="self-start"
							onClick={() => setAdding(g)}
						>
							＋ 条件を追加
						</Button>
						{g === "partialTakeProfit" && group.conditions.length > 0 && (
							<PartialSellFields
								rule={rule}
								onChange={(partialSell) => onChange({ ...rule, partialSell })}
								errors={errors}
							/>
						)}
						{g === "buy" && (
							<BuyOrderLines
								scope={rule.id}
								order={rule.buyOrder}
								onChange={(buyOrder) => onChange({ ...rule, buyOrder })}
								errors={errors}
							/>
						)}
					</section>
				);
			})}
			{adding && (
				<Modal
					title={`${labelPrefix}${CONDITION_GROUP_LABELS[adding]}を追加`}
					onClose={() => setAdding(null)}
				>
					{(
						[
							["価格・保有", PRICE_KINDS[adding]],
							["市場評価", JUDGMENT_KINDS],
						] as const
					).map(([title, kinds]) => (
						<div key={title} className="flex flex-col gap-1.5">
							<span className="text-xs text-text-2">{title}</span>
							<div className="overflow-hidden rounded-xl border border-line">
								{kinds.map((t) => (
									<button
										key={t}
										type="button"
										className="flex w-full border-b border-line px-4 py-3.5 text-left text-[15px] last:border-b-0 hover:bg-surface-2"
										onClick={() => {
											const group = params[adding];
											setGroup(adding, {
												...group,
												conditions: [
													...group.conditions,
													defaultCondition(t, adding),
												],
											});
											setAdding(null);
										}}
									>
										{CONDITION_NAMES[t]}
									</button>
								))}
							</div>
						</div>
					))}
					<Button onClick={() => setAdding(null)}>やめる</Button>
				</Modal>
			)}
		</>
	);
}

/** 新しく足す買い。損切りが無いと保存できないので、空の戦略のひな形と同じ損切りを入れておく */
function newBuyRule(params: ConditionSet): BuyRule {
	const names = new Set(params.buys.map((b) => b.name.trim()));
	let n = params.buys.length + 1;
	while (names.has(buyRuleName(n))) n++;
	return {
		id: newBuyRuleId(params),
		name: buyRuleName(n),
		orderSize: params.buys[0]?.orderSize ?? SIZE_STEP * 10,
		maxPositions: 1,
		buy: { match: "all", conditions: [] },
		buyOrder: { ...DEFAULT_BUY_ORDER, lines: [...DEFAULT_BUY_ORDER.lines] },
		partialTakeProfit: { match: "all", conditions: [] },
		partialSell: { ...DEFAULT_PARTIAL_SELL },
		takeProfit: { match: "any", conditions: [] },
		stopLoss: {
			match: "any",
			conditions: [{ type: "entryChange", percent: 2, direction: "down" }],
		},
	};
}

/** 閉じたカードに出す、買いの中身の要約 */
function ruleSummary(rule: BuyRule): string {
	const n = (k: ConditionGroupKey) => rule[k].conditions.length;
	return [
		`買い ${n("buy")}`,
		n("partialTakeProfit") > 0 ? `一部利確 ${n("partialTakeProfit")}` : null,
		`利確 ${n("takeProfit")}`,
		`損切り ${n("stopLoss")}`,
	]
		.filter((x) => x !== null)
		.join("・");
}

/**
 * 買いの一覧。買いごとのカードに、名前・注文量とロット数・買いの条件と注文・一部利確・利確・損切りを持つ。
 * 上の買いほど優先する（同じ判定で複数成立したら上の1つだけ注文する）
 */
export function BuyRulesEditor({
	params,
	onChange,
	errors,
	latestPrice,
}: Props & { latestPrice: number | null }) {
	const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());
	const multi = params.buys.length >= 2;
	const setBuys = (buys: BuyRule[]) => onChange({ ...params, buys });
	const setRule = (i: number, r: BuyRule) =>
		setBuys(params.buys.map((b, j) => (j === i ? r : b)));
	const move = (i: number, d: -1 | 1) => {
		const buys = [...params.buys];
		const [r] = buys.splice(i, 1);
		buys.splice(i + d, 0, r as BuyRule);
		setBuys(buys);
	};
	const toggle = (id: string) =>
		setClosed((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	return (
		<>
			{params.buys.map((rule, i) => {
				const prefix = `buys.${i}`;
				const ruleErrors = errorsUnder(errors, prefix);
				const open = !closed.has(rule.id);
				const nameErrs = errorsAt(ruleErrors, "name");
				return (
					<section
						key={rule.id}
						aria-label={`買い「${rule.name}」`}
						className="flex flex-col gap-2.5 rounded-2xl border-2 border-line p-2.5"
					>
						<div className="flex items-center gap-2 px-1.5">
							<button
								type="button"
								aria-expanded={open}
								onClick={() => toggle(rule.id)}
								className="flex min-w-0 flex-1 items-center gap-2 py-1 text-left"
							>
								<span className="text-xs text-text-2" aria-hidden>
									{open ? "▾" : "▸"}
								</span>
								<span className="flex min-w-0 flex-col">
									<span className="truncate text-[15px] font-bold">
										{multi ? `${i + 1}. ` : ""}
										{rule.name.trim() || "（名前なし）"}
									</span>
									{!open && (
										<span className="text-xs text-text-2">
											{ruleSummary(rule)}
										</span>
									)}
									{!open && ruleErrors.length > 0 && (
										<span className="text-xs font-semibold text-loss">
											入力の誤りがある
										</span>
									)}
								</span>
							</button>
							{multi && (
								<div className="flex shrink-0 gap-1">
									<Button
										size="sm"
										className="w-9 px-0"
										aria-label={`「${rule.name}」を上へ`}
										disabled={i === 0}
										onClick={() => move(i, -1)}
									>
										↑
									</Button>
									<Button
										size="sm"
										className="w-9 px-0"
										aria-label={`「${rule.name}」を下へ`}
										disabled={i === params.buys.length - 1}
										onClick={() => move(i, 1)}
									>
										↓
									</Button>
									<Button
										size="sm"
										className="text-loss"
										aria-label={`「${rule.name}」を削除`}
										onClick={() =>
											setBuys(params.buys.filter((_, j) => j !== i))
										}
									>
										削除
									</Button>
								</div>
							)}
						</div>
						{open && (
							<>
								<Card className="flex flex-col gap-2.5">
									<label className="flex flex-col gap-1.5">
										<span className="text-[13px] font-semibold">
											買いの名前
										</span>
										<input
											value={rule.name}
											onChange={(e) =>
												setRule(i, { ...rule, name: e.target.value })
											}
											aria-invalid={nameErrs.length > 0 || undefined}
											className="h-11 rounded-[10px] border border-line bg-surface px-3 text-[15px] aria-invalid:border-2 aria-invalid:border-loss"
										/>
									</label>
									<ErrorText messages={nameErrs} />
									<OrderSizeFields
										rule={rule}
										onChange={(r) => setRule(i, r)}
										errors={ruleErrors}
										latestPrice={latestPrice}
									/>
								</Card>
								<RuleGroups
									rule={rule}
									onChange={(r) => setRule(i, r)}
									errors={ruleErrors}
									labelPrefix={multi ? `「${rule.name}」の` : ""}
								/>
							</>
						)}
					</section>
				);
			})}
			<ErrorText messages={errorsAt(errors, "buys", true)} />
			{params.buys.length < LIMITS.buys.max && (
				<div className="flex flex-col gap-1">
					<Button
						className="self-start"
						onClick={() => setBuys([...params.buys, newBuyRule(params)])}
					>
						＋ 買いを追加
					</Button>
					{multi && (
						<p className="text-xs text-text-2">
							同じ判定で複数の買いが成り立ったら、上の買いだけ注文する。ロットは買った買いの条件で売る
						</p>
					)}
				</div>
			)}
		</>
	);
}
