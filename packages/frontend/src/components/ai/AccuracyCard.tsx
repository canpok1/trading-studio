import type {
	AccuracyHorizon,
	AccuracyList,
	AccuracyReport,
	VersionAccuracy,
	VersionComparison,
	VersionStats,
} from "@trading-studio/backend";
import type { AggregationRule } from "@trading-studio/core";
import type { ReactNode } from "react";
import { useCallback, useState } from "react";
import { useNavigate } from "react-router";
import { useApi } from "../../api";
import { formatDate, formatDateTime } from "../../format";
import { readJson, useAsync } from "../../lib/useAsync";
import { Help } from "../Help";
import { ScoreChip } from "../judgment/JudgmentBadge";
import { Modal } from "../Modal";
import { ErrorState, Skeleton } from "../States";
import { Button, Segmented } from "../ui";

/** プロンプトで一度に試せる記事の数。プロンプトのタブと合わせる */
const TRIAL_MAX = 5;

const HORIZON_LABELS: Record<AccuracyHorizon, string> = {
	"4h": "4時間後",
	"24h": "24時間後",
};

const pct = (n: number, d: number) =>
	d === 0 ? "—" : `${Math.round((n / d) * 100)}%`;
const signedPct = (v: number | null) =>
	v === null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(2)}%`;
const absPct = (v: number | null) => (v === null ? "—" : `${v.toFixed(2)}%`);

type ListKind = "misses" | "neutral" | "calmRisk";
const LIST_TITLES: Record<ListKind, string> = {
	misses: "外れた記事",
	neutral: "中立の帯の記事",
	calmRisk: "動かなかった警戒以上の記事",
};

/** ニュース画面の「評価の当たり具合」。採点の版ごとに、点数とその後の値動き・点数の偏りを出す */
export function AccuracyCard({ rule }: { rule: AggregationRule }) {
	const api = useApi();
	const [horizon, setHorizon] = useState<AccuracyHorizon>("24h");
	const load = useCallback(
		() =>
			api.api.scoring.accuracy
				.$get({ query: { horizon } })
				.then((r) => readJson<AccuracyReport>(r)),
		[api, horizon],
	);
	const { state, reload } = useAsync(load);
	return (
		<>
			<div className="flex items-center justify-between gap-2">
				<div className="flex items-center gap-1.5">
					<h2 className="text-[15px] font-bold">評価の当たり具合</h2>
					<Help label="評価の当たり具合">
						<p>
							記事の点数と、採点した時刻（評価に使い始める時刻）からその後の値動きを突き合わせる。版ごとに、直近の記事で集計する。
						</p>
						<p>
							当たりは、やや強気以上・やや弱気以下の点数が付いた記事のうち、値動きの向きが点数の符号と合った割合。偶然でも50%前後になる。
						</p>
						<p>
							中立の帯は、やや弱気とやや強気のあいだで 0
							でない点数。評価の平均を薄めるだけで、評価を動かさない。
						</p>
						<p>
							リスクは、警戒以上の記事の後に値動きが大きくなったかを、その版のすべての記事の後と比べる。
						</p>
						<p>
							「同じ記事で比べる」は、使用中の版とほかの版の両方で採点した記事だけで比べる。過去の記事を使用中の版で採点し直すと増える。
						</p>
					</Help>
				</div>
				<div className="w-44">
					<Segmented
						name="accuracy-horizon"
						label="値動きを測る長さ"
						size="sm"
						options={(["4h", "24h"] as const).map(
							(h) => [h, HORIZON_LABELS[h]] as const,
						)}
						value={horizon}
						onChange={setHorizon}
					/>
				</div>
			</div>
			{state.kind === "loading" ? (
				<Skeleton className="h-[220px] w-full" />
			) : state.kind === "error" ? (
				<ErrorState
					what="当たり具合を読み込めなかった"
					next={state.message}
					action={<Button onClick={reload}>もう一度読み込む</Button>}
				/>
			) : (
				<AccuracyBody report={state.data} rule={rule} />
			)}
		</>
	);
}

function AccuracyBody({
	report,
	rule,
}: {
	report: AccuracyReport;
	rule: AggregationRule;
}) {
	const { versions, activeVersion, influence } = report;
	const [selected, setSelected] = useState<number | null>(
		activeVersion ?? versions[0]?.version ?? null,
	);
	const [list, setList] = useState<ListKind | null>(null);
	const v = versions.find((x) => x.version === selected) ?? versions[0];
	const label = (version: number) =>
		version === activeVersion ? `v${version}（使用中）` : `v${version}`;
	return (
		<section
			aria-label="評価の当たり具合"
			className="flex flex-col overflow-hidden rounded-xl border border-line bg-surface"
		>
			<Block title="戦略への影響">
				<Row
					label="センチメントが中立以外"
					value={`${influence.sentiment} / ${influence.judgedHours} 時間（${pct(influence.sentiment, influence.judgedHours)}）`}
				/>
				<Row
					label="リスクが平常以外"
					value={`${influence.risk} / ${influence.judgedHours} 時間（${pct(influence.risk, influence.judgedHours)}）`}
				/>
				{influence.judgedHours > 0 &&
					influence.sentiment === 0 &&
					influence.risk === 0 && (
						<p className="text-xs text-text-2">
							この期間、評価は戦略の判断を一度も変えていない
						</p>
					)}
			</Block>
			{v === undefined ? (
				<p className="px-3.5 py-3 text-xs text-text-2">
					直近 {report.days} 日に採点した記事が無い
				</p>
			) : (
				<>
					{versions.length > 1 && (
						<div className="border-b border-line px-3.5 py-3">
							<Segmented
								name="accuracy-version"
								label="採点の版"
								size="sm"
								options={versions.map(
									(x) => [String(x.version), label(x.version)] as const,
								)}
								value={String(v.version)}
								onChange={(s) => setSelected(Number(s))}
							/>
						</div>
					)}
					<VersionBlocks
						v={v}
						report={report}
						title={label(v.version)}
						onOpen={setList}
					/>
					{report.comparisons.length > 0 && activeVersion !== null && (
						<Block title="同じ記事で比べる">
							{report.comparisons.map((c) => (
								<Comparison
									key={c.version}
									c={c}
									activeVersion={activeVersion}
									minSamples={report.minSamples}
								/>
							))}
						</Block>
					)}
					{list && (
						<NewsListModal
							title={`${LIST_TITLES[list]}（v${v.version}・${HORIZON_LABELS[report.horizon]}）`}
							list={v[list]}
							horizon={report.horizon}
							rule={rule}
							onClose={() => setList(null)}
						/>
					)}
				</>
			)}
			<p className="num border-t border-line px-3.5 py-2 text-xs text-text-2">
				直近 {report.days} 日（{formatDate(report.from)} 〜{" "}
				{formatDate(report.to)}）
			</p>
		</section>
	);
}

function VersionBlocks({
	v,
	report,
	title,
	onOpen,
}: {
	v: VersionAccuracy;
	report: AccuracyReport;
	title: string;
	onOpen: (k: ListKind) => void;
}) {
	const s = v.sentiment;
	const r = v.risk;
	return (
		<div className="grid border-b border-line md:grid-cols-2">
			<Block
				title={`センチメント · ${title} · ${v.articles} 件`}
				className="border-b md:border-r md:border-b-0"
			>
				<Row
					label={`当たり（${HORIZON_LABELS[report.horizon]}）`}
					value={hitText(s)}
				/>
				<HitNote s={s} minSamples={report.minSamples} />
				<Row label="関係なし" value={pct(s.nulls, v.articles)} />
				<Row label="プラス" value={pct(s.positive, s.scored)} />
				<Row label="中立の帯" value={pct(s.neutralBand, s.scored)} />
				<div className="flex flex-wrap gap-2 pt-1">
					<ListButton list={v.misses} kind="misses" onOpen={onOpen} />
					<ListButton list={v.neutral} kind="neutral" onOpen={onOpen} />
				</div>
			</Block>
			<Block title={`リスク · ${title}`} className="border-b-0">
				<Row
					label={`警戒以上の後の値動き（${HORIZON_LABELS[report.horizon]}）`}
					value={`${absPct(r.highMeanAbsPct)}（${r.high} 件）`}
				/>
				<Row label="すべての記事の後" value={absPct(r.baseMeanAbsPct)} />
				<Row label="関係なし" value={pct(r.nulls, v.articles)} />
				<Row
					label="最も多い点数"
					value={
						r.mode === null
							? "—"
							: `${r.mode.score}点（${pct(r.mode.count, r.scored)}）`
					}
				/>
				<div className="flex flex-wrap gap-2 pt-1">
					<ListButton list={v.calmRisk} kind="calmRisk" onOpen={onOpen} />
				</div>
			</Block>
		</div>
	);
}

const hitText = (s: VersionStats["sentiment"]) =>
	s.directed === 0
		? "—"
		: `${s.hits} / ${s.directed} 件（${pct(s.hits, s.directed)}）`;

function HitNote({
	s,
	minSamples,
}: {
	s: VersionStats["sentiment"];
	minSamples: number;
}) {
	if (s.directed === 0)
		return (
			<p className="text-xs text-text-2">
				値動きの分かる強気・弱気の材料がまだ無い
			</p>
		);
	if (s.directed < minSamples)
		return (
			<p className="text-xs text-text-2">
				{minSamples} 件未満のため、当たりは偶然の可能性
			</p>
		);
	return null;
}

function Comparison({
	c,
	activeVersion,
	minSamples,
}: {
	c: VersionComparison;
	activeVersion: number;
	minSamples: number;
}) {
	if (c.common === 0) {
		return (
			<p className="text-xs text-text-2">
				v{c.version} と v{activeVersion}{" "}
				の両方で採点した記事が無い。ニュースごとの「採点し直す」で過去の記事を v
				{activeVersion} で採点すると比べられる
			</p>
		);
	}
	// スマホ幅で3列に収めるため、件数の単位と内訳は省く
	const rows: [string, (x: VersionStats) => string][] = [
		[
			"当たり",
			(x) =>
				x.sentiment.directed === 0
					? "—"
					: `${x.sentiment.hits}/${x.sentiment.directed}（${pct(x.sentiment.hits, x.sentiment.directed)}）`,
		],
		["中立の帯", (x) => pct(x.sentiment.neutralBand, x.sentiment.scored)],
		["センチメント関係なし", (x) => pct(x.sentiment.nulls, x.articles)],
		["警戒以上の後", (x) => absPct(x.risk.highMeanAbsPct)],
	];
	const few = Math.max(c.other.sentiment.directed, c.active.sentiment.directed);
	return (
		<div className="flex flex-col gap-1">
			<table className="num w-full text-xs">
				<caption className="pb-1 text-left text-text-2">
					両方で採点した {c.common} 件
				</caption>
				<thead>
					<tr className="text-text-2">
						<th className="text-left font-normal" />
						<th className="text-right font-semibold">v{c.version}</th>
						<th className="text-right font-semibold">v{activeVersion}</th>
					</tr>
				</thead>
				<tbody>
					{rows.map(([label, f]) => (
						<tr key={label}>
							<th className="py-0.5 text-left font-normal text-text-2">
								{label}
							</th>
							<td className="text-right">{f(c.other)}</td>
							<td className="text-right">{f(c.active)}</td>
						</tr>
					))}
				</tbody>
			</table>
			{few > 0 && few < minSamples && (
				<p className="text-xs text-text-2">
					{minSamples} 件未満のため、当たりの差は偶然の可能性
				</p>
			)}
		</div>
	);
}

function Block({
	title,
	children,
	className = "border-b last:border-b-0",
}: {
	title: string;
	children: ReactNode;
	/** 区切りの線 */
	className?: string;
}) {
	return (
		<div
			className={`flex flex-col gap-1.5 border-line px-3.5 py-3 ${className}`}
		>
			<h3 className="text-[13px] font-bold">{title}</h3>
			{children}
		</div>
	);
}

function Row({ label, value }: { label: string; value: string }) {
	return (
		<div className="flex items-baseline justify-between gap-3 text-[13px]">
			<span className="text-text-2">{label}</span>
			<span className="num text-right font-semibold">{value}</span>
		</div>
	);
}

function ListButton({
	list,
	kind,
	onOpen,
}: {
	list: AccuracyList;
	kind: ListKind;
	onOpen: (k: ListKind) => void;
}) {
	return (
		<Button size="sm" disabled={list.total === 0} onClick={() => onOpen(kind)}>
			{LIST_TITLES[kind]}（{list.total}）
		</Button>
	);
}

function NewsListModal({
	title,
	list,
	horizon,
	rule,
	onClose,
}: {
	title: string;
	list: AccuracyList;
	horizon: AccuracyHorizon;
	rule: AggregationRule;
	onClose: () => void;
}) {
	const navigate = useNavigate();
	const [selected, setSelected] = useState<readonly number[]>([]);
	const toggle = (id: number) =>
		setSelected((s) =>
			s.includes(id) ? s.filter((x) => x !== id) : [...s, id],
		);
	return (
		<Modal title={title} onClose={onClose}>
			<p className="text-xs text-text-2">
				新しい順に {list.items.length} 件
				{list.total > list.items.length && `（全 ${list.total} 件）`}。
				{TRIAL_MAX} 件まで選んで、プロンプトの案で試し採点できる。
			</p>
			<div className="flex flex-col overflow-hidden rounded-xl border border-line">
				{list.items.map((n) => {
					const on = selected.includes(n.id);
					return (
						<label
							key={n.id}
							className="flex items-start gap-2.5 border-b border-line px-3 py-2.5 last:border-b-0"
						>
							<input
								type="checkbox"
								checked={on}
								disabled={!on && selected.length >= TRIAL_MAX}
								onChange={() => toggle(n.id)}
								className="mt-1"
							/>
							<span className="flex min-w-0 flex-col gap-1">
								<a
									href={n.url}
									target="_blank"
									rel="noreferrer"
									className="text-[13px] text-accent"
								>
									{n.title}
								</a>
								<span className="flex flex-wrap items-center gap-1.5">
									<ScoreChip
										judge="sentiment"
										score={n.sentiment}
										rule={rule}
									/>
									<ScoreChip judge="risk" score={n.risk} rule={rule} />
									<span className="num text-xs text-text-2">
										{HORIZON_LABELS[horizon]} {signedPct(n.returnPct)}
									</span>
								</span>
								<span className="num text-xs text-text-2">
									{n.sourceName} · {formatDateTime(n.publishedAt)}
								</span>
								{n.comment && (
									<span className="text-xs text-text-2">
										{n.comment.split("\n")[0]}
									</span>
								)}
							</span>
						</label>
					);
				})}
			</div>
			<div className="grid grid-cols-2 gap-3">
				<Button onClick={onClose}>閉じる</Button>
				<Button
					variant="primary"
					disabled={selected.length === 0}
					onClick={() =>
						navigate(
							`/settings?section=news&tab=prompt&trial=${selected.join(",")}`,
						)
					}
				>
					{selected.length} 件を試し採点
				</Button>
			</div>
		</Modal>
	);
}
