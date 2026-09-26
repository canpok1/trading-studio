import type { CurrentJudgment } from "@trading-studio/backend";
import type { AggregationRule } from "@trading-studio/core";
import { JUDGES, validateAggregationRule } from "@trading-studio/core";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { useApi } from "../../api";
import { errorMessage, readJson } from "../../lib/useAsync";
import { JudgmentBadge } from "../judgment/JudgmentBadge";
import { NumberInput } from "../NumberInput";
import { Button, Card } from "../ui";

type Path =
	| "windowHours"
	| "halfLifeHours"
	| `thresholds.${"trend" | "risk" | "sentiment"}.${string}`;

function get(r: AggregationRule, path: Path): number {
	const [a, b, c] = path.split(".") as [string, string?, string?];
	if (a === "windowHours" || a === "halfLifeHours") return r[a];
	const group = r.thresholds[b as keyof AggregationRule["thresholds"]];
	return (group as Record<string, number>)[c as string] as number;
}

function set(r: AggregationRule, path: Path, v: number): AggregationRule {
	const next = structuredClone(r);
	const [a, b, c] = path.split(".") as [string, string?, string?];
	if (a === "windowHours" || a === "halfLifeHours") next[a] = v;
	else {
		const group = next.thresholds[b as keyof AggregationRule["thresholds"]];
		(group as Record<string, number>)[c as string] = v;
	}
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

	// 入力が正しい間は、この設定での今の判定を問い合わせる
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
			setNotice("集計ルールを保存した。次の判定から反映する");
			onSaved();
		} catch (e) {
			setSaveError(errorMessage(e));
		} finally {
			setSaving(false);
		}
	};

	const field = (label: string, path: Path, unit: ReactNode) => (
		<div className="flex flex-col gap-1">
			<div className="flex flex-wrap items-center gap-2">
				<label htmlFor={`rule-${path}`} className="min-w-[72px]">
					{label}
				</label>
				<NumberInput
					id={`rule-${path}`}
					inputMode="numeric"
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
				<h2 className="text-[15px] font-bold">平均のとり方</h2>
				{field("期間", "windowHours", "時間")}
				{field("半減期", "halfLifeHours", "時間")}
				<p className="text-xs text-text-2">
					半減期ごとに重みが半分になる。
					{Number.isFinite(draft.halfLifeHours) ? draft.halfLifeHours : "—"}{" "}
					時間前のニュースは今の半分の重み。
				</p>
			</Card>
			<Card className="flex flex-col gap-2.5">
				<h2 className="text-[15px] font-bold">判定に変えるしきい値</h2>
				<strong className="text-xs">トレンド</strong>
				{field("上昇", "thresholds.trend.up", "点以上")}
				{field("下落", "thresholds.trend.down", "点以下")}
				<span className="text-xs text-text-2">間はレンジ</span>
				<strong className="text-xs">リスク</strong>
				{field("警戒", "thresholds.risk.caution", "点以上")}
				{field("危機", "thresholds.risk.crisis", "点以上")}
				<span className="text-xs text-text-2">未満は平常</span>
				<strong className="text-xs">センチメント</strong>
				{field("+2", "thresholds.sentiment.plus2", "点以上")}
				{field("+1", "thresholds.sentiment.plus1", "点以上")}
				{field("−1", "thresholds.sentiment.minus1", "点未満")}
				{field("−2", "thresholds.sentiment.minus2", "点未満")}
				<span className="text-xs text-text-2">間は 0</span>
			</Card>
			{valid && preview && (
				<Card className="flex flex-col gap-2">
					<span className="text-xs text-text-2">この設定での今の判定</span>
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
			<p className="text-xs text-text-2">
				集計は判定のたびに計算し直す（AI
				は呼ばない）。保存すると次の判定から反映し、過去の判定（チャート・バックテスト）もこのルールで計算し直す。
			</p>
		</>
	);
}
