// 条件セットの編集欄。「戦略」の画面とバックテストの実行画面で使う

import type {
	BuyOrder,
	BuyOrderLine,
	Condition,
	ConditionGroupKey,
	ConditionSet,
	FrequencyUnit,
	Judge,
	JudgmentConditionValue,
	JudgmentValue,
	OrderType,
	Timeframe,
	ValidationError,
} from "@trading-studio/core";
import {
	CONDITION_GROUP_LABELS,
	CONDITION_GROUPS,
	DEFAULT_BUY_BELOW_PERCENT,
	FREQUENCY_UNIT_LABELS,
	FREQUENCY_UNITS,
	formatBtc,
	JUDGE_LABELS,
	JUDGES,
	JUDGMENT_CONDITION_VALUES,
	JUDGMENT_VALUE_LABELS,
	LIMITS,
	ORDER_TYPE_LABELS,
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

/** 足の粒度と判定の頻度 */
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
				<h2 className="text-[15px] font-bold">足と判定の頻度</h2>
				<Help label="足と判定の頻度">
					<p>
						EMA・RSI・ボリンジャーバンドの本数・直近 N
						本・買ってからの本数・指値を取り消すまでの本数は、この粒度の足で数える。
					</p>
					<p>バックテストでは、足より短い間隔は足ごとに判定する。</p>
				</Help>
			</div>
			<label className="flex flex-wrap items-center gap-2">
				<span className="text-[13px] font-semibold">足の粒度</span>
				<select
					value={params.timeframe}
					onChange={(e) =>
						onChange({ ...params, timeframe: e.target.value as Timeframe })
					}
					className={selectClass}
				>
					{TIMEFRAMES.map((t) => (
						<option key={t} value={t}>
							{TIMEFRAME_LABELS[t]}
						</option>
					))}
				</select>
			</label>
			{freq("flat", "ポジションなしのとき", "ごとに買いの条件を判定")}
			{freq("holding", "ポジションありのとき", "ごとに売りの条件を判定")}
		</Card>
	);
}

const SIZE_STEP = 100_000; // 0.001 BTC

/** 1回の注文量。円換算は最後に取り込んだ足の終値で出す */
export function OrderSizeCard({
	params,
	onChange,
	errors,
	latestPrice,
}: Props & { latestPrice: number | null }) {
	const errs = errorsAt(errors, "orderSize");
	const maxErrs = errorsAt(errors, "maxPositions");
	const size = params.orderSize;
	const set = (orderSize: number) => onChange({ ...params, orderSize });
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
		<Card className="flex flex-col gap-2.5">
			<div className="flex items-center gap-1.5">
				<h2 className="text-[15px] font-bold">注文量とポジション数</h2>
				<Help label="注文量とポジション数">
					<p>
						約定した買い1件がこの量の1ロットになる。最大ポジション数は同時に持てるロットの数で、約定待ちの買いも数える。2
						以上にすると保有中も買い、買いの条件が一度外れてから再び成り立ったときに次を買う。売りはロットごとに判定する。
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
					<span>最大ポジション数</span>
					<NumberInput
						value={params.maxPositions}
						onChange={(maxPositions) => onChange({ ...params, maxPositions })}
						invalid={maxErrs.length > 0}
						inputMode="numeric"
						aria-label="最大ポジション数"
						className="w-16"
					/>
					<span className="text-xs text-text-2">
						（{LIMITS.maxPositions.min}〜{LIMITS.maxPositions.max}）
					</span>
				</div>
				<ErrorText messages={maxErrs} />
			</div>
		</Card>
	);
}

/** 1日の損失上限。戦略の条件とは別に、注文を出す手前で検査する */
export function RiskLimitCard({ params, onChange, errors }: Props) {
	const errs = errorsAt(errors, "dailyLossLimit");
	const id = useId();
	return (
		<Card className="flex flex-col gap-2.5">
			<div className="flex items-center gap-1.5">
				<h2 className="text-[15px] font-bold">リスク上限</h2>
				<Help label="リスク上限">
					<p>達したら新しい買い注文を止める（翌 0 時に再開）。</p>
					<p>
						その日（0
						時区切り）に売って確定した損益（手数料込み）で数える。含み損は数えない。売り（利確・損切り）は止めない。バックテストにも効く。
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
	takeProfit: "border-l-profit",
	stopLoss: "border-l-loss",
};

/** 追加の選択肢。AI の判定は判定器ごとに別の選択肢にする */
type ConditionKind =
	| Exclude<Condition["type"], "judgment">
	| `judgment:${Judge}`;

const CONDITION_NAMES: Record<ConditionKind, string> = {
	emaCross: "EMA のクロス",
	emaPosition: "終値と EMA の位置",
	emaSlope: "EMA の傾き",
	breakout: "直近の高値・安値の突破",
	rsi: "RSI",
	bollinger: "ボリンジャーバンド",
	entryChange: "買値からの %",
	trailingStop: "買ってからの最高値からの %（トレーリングストップ）",
	holdingBars: "買ってからの本数",
	"judgment:sentiment": "センチメント判定が指定のどれか",
	"judgment:risk": "リスク判定が指定のどれか",
};

const PRICE_KINDS: Record<ConditionGroupKey, ConditionKind[]> = {
	buy: ["emaCross", "emaPosition", "emaSlope", "breakout", "rsi", "bollinger"],
	takeProfit: [
		"emaCross",
		"emaPosition",
		"emaSlope",
		"breakout",
		"rsi",
		"bollinger",
		"entryChange",
		"trailingStop",
		"holdingBars",
	],
	stopLoss: [
		"emaCross",
		"emaPosition",
		"emaSlope",
		"breakout",
		"rsi",
		"bollinger",
		"entryChange",
		"trailingStop",
		"holdingBars",
	],
};

const JUDGMENT_KINDS = JUDGES.map((j) => `judgment:${j}` as const);

/** 判定の条件の既定値。売りでは悪い側を選んでおく */
const JUDGMENT_DEFAULTS: {
	[J in Judge]: { buy: JudgmentValue<J>[]; sell: JudgmentValue<J>[] };
} = {
	sentiment: { buy: ["0", "+1", "+2"], sell: ["-2"] },
	risk: { buy: ["normal", "caution"], sell: ["crisis"] },
};

function defaultCondition(
	kind: ConditionKind,
	group: ConditionGroupKey,
): Condition {
	const sell = group !== "buy";
	switch (kind) {
		case "emaCross":
			return {
				type: kind,
				fast: 12,
				slow: 48,
				direction: sell ? "down" : "up",
			};
		case "breakout":
			return { type: kind, lookback: 24, direction: sell ? "low" : "high" };
		case "rsi":
			return sell
				? { type: kind, period: 14, threshold: 70, direction: "above" }
				: { type: kind, period: 14, threshold: 30, direction: "below" };
		case "emaPosition":
			return { type: kind, period: 200, direction: sell ? "below" : "above" };
		case "emaSlope":
			return {
				type: kind,
				period: 50,
				bars: 5,
				percent: 0,
				direction: sell ? "down" : "up",
			};
		case "bollinger":
			return {
				type: kind,
				period: 20,
				sigma: 2,
				band: sell ? "upper" : "lower",
			};
		case "entryChange":
			return group === "stopLoss"
				? { type: kind, percent: 2, direction: "down" }
				: { type: kind, percent: 4, direction: "up" };
		case "trailingStop":
			return { type: kind, percent: 3 };
		case "holdingBars":
			return { type: kind, bars: 24 };
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
					<span>{JUDGE_LABELS[c.judge]}判定が</span>
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
	order,
	onChange,
	errors,
}: {
	order: BuyOrder;
	onChange: (o: BuyOrder) => void;
	errors: ValidationError[];
}) {
	const { lines } = order;
	const expire = errorsAt(errors, "buyOrder.expireBars");
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
						にする。最大ポジション数の空きより多ければ、空きの数だけ上から出す。
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
										name="buy-order-type"
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

/** 買い・利確・損切りの3グループ */
export function ConditionGroups({ params, onChange, errors }: Props) {
	const [adding, setAdding] = useState<ConditionGroupKey | null>(null);
	const setGroup = (
		g: ConditionGroupKey,
		next: ConditionSet[ConditionGroupKey],
	) => onChange({ ...params, [g]: next });
	return (
		<>
			{CONDITION_GROUPS.map((g) => {
				const group = params[g];
				return (
					<section
						key={g}
						aria-label={CONDITION_GROUP_LABELS[g]}
						className={`flex flex-col gap-2.5 rounded-xl border border-l-4 border-line bg-surface px-4 py-3.5 ${GROUP_BORDER[g]}`}
					>
						<div className="flex flex-wrap items-center justify-between gap-2">
							<h2 className="text-[15px] font-bold">
								{CONDITION_GROUP_LABELS[g]}
							</h2>
							{group.conditions.length > 1 && (
								<Segmented
									name={`match-${g}`}
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
										label={`${CONDITION_GROUP_LABELS[g]} ${i + 1}`}
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
						{g === "buy" && (
							<BuyOrderLines
								order={params.buyOrder}
								onChange={(buyOrder) => onChange({ ...params, buyOrder })}
								errors={errors}
							/>
						)}
					</section>
				);
			})}
			{adding && (
				<Modal
					title={`${CONDITION_GROUP_LABELS[adding]}を追加`}
					onClose={() => setAdding(null)}
				>
					{(
						[
							["価格・保有", PRICE_KINDS[adding]],
							["AI の判定", JUDGMENT_KINDS],
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
