import type { CurrentJudgment } from "@trading-studio/backend";
import type { AggregationRule } from "@trading-studio/core";
import {
	DURATION_LABELS,
	HALF_LIVES_IN_WINDOW,
	JUDGE_LABELS,
	JUDGES,
	JUDGMENT_VALUE_LABELS,
	judgmentBands,
	LASTING_DURATIONS,
	validateAggregationRule,
} from "@trading-studio/core";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { useApi } from "../../api";
import { errorMessage, readJson } from "../../lib/useAsync";
import { Help } from "../Help";
import { JudgmentBadge } from "../judgment/JudgmentBadge";
import { NumberInput } from "../NumberInput";
import { Button, Card } from "../ui";

type Path =
	| `halfLifeHours.${string}`
	| `thresholds.${"sentiment" | "risk"}.${string}`;

function group(r: AggregationRule, path: Path): Record<string, number> {
	const [a, b] = path.split(".") as [string, string];
	return (
		a === "halfLifeHours"
			? r.halfLifeHours
			: r.thresholds[b as keyof AggregationRule["thresholds"]]
	) as Record<string, number>;
}

const leaf = (path: Path) => path.split(".").at(-1) as string;

function get(r: AggregationRule, path: Path): number {
	return group(r, path)[leaf(path)] as number;
}

function set(r: AggregationRule, path: Path, v: number): AggregationRule {
	const next = structuredClone(r);
	group(next, path)[leaf(path)] = v;
	return next;
}

export function RuleTab({
	saved,
	onSaved,
}: {
	saved: AggregationRule;
	onSaved: () => void;
}) {
	const api = useApi();
	const [draft, setDraft] = useState(saved);
	const [saving, setSaving] = useState(false);
	const [saveError, setSaveError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [preview, setPreview] = useState<CurrentJudgment | null>(null);
	const errors = validateAggregationRule(draft);
	const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
	const errorOf = (p: Path) => errors.find((e) => e.path === p)?.message;

	// 入力が正しい間は、この設定での今の市場評価を問い合わせる
	const valid = errors.length === 0;
	const key = JSON.stringify(draft);
	useEffect(() => {
		if (!valid) return;
		let alive = true;
		const id = setTimeout(async () => {
			try {
				const r = await api.api.judgments.preview
					.$post({ json: { rule: JSON.parse(key) } })
					.then((res) => readJson<CurrentJudgment>(res));
				if (alive) setPreview(r);
			} catch {
				if (alive) setPreview(null);
			}
		}, 300);
		return () => {
			alive = false;
			clearTimeout(id);
		};
	}, [api, key, valid]);

	const save = async () => {
		setSaving(true);
		setSaveError(null);
		try {
			await api.api.judgments.rule
				.$put({ json: { rule: draft } })
				.then((r) => readJson(r));
			setNotice("評価ルールを保存した。次の評価から反映する");
			onSaved();
		} catch (e) {
			setSaveError(errorMessage(e));
		} finally {
			setSaving(false);
		}
	};

	const field = (
		label: string,
		path: Path,
		unit: ReactNode,
		negative = false,
	) => (
		<div className="flex flex-col gap-1">
			<div className="flex flex-wrap items-center gap-2">
				<label htmlFor={`rule-${path}`} className="min-w-[72px]">
					{label}
				</label>
				<NumberInput
					id={`rule-${path}`}
					inputMode={negative ? "text" : "numeric"}
					value={get(draft, path)}
					onChange={(v) => {
						setNotice(null);
						setDraft((d) => set(d, path, v));
					}}
					invalid={errorOf(path) !== undefined}
					className="w-[76px]"
				/>
				<span>{unit}</span>
			</div>
			{errorOf(path) && (
				<p className="text-xs font-semibold text-loss">{errorOf(path)}</p>
			)}
		</div>
	);

	return (
		<>
			<Card className="flex flex-col gap-2.5">
				<div className="flex items-center gap-1.5">
					<h2 className="text-[15px] font-bold">平均のとり方</h2>
					<Help label="平均のとり方">
						<p>
							ニュースごとの重みで平均する。重みは公開した時点で 100%、AI
							が付けた持続（短期・中期・長期）ごとの半減期で半分になり、半減期の
							{HALF_LIVES_IN_WINDOW}
							倍たつと
							0%（集計の対象外）になる。持続が「なし」（相場に関係ない）のニュースは
							0%。
						</p>
						<p>
							市場評価は評価のたびに計算し直す（AI
							は呼ばない）。保存すると次の評価から反映し、過去の市場評価（チャート・バックテスト）もこのルールで計算し直す。
						</p>
					</Help>
				</div>
				<strong className="text-xs">半減期</strong>
				{LASTING_DURATIONS.map((d) => (
					<div key={d}>
						{field(DURATION_LABELS[d], `halfLifeHours.${d}`, "時間")}
					</div>
				))}
			</Card>
			<Card className="flex flex-col gap-2.5">
				<div className="flex items-center gap-1.5">
					<h2 className="text-[15px] font-bold">評価基準</h2>
					<Help label="評価基準">
						<p>
							平均点がどの範囲に入るかで評価を決める。下限を入れると、上の範囲との境目が決まる。
						</p>
						<p>
							センチメントは -100〜100（0 が中立、高いほど強気材料）、リスクは
							0〜100（高いほど危険）。
						</p>
					</Help>
				</div>
				{JUDGES.map((j) => (
					<div key={j} className="flex flex-col gap-2">
						<strong className="text-xs">{JUDGE_LABELS[j]}</strong>
						{judgmentBands(j, draft).map((b) => {
							const name = JUDGMENT_VALUE_LABELS[b.value] as string;
							const upper = b.min > b.max ? "（範囲なし）" : `〜 ${b.max} 点`;
							return b.key === null ? (
								<div
									key={b.value}
									className="flex flex-wrap items-center gap-2"
								>
									<span className="min-w-[72px]">{name}</span>
									<span className="num w-[76px] text-center">{b.min}</span>
									<span className="num">{upper}</span>
								</div>
							) : (
								<div key={b.value}>
									{field(
										name,
										`thresholds.${j}.${b.key}`,
										<span className="num">{upper}</span>,
										j === "sentiment",
									)}
								</div>
							);
						})}
					</div>
				))}
			</Card>
			{valid && preview && (
				<Card className="flex flex-col gap-2">
					<span className="text-xs text-text-2">この設定での今の市場評価</span>
					<div
						data-testid="rule-preview"
						className="flex flex-wrap items-center gap-1.5"
					>
						{JUDGES.map((j) => (
							<span key={j} className="inline-flex items-center gap-1.5">
								<JudgmentBadge judge={j} value={preview.results[j].value} />
								<span className="num text-xs text-text-2">
									{preview.results[j].average ?? "—"}点
								</span>
							</span>
						))}
					</div>
				</Card>
			)}
			<div className="grid grid-cols-2 gap-3">
				<Button
					disabled={!dirty || saving}
					onClick={() => {
						setDraft(saved);
						setNotice(null);
					}}
				>
					元に戻す
				</Button>
				<Button
					variant="primary"
					disabled={!dirty || !valid || saving}
					onClick={save}
				>
					保存
				</Button>
			</div>
			{saveError && (
				<p role="alert" className="text-xs font-semibold text-loss">
					保存できなかった: {saveError}
				</p>
			)}
			{notice && (
				<p role="status" className="text-xs font-semibold">
					{notice}
				</p>
			)}
		</>
	);
}
