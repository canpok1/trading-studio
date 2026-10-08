// 市場評価の分析（精度の集計）。ニュース画面の評価詳細のタブに出す（docs/news-page.md）

import type {
	AccuracyPeriod,
	AccuracySummary,
	AccuracySummaryResult,
} from "@trading-studio/backend";
import type { Judge, JudgmentValue } from "@trading-studio/core";
import { JUDGE_LABELS, JUDGES } from "@trading-studio/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { useApi } from "../../api";
import { formatVersion } from "../../format";
import type { AnalysisUnit, AnalysisView } from "../../lib/eval-analysis-view";
import {
	ANALYSIS_UNITS,
	ANALYSIS_VIEWS,
	useAnalysisUnit,
	useAnalysisView,
} from "../../lib/eval-analysis-view";
import { errorMessage, readJson, useInterval } from "../../lib/useAsync";
import { Help } from "../Help";
import {
	JudgmentLegend,
	LEVEL_ORDER,
	levelFill,
} from "../judgment/JudgmentBadge";
import { valueStyle } from "../judgment/judgment-style";
import { Segmented } from "../ui";

/** 測定中の記事が測れるようになるのを拾う間隔。記事ごとの精度と合わせる */
const POLL_MS = 60_000;

/** 設定の選択肢。Segmented が文字列しか扱えないので、すべて（null）を "all" で表す */
export const PERIOD_OPTIONS = [
	["7", "7日"],
	["30", "30日"],
	["90", "90日"],
	["all", "すべて"],
] as const;
export type PeriodKey = (typeof PERIOD_OPTIONS)[number][0];
export const periodKey = (p: AccuracyPeriod): PeriodKey =>
	p === null ? "all" : (String(p) as PeriodKey);
export const periodOf = (k: PeriodKey): AccuracyPeriod =>
	k === "all" ? null : (Number(k) as AccuracyPeriod);

const periodText = (p: AccuracyPeriod) =>
	p === null ? "すべての期間" : `直近${p}日`;

/** 版の絞り込み。URL（?prompt=&server=）に持つ。ブラウザに保存すると、次に開いたとき絞り込み中だと気づかず読み違えるため */
const PROMPT_PARAM = "prompt";
const SERVER_PARAM = "server";
export const ANALYSIS_FILTER_PARAMS = [PROMPT_PARAM, SERVER_PARAM] as const;
/** サーバーの「記録なし」（記録前・開発版の採点）の値 */
const SERVER_NONE = "none";

function useVersionFilter() {
	const [params, setParams] = useSearchParams();
	const prompt = params.get(PROMPT_PARAM) ?? "";
	const server = params.get(SERVER_PARAM) ?? "";
	const set = (key: string, v: string) => {
		const next = new URLSearchParams(params);
		if (v === "") next.delete(key);
		else next.set(key, v);
		setParams(next, { replace: true });
	};
	return {
		prompt: /^\d+$/.test(prompt) ? prompt : "",
		server: server === SERVER_NONE || /^\d+$/.test(server) ? server : "",
		setPrompt: (v: string) => set(PROMPT_PARAM, v),
		setServer: (v: string) => set(SERVER_PARAM, v),
	};
}

/** 見出し「市場評価の分析」と、見せ方の切替、観点ごとのカード。at は集計の時点（null は今） */
export function AccuracySummarySection({
	at,
	active,
}: {
	at: number | null;
	active: boolean;
}) {
	const api = useApi();
	const [data, setData] = useState<AccuracySummary | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [view, setView] = useAnalysisView();
	const [unit, setUnit] = useAnalysisUnit();
	const { prompt, server, setPrompt, setServer } = useVersionFilter();
	// 時点を変えた直後と定期の問い合わせが重なっても、最後に出したものだけ使う
	const seq = useRef(0);
	const load = useCallback(async () => {
		const id = ++seq.current;
		try {
			const r = await api.api.scoring.accuracy.summary
				.$get({
					// 空文字は省いたのと同じ（すべて・今）
					query: {
						at: at === null ? "" : String(at),
						criteriaVersion: prompt,
						appBuiltAt: server,
					},
				})
				.then((res) => readJson<AccuracySummary>(res));
			if (id !== seq.current) return;
			setData(r);
			setError(null);
		} catch (e) {
			if (id === seq.current) setError(errorMessage(e));
		}
	}, [api, at, prompt, server]);
	useEffect(() => {
		if (active) load();
	}, [active, load]);
	useInterval(load, POLL_MS, active);

	return (
		<section aria-label="市場評価の分析" className="flex flex-col gap-2.5">
			<div className="flex flex-wrap items-center gap-x-2 gap-y-1">
				<h2 className="text-[15px] font-bold">市場評価の分析</h2>
				{data && (
					<span
						data-testid="accuracy-summary-setting"
						className="num text-xs text-text-2"
					>
						{periodText(data.periodDays)}・{data.horizon}
						{data.filter.criteriaVersion !== null &&
							`・v${data.filter.criteriaVersion}`}
						{data.filter.appBuiltAt !== null &&
							`・${formatVersion(data.filter.appBuiltAt === "none" ? null : data.filter.appBuiltAt, "記録なし", { year: false })}`}
					</span>
				)}
				<Help label="市場評価の分析">
					<p>
						期間（設定の「精度」）に採点した記事の精度を数える。精度は一覧の各記事に出しているものと同じで、記事の点数の段階（評価基準に当てたもの）と、採点から測る長さの後の値動きの段階が一致で
						5、1段ずれるごとに 1 下げる。
					</p>
					<p>
						精度ごと: 棒は精度ごとの件数で、記事の段階で色分けする。評価ごと:
						棒は記事の段階ごとの件数で、精度で色分けする（緑ほど高く、赤ほど低い）。棒を押すと内訳を出す。割合にすると、棒の高さをそろえて中身の割合を比べられる。
					</p>
					<p>
						評価×値動き:
						行が記事の段階、列が実際の値動きの段階。枠のマスが一致（精度
						5）。枠より左上は記事の段階が値動きより上（強気・警戒に寄りすぎ）、右下は下（弱気・平常に寄りすぎ）。割合にすると行ごとの割合を出す。
					</p>
					<p>
						プロンプト・サーバーを選ぶと、その版のプロンプト・そのバージョンのアプリで採点した記事だけ数える（採点し直した記事は置き換えた後の版）。選択肢は期間内に数える記事がある版で、（）は絞る前の件数。
					</p>
					<p>
						測る長さがまだたっていない記事（測定中）・値動きが分からない記事・持続が「なし」の記事は数えない。
					</p>
				</Help>
			</div>
			<VersionSelects
				data={data}
				prompt={prompt}
				server={server}
				onPrompt={setPrompt}
				onServer={setServer}
			/>
			<div className="flex gap-2">
				<div className="flex-1">
					<Segmented
						name="eval-analysis-view"
						label="見せ方"
						options={ANALYSIS_VIEWS}
						value={view}
						onChange={setView}
						size="sm"
					/>
				</div>
				<div className="w-24">
					<Segmented
						name="eval-analysis-unit"
						label="件数か割合か"
						options={ANALYSIS_UNITS}
						value={unit}
						onChange={setUnit}
						size="sm"
					/>
				</div>
			</div>
			{data ? (
				JUDGES.map((j) => (
					<SummaryCard
						key={j}
						judge={j}
						result={data.results[j]}
						view={view}
						unit={unit}
					/>
				))
			) : error ? null : (
				<p role="status" className="text-xs text-text-2">
					読み込み中
				</p>
			)}
			{error && (
				<p role="alert" className="text-xs font-semibold text-loss">
					精度を読み込めなかった（{error}）
				</p>
			)}
		</section>
	);
}

/**
 * プロンプトの版とサーバーのバージョンの絞り込み。選んでいる版が選択肢に無くても（期間外など）0件として出す。
 * 読み込む前は件数が分からないので添えない。サーバーはスマホの幅に収めるため年を省く
 */
function VersionSelects({
	data,
	prompt,
	server,
	onPrompt,
	onServer,
}: {
	data: AccuracySummary | null;
	prompt: string;
	server: string;
	onPrompt: (v: string) => void;
	onServer: (v: string) => void;
}) {
	const o = data?.options;
	const prompts = (o?.criteriaVersions ?? []).map((x) => ({
		value: String(x.version),
		label: `v${x.version}（${x.count}件）${x.version === o?.activeCriteriaVersion ? "使用中" : ""}`,
	}));
	if (prompt && !prompts.some((x) => x.value === prompt))
		prompts.unshift({
			value: prompt,
			label: `v${prompt}${o ? "（0件）" : ""}`,
		});
	const servers = (o?.appBuiltAts ?? []).map((x) => {
		const value = x.builtAt === null ? SERVER_NONE : String(x.builtAt);
		return {
			value,
			label: `${formatVersion(x.builtAt, "記録なし", { year: false })}（${x.count}件）`,
		};
	});
	if (server && !servers.some((x) => x.value === server))
		servers.unshift({
			value: server,
			label: `${formatVersion(server === SERVER_NONE ? null : Number(server), "記録なし", { year: false })}${o ? "（0件）" : ""}`,
		});
	const select = (
		label: string,
		value: string,
		items: { value: string; label: string }[],
		onChange: (v: string) => void,
	) => (
		<label className="flex min-w-0 flex-1 flex-col gap-0.5">
			<span className="text-xs text-text-2">{label}</span>
			<select
				aria-label={label}
				value={value}
				onChange={(e) => onChange(e.target.value)}
				className="h-9 w-full min-w-0 rounded-[10px] border border-line bg-surface px-2 text-sm"
			>
				<option value="">すべて</option>
				{items.map((x) => (
					<option key={x.value} value={x.value}>
						{x.label}
					</option>
				))}
			</select>
		</label>
	);
	return (
		<div className="flex gap-2">
			{select("プロンプト", prompt, prompts, onPrompt)}
			{select("サーバー", server, servers, onServer)}
		</div>
	);
}

/** 棒の高さの最大（px） */
const CHART_H = 120;

/** 件数の割合を整数の % で出す。0 件でないのに 0% に丸まるものは「1%未満」 */
function percent(n: number, total: number): string {
	if (n === 0 || total === 0) return "0%";
	const p = Math.round((n / total) * 100);
	return p === 0 ? "1%未満" : `${p}%`;
}

/** 精度の色。損益と同じく良いほど緑・悪いほど赤（5 が濃い緑、4 が薄い緑、3 が灰、2 が薄い赤、1 が濃い赤） */
const PRECISION_COLOR = [
	"",
	"var(--color-loss)",
	"color-mix(in srgb, var(--color-loss) 45%, var(--color-surface))",
	"color-mix(in srgb, var(--color-range) 55%, var(--color-surface))",
	"color-mix(in srgb, var(--color-profit) 45%, var(--color-surface))",
	"var(--color-profit)",
];
const precisionFill = (p: number): React.CSSProperties => ({
	background: PRECISION_COLOR[p],
	boxShadow: "inset 0 0 0 1px var(--color-line)",
});

/** 値動きの段階の呼び名（番号 0〜4 の順）。表の列見出しに使い、狭いときは区切りで折り返す */
const MOVE_LABELS: Record<Judge, readonly (readonly string[])[]> = {
	sentiment: [
		["大きく", "下落"],
		["下落"],
		["横ばい"],
		["上昇"],
		["大きく", "上昇"],
	],
	risk: [
		["静か"],
		["やや", "荒れ"],
		["荒れた"],
		["かなり", "荒れ"],
		["大荒れ"],
	],
};

/** 記事の段階の番号（0〜4）。値動きの段階の番号と同じ向き */
const levelIndex = <J extends Judge>(judge: J, v: JudgmentValue<J>) =>
	(LEVEL_ORDER[judge] as readonly JudgmentValue<J>[]).indexOf(v);

function SummaryCard<J extends Judge>({
	judge,
	result,
	view,
	unit,
}: {
	judge: J;
	result: AccuracySummaryResult<J>;
	view: AnalysisView;
	unit: AnalysisUnit;
}) {
	return (
		<section
			aria-label={`${JUDGE_LABELS[judge]}の精度`}
			data-testid={`accuracy-summary-${judge}`}
			className="flex flex-col gap-2 rounded-xl border border-line bg-surface px-3.5 py-3"
		>
			<span className="flex flex-wrap items-center gap-x-2 gap-y-1">
				<strong>{JUDGE_LABELS[judge]}</strong>
				<span className="num text-xs text-text-2">
					{result.average === null
						? "精度を出せた記事なし"
						: `平均 ${result.average.toFixed(1)} · ${result.count}件`}
				</span>
			</span>
			{view === "precision" ? (
				<ByPrecision judge={judge} result={result} unit={unit} />
			) : view === "level" ? (
				<ByLevel judge={judge} result={result} unit={unit} />
			) : (
				<Matrix judge={judge} result={result} unit={unit} />
			)}
		</section>
	);
}

type Bar = {
	key: string;
	/** 棒の下の名前 */
	label: string;
	/** 読み上げの名前 */
	name: string;
	total: number;
	/** 下から積む */
	segments: { key: string; count: number; style: React.CSSProperties }[];
};

/** 縦の積み上げ棒。割合では件数のある棒の高さをそろえる。棒を押すと selected が変わる */
function StackedBars({
	bars,
	unit,
	axis,
	selected,
	onSelect,
}: {
	bars: Bar[];
	unit: AnalysisUnit;
	axis: string;
	selected: string | null;
	onSelect: (key: string | null) => void;
}) {
	const max = Math.max(1, ...bars.map((b) => b.total));
	return (
		<>
			<div className="flex items-end gap-2 border-b border-line">
				{bars.map((b) => (
					<button
						key={b.key}
						type="button"
						aria-label={`${b.name}: ${b.total}件`}
						aria-pressed={selected === b.key}
						disabled={b.total === 0}
						onClick={() => onSelect(selected === b.key ? null : b.key)}
						className={`flex flex-1 flex-col items-center justify-end gap-1 rounded-t-md pt-1 ${selected === b.key ? "bg-surface-2" : ""}`}
						style={{ height: CHART_H + 24 }}
					>
						<span className="num text-xs whitespace-nowrap">{b.total}件</span>
						<span
							className="flex w-3/5 max-w-10 flex-col-reverse overflow-hidden rounded-t-sm"
							style={{
								height:
									unit === "ratio"
										? b.total === 0
											? 0
											: CHART_H
										: (b.total / max) * CHART_H,
							}}
						>
							{b.segments.map((s) =>
								s.count === 0 ? null : (
									<i
										key={s.key}
										data-segment={s.key}
										style={{
											height: `${(s.count / b.total) * 100}%`,
											...s.style,
										}}
									/>
								),
							)}
						</span>
					</button>
				))}
			</div>
			<div
				aria-hidden="true"
				className="-mt-1 flex gap-2 text-center text-xs leading-tight text-text-2"
			>
				{bars.map((b) => (
					<span key={b.key} className="num flex-1 break-keep">
						{b.label}
					</span>
				))}
			</div>
			<p className="-mt-1 text-center text-[10px] text-text-2">{axis}</p>
		</>
	);
}

/** 精度ごと: 横軸は精度（左が 1）、棒の中は記事の段階 */
function ByPrecision<J extends Judge>({
	judge,
	result,
	unit,
}: {
	judge: J;
	result: AccuracySummaryResult<J>;
	unit: AnalysisUnit;
}) {
	const [open, setOpen] = useState<string | null>(null);
	const rows = [...result.rows].sort((a, b) => a.precision - b.precision);
	const bars: Bar[] = rows.map((r) => ({
		key: String(r.precision),
		label: String(r.precision),
		name: `精度 ${r.precision}`,
		total: r.count,
		segments: LEVEL_ORDER[judge].map((v) => ({
			key: v,
			count: r.levels.find((x) => x.value === v)?.count ?? 0,
			style: levelFill(judge, v),
		})),
	}));
	const selected = rows.find((r) => String(r.precision) === open);
	return (
		<>
			<StackedBars
				bars={bars}
				unit={unit}
				axis="精度"
				selected={open}
				onSelect={setOpen}
			/>
			{selected && (
				<p data-testid="accuracy-summary-detail" className="num text-xs">
					精度 {selected.precision}:{" "}
					{[...LEVEL_ORDER[judge]]
						.reverse()
						.flatMap((v) => {
							const n = selected.levels.find((x) => x.value === v)?.count ?? 0;
							return n === 0
								? []
								: [
										`${valueStyle(judge, v).label} ${n}件（${percent(n, selected.count)}）`,
									];
						})
						.join(" · ")}
				</p>
			)}
			<JudgmentLegend judge={judge} />
		</>
	);
}

/** 記事の段階ごとの、精度 1〜5 の件数（添字が精度）。精度ごとの集計（rows）から読み替える */
function precisionCounts<J extends Judge>(
	result: AccuracySummaryResult<J>,
	v: JudgmentValue<J>,
): number[] {
	const counts = [0, 0, 0, 0, 0, 0];
	for (const r of result.rows)
		counts[r.precision] = r.levels.find((x) => x.value === v)?.count ?? 0;
	return counts;
}

/** 評価ごと: 横軸は記事の段階（左が かなり弱気・平常）、棒の中は精度（下が 5） */
function ByLevel<J extends Judge>({
	judge,
	result,
	unit,
}: {
	judge: J;
	result: AccuracySummaryResult<J>;
	unit: AnalysisUnit;
}) {
	const [open, setOpen] = useState<string | null>(null);
	const levels = LEVEL_ORDER[judge].map((v) => {
		const counts = precisionCounts(result, v);
		const total = counts.reduce((a, b) => a + b, 0);
		const average =
			total === 0 ? null : counts.reduce((a, n, p) => a + n * p, 0) / total;
		return { v, counts, total, average };
	});
	const bars: Bar[] = levels.map((l) => ({
		key: l.v,
		label: valueStyle(judge, l.v).label,
		name: valueStyle(judge, l.v).label,
		total: l.total,
		segments: [5, 4, 3, 2, 1].map((p) => ({
			key: String(p),
			count: l.counts[p] ?? 0,
			style: precisionFill(p),
		})),
	}));
	const selected = levels.find((l) => l.v === open);
	return (
		<>
			<StackedBars
				bars={bars}
				unit={unit}
				axis="記事の段階"
				selected={open}
				onSelect={setOpen}
			/>
			{selected && (
				<p data-testid="accuracy-summary-detail" className="num text-xs">
					{valueStyle(judge, selected.v).label}
					{selected.average !== null &&
						`（平均 ${selected.average.toFixed(1)}）`}
					:{" "}
					{[5, 4, 3, 2, 1]
						.flatMap((p) => {
							const n = selected.counts[p] ?? 0;
							return n === 0
								? []
								: [`精度 ${p} ${n}件（${percent(n, selected.total)}）`];
						})
						.join(" · ")}
				</p>
			)}
			<ul
				aria-label="精度の色の意味"
				className="flex justify-between gap-1 text-[10px] text-text-2"
			>
				{[1, 2, 3, 4, 5].map((p) => (
					<li key={p} className="inline-flex items-center gap-1">
						<i
							className="inline-block size-2 rounded-[2px]"
							style={precisionFill(p)}
						/>
						精度 {p}
					</li>
				))}
			</ul>
		</>
	);
}

/** 評価×値動き: 行は記事の段階（上が かなり強気・危機）、列は値動きの段階（左が 大きく下落・静か） */
function Matrix<J extends Judge>({
	judge,
	result,
	unit,
}: {
	judge: J;
	result: AccuracySummaryResult<J>;
	unit: AnalysisUnit;
}) {
	const rows = [...LEVEL_ORDER[judge]].reverse().map((v) => {
		const moves = result.matrix.find((x) => x.value === v)?.moves ?? [
			0, 0, 0, 0, 0,
		];
		return {
			v,
			i: levelIndex(judge, v),
			moves,
			total: moves.reduce((a, b) => a + b, 0),
		};
	});
	const max = Math.max(1, ...rows.flatMap((r) => r.moves));
	return (
		<table className="w-full table-fixed border-separate border-spacing-0.5 text-center text-[10px]">
			<caption className="caption-bottom pt-1 text-[10px] text-text-2">
				行: 記事の段階 ／ 列: 値動き（枠は一致）
			</caption>
			<thead>
				<tr>
					<th className="w-[22%]" />
					{MOVE_LABELS[judge].map((parts) => (
						<th
							key={parts.join("")}
							scope="col"
							className="px-0.5 align-bottom font-normal leading-tight text-text-2"
						>
							{parts.map((x) => (
								<span key={x} className="inline-block">
									{x}
								</span>
							))}
						</th>
					))}
				</tr>
			</thead>
			<tbody>
				{rows.map((r) => (
					<tr key={r.v}>
						<th
							scope="row"
							className="pr-1 text-left font-normal leading-tight"
						>
							{valueStyle(judge, r.v).label}
						</th>
						{r.moves.map((n, m) => {
							const share =
								unit === "ratio" ? (r.total === 0 ? 0 : n / r.total) : n / max;
							const mix = n === 0 ? 0 : 12 + Math.round(share * 88);
							return (
								<td
									// biome-ignore lint/suspicious/noArrayIndexKey: 列は値動きの段階の番号で固定
									key={m}
									data-hit={m === r.i ? "" : undefined}
									className={`num h-8 rounded-md text-xs ${m === r.i ? "outline-2 -outline-offset-2 outline-text" : ""} ${n === 0 ? "text-text-2" : ""}`}
									style={{
										background:
											n === 0
												? undefined
												: `color-mix(in srgb, var(--color-heat) ${mix}%, var(--color-surface))`,
										boxShadow: "inset 0 0 0 1px var(--color-line)",
										color: mix > 55 ? "var(--color-heat-ink)" : undefined,
									}}
								>
									{unit === "ratio"
										? r.total === 0
											? "—"
											: percent(n, r.total)
										: `${n}件`}
								</td>
							);
						})}
					</tr>
				))}
			</tbody>
		</table>
	);
}
