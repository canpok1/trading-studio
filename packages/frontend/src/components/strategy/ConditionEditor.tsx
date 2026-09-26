// 条件セットの編集欄。戦略設定とバックテストの実行画面で使う

import type {
	Condition,
	ConditionGroupKey,
	ConditionSet,
	FrequencyUnit,
	Judge,
	JudgmentValue,
	Timeframe,
	ValidationError,
} from "@trading-studio/core";
import {
	CONDITION_GROUP_LABELS,
	CONDITION_GROUPS,
	FREQUENCY_UNIT_LABELS,
	FREQUENCY_UNITS,
	formatBtc,
	JUDGE_LABELS,
	JUDGES,
	JUDGMENT_VALUE_LABELS,
	JUDGMENT_VALUES,
	SATOSHI_PER_BTC,
	TIMEFRAME_LABELS,
	TIMEFRAMES,
} from "@trading-studio/core";
import type { ReactNode } from "react";
import { useState } from "react";
import { formatInt } from "../../lib/number";
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

/** 足の粒度と判定の頻度。粒度は戦略が持つので、バックテストの実行画面では表示だけにする（timeframeEditable=false） */
export function FrequencyCard({
	params,
	onChange,
	errors,
	timeframeEditable = true,
}: Props & { timeframeEditable?: boolean }) {
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
			<h2 className="text-[15px] font-bold">足と判定の頻度</h2>
			{timeframeEditable ? (
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
			) : (
				<div className="flex flex-wrap items-center gap-2">
					<span className="text-[13px] font-semibold">足の粒度</span>
					<span className="text-sm">
						{TIMEFRAME_LABELS[params.timeframe]}（戦略設定で変える）
					</span>
				</div>
			)}
			<p className="text-xs text-text-2">
				EMA の本数・直近 N
				本・指値を取り消すまでの本数は、この粒度の足で数える。
			</p>
			{freq("flat", "ポジションなしのとき", "ごとに買いの条件を判定")}
			{freq("holding", "ポジションありのとき", "ごとに売りの条件を判定")}
			<p className="text-xs text-text-2">
				バックテストでは、足より短い間隔は足ごとに判定する。
			</p>
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
			<h2 className="text-[15px] font-bold">1回の注文量</h2>
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
			<p className="text-xs leading-relaxed text-text-2">
				買いは現在値より 0.1% 下の指値で出し、3
				本のあいだ約定しなければ取り消す。売りは成行。利確・損切りの両方が同時に成り立ったら損切りを優先する。
			</p>
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
	breakout: "直近の高値・安値の突破",
	entryChange: "買値からの %",
	"judgment:trend": "トレンド判定が指定のどれか",
	"judgment:risk": "リスク判定が指定のどれか",
	"judgment:sentiment": "センチメント判定が指定のどれか",
};

const PRICE_KINDS: Record<ConditionGroupKey, ConditionKind[]> = {
	buy: ["emaCross", "breakout"],
	takeProfit: ["emaCross", "breakout", "entryChange"],
	stopLoss: ["emaCross", "breakout", "entryChange"],
};

const JUDGMENT_KINDS = JUDGES.map((j) => `judgment:${j}` as const);

/** 判定の条件の既定値。売りでは悪い側を選んでおく */
const JUDGMENT_DEFAULTS: {
	[J in Judge]: { buy: JudgmentValue<J>[]; sell: JudgmentValue<J>[] };
} = {
	trend: { buy: ["up", "range"], sell: ["down"] },
	risk: { buy: ["normal", "caution"], sell: ["crisis"] },
	sentiment: { buy: ["0", "+1", "+2"], sell: ["-2"] },
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
		case "entryChange":
			return group === "stopLoss"
				? { type: kind, percent: 2, direction: "down" }
				: { type: kind, percent: 4, direction: "up" };
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
		case "judgment": {
			const all = JUDGMENT_VALUES[c.judge] as readonly JudgmentValue[];
			const toggle = (v: JudgmentValue, on: boolean) => {
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
