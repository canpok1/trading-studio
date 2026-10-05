import type {
	AccuracyHorizon,
	AccuracyList,
	AccuracyReport,
	LevelMatch,
	RiskBands,
	SentimentBands,
	VersionAccuracy,
	VersionComparison,
	VersionStats,
} from "@trading-studio/backend";
import type { AggregationRule, Judge } from "@trading-studio/core";
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
import {
	HORIZON_LABELS,
	MOVE_LEVEL_LABELS,
	matchCount,
	roundedRate,
} from "./Precision";

/** プロンプトで一度に試せる記事の数。プロンプトのタブと合わせる */
const TRIAL_MAX = 5;

const pct = (n: number, d: number) =>
	d === 0 ? "—" : `${Math.round((n / d) * 100)}%`;
const signedPct = (v: number | null) =>
	v === null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(2)}%`;

type ListKind = "misses" | "neutral" | "missedRisk" | "falseAlarm";
const LIST_TITLES: Record<ListKind, string> = {
	misses: "外れた記事",
	neutral: "中立の帯の記事",
	missedRisk: "見逃した記事",
	falseAlarm: "空振りの記事",
};

/** ニュース画面の精度分析タブの「精度の内訳」。採点の版ごとに、点数とその後の値動き・点数の偏りを出す */
export function AccuracyCard({ rule }: { rule: AggregationRule }) {
	const api = useApi();
	// null は設定の長さ
	const [horizon, setHorizon] = useState<AccuracyHorizon | null>(null);
	// 読み直しの間は本体が作り直されるので、選んだ版はここで持つ。null は使用中の版
	const [version, setVersion] = useState<number | null>(null);
	const load = useCallback(
		() =>
			api.api.scoring.accuracy
				.$get({ query: horizon === null ? {} : { horizon } })
				.then((r) => readJson<AccuracyReport>(r)),
		[api, horizon],
	);
	const { state, reload } = useAsync(load);
	return (
		<>
			<div className="flex items-center justify-between gap-2">
				<div className="flex items-center gap-1.5">
					<h2 className="text-[15px] font-bold">精度の内訳</h2>
					<Help label="精度の内訳">
						<p>
							記事の点数と、採点した時刻（評価に使い始める時刻）からその後の値動きを突き合わせる。版ごとに、直近の記事で集計する。期間と、最初に出す長さは設定の「ニュース」→「精度」で変える。
						</p>
						<p>
							得点率は、記事ごとに評価の段階と値動きの段階が一致で2点・1段ずれで1点・それ以外は0点とし、値動きの段階ごとの平均点（2点満点）を記事のある段階で平均した割合。段階ごとの件数と平均点も出す。段階の境目は設定で変える。
						</p>
						<p>
							中立の帯は、やや弱気とやや強気のあいだで 0
							でない点数。評価の平均を薄めるだけで、評価を動かさない。
						</p>
						<p>
							外れた記事は、センチメントが0点（2段以上ずれた）のもの。見逃した記事は、リスクの段階がその後の値動きより低かったもの（平常なのに荒れたなど）。空振りの記事は、高かったもの（危機なのに静かなど）。同じ時間帯の記事はみな同じ値動きの後に置かれるので、外れの原因がその記事とは限らない。
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
						value={
							horizon ?? (state.kind === "ok" ? state.data.horizon : "24h")
						}
						disabled={horizon === null && state.kind !== "ok"}
						onChange={setHorizon}
					/>
				</div>
			</div>
			{state.kind === "loading" ? (
				<Skeleton className="h-[220px] w-full" />
			) : state.kind === "error" ? (
				<ErrorState
					what="精度の内訳を読み込めなかった"
					next={state.message}
					action={<Button onClick={reload}>もう一度読み込む</Button>}
				/>
			) : (
				<AccuracyBody
					report={state.data}
					rule={rule}
					selected={version}
					onSelect={setVersion}
				/>
			)}
		</>
	);
}

function AccuracyBody({
	report,
	rule,
	selected,
	onSelect,
}: {
	report: AccuracyReport;
	rule: AggregationRule;
	selected: number | null;
	onSelect: (version: number) => void;
}) {
	const { versions, activeVersion, influence } = report;
	const [list, setList] = useState<ListKind | null>(null);
	const v =
		versions.find((x) => x.version === (selected ?? activeVersion)) ??
		versions[0];
	const label = (version: number) =>
		version === activeVersion ? `v${version}（使用中）` : `v${version}`;
	return (
		<section
			aria-label="精度の内訳"
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
								onChange={(s) => onSelect(Number(s))}
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
				<MatchRows
					judge="sentiment"
					m={s.match}
					bands={bandText(report.sentimentBands)}
					report={report}
				/>
				<Row label="関係なし" value={pct(s.nulls, v.articles)} />
				<Row label="プラス" value={pct(s.positive, s.scored)} />
				<Row label="中立の帯" value={pct(s.neutralBand, s.scored)} />
				<div className="flex flex-wrap gap-2 pt-1">
					<ListButton list={v.misses} kind="misses" onOpen={onOpen} />
					<ListButton list={v.neutral} kind="neutral" onOpen={onOpen} />
				</div>
			</Block>
			<Block title={`リスク · ${title}`} className="border-b-0">
				<MatchRows
					judge="risk"
					m={r.match}
					bands={bandText(report.riskBands)}
					report={report}
				/>
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
					<ListButton list={v.missedRisk} kind="missedRisk" onOpen={onOpen} />
					<ListButton list={v.falseAlarm} kind="falseAlarm" onOpen={onOpen} />
				</div>
			</Block>
		</div>
	);
}

const rateText = (m: LevelMatch) => {
	const r = roundedRate(m);
	return r === null ? "—" : `${r}%`;
};

const bandText = (b: SentimentBands | RiskBands) =>
	"small" in b
		? `横ばい ±${b.small}% 未満・大きく ±${b.large}% 以上`
		: `静か ±${b.rough}% 未満・大荒れ ±${b.wild}% 以上`;

/** 得点率と、値動きの段階ごとの件数・平均点 */
function MatchRows({
	judge,
	m,
	bands,
	report,
}: {
	judge: Judge;
	m: LevelMatch;
	bands: string;
	report: AccuracyReport;
}) {
	const n = matchCount(m);
	return (
		<>
			<Row
				label={`得点率（${HORIZON_LABELS[report.horizon]}）`}
				value={rateText(m)}
			/>
			{n === 0 ? (
				<p className="text-xs text-text-2">
					値動きの分かる記事がまだ無い。{bands}
				</p>
			) : (
				<>
					<p className="num text-xs text-text-2">
						{n} 件（2点 {m.exact}・1点 {m.near}・0点 {m.miss}）。{bands}
					</p>
					<table
						className="num w-full text-xs"
						data-testid={`match-levels-${judge}`}
					>
						<thead>
							<tr className="text-text-2">
								<th className="text-left font-normal">その後の値動き</th>
								<th className="text-right font-normal">件数</th>
								<th className="text-right font-normal">平均点</th>
							</tr>
						</thead>
						<tbody>
							{m.levels.map((l) => (
								<tr key={l.level}>
									<th className="py-0.5 text-left font-normal">
										{MOVE_LEVEL_LABELS[judge][l.level]}
									</th>
									<td className="text-right">{l.count}</td>
									<td className="text-right">
										{l.count === 0 ? "—" : (l.points / l.count).toFixed(2)}
									</td>
								</tr>
							))}
						</tbody>
					</table>
					{(n < report.minSamples || m.levels.some((l) => l.count === 0)) && (
						<p className="text-xs text-text-2">
							{n < report.minSamples
								? `${report.minSamples} 件未満`
								: "記事の無い段階がある"}
							ため、得点率は偶然の可能性
						</p>
					)}
				</>
			)}
		</>
	);
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
		["センチメントの得点率", (x) => rateText(x.sentiment.match)],
		["中立の帯", (x) => pct(x.sentiment.neutralBand, x.sentiment.scored)],
		["センチメント関係なし", (x) => pct(x.sentiment.nulls, x.articles)],
		["リスクの得点率", (x) => rateText(x.risk.match)],
	];
	const few = Math.max(
		matchCount(c.other.sentiment.match),
		matchCount(c.active.sentiment.match),
	);
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
					{minSamples} 件未満のため、得点率の差は偶然の可能性
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
