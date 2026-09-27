import type {
	CurrentJudgment,
	NewsCollectorStatus,
} from "@trading-studio/backend";
import type { AggregationRule } from "@trading-studio/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { useApi } from "../api";
import { ApiKeySetting } from "../components/ApiKeySetting";
import { PromptTab } from "../components/ai/PromptTab";
import { RuleTab } from "../components/ai/RuleTab";
import { SourcesTab } from "../components/ai/SourcesTab";
import { AdviceSettings } from "../components/backtest/AdviceSettings";
import { Page } from "../components/Page";
import { RetentionSetting } from "../components/RetentionSetting";
import { ErrorState, LoadingCard } from "../components/States";
import { Button } from "../components/ui";
import {
	errorMessage,
	readJson,
	useInterval,
	usePageVisible,
} from "../lib/useAsync";
import type { ThemePreference } from "../theme";
import { useTheme } from "../theme";

/** 収集の状態（取得元ごとの最後の取得）を問い合わせる間隔 */
const POLL_MS = 5_000;

/** 区分はメニューに合わせる。複数のメニューで使う設定は「全般」に置く */
const SECTIONS = [
	["general", "全般"],
	["news", "ニュース"],
	["backtest", "バックテスト"],
] as const;
type SettingsSection = (typeof SECTIONS)[number][0];
const isSection = (v: string | null): v is SettingsSection =>
	SECTIONS.some(([s]) => s === v);

const NEWS_TABS = [
	["rule", "集計ルール"],
	["prompt", "プロンプト"],
	["sources", "収集と採点"],
] as const;
type NewsSettingsTab = (typeof NEWS_TABS)[number][0];
const isNewsTab = (v: string | null): v is NewsSettingsTab =>
	NEWS_TABS.some(([t]) => t === v);

export function SettingsPage() {
	const [params, setParams] = useSearchParams();
	const sectionParam = params.get("section");
	const section: SettingsSection = isSection(sectionParam)
		? sectionParam
		: "general";
	const tabParam = params.get("tab");
	const newsTab: NewsSettingsTab = isNewsTab(tabParam) ? tabParam : "rule";
	return (
		<Page title="設定">
			<Tabs
				label="設定の区分"
				items={SECTIONS}
				current={section}
				onSelect={(s) =>
					setParams(s === "general" ? {} : { section: s }, { replace: true })
				}
			/>
			{section === "general" && (
				<div role="tabpanel" className="flex flex-col gap-3">
					<ThemeSetting />
					<ApiKeySetting />
					<RetentionSetting />
				</div>
			)}
			{section === "backtest" && (
				<div role="tabpanel" className="flex flex-col gap-3">
					<AdviceSettings />
				</div>
			)}
			{section === "news" && (
				<div role="tabpanel" className="flex flex-col gap-3">
					<Tabs
						label="ニュースの設定の種類"
						items={NEWS_TABS}
						current={newsTab}
						onSelect={(t) =>
							setParams(
								t === "rule"
									? { section: "news" }
									: { section: "news", tab: t },
								{ replace: true },
							)
						}
						small
					/>
					<NewsSettings tab={newsTab} />
				</div>
			)}
		</Page>
	);
}

function Tabs<T extends string>({
	label,
	items,
	current,
	onSelect,
	small = false,
}: {
	label: string;
	items: readonly (readonly [T, string])[];
	current: T;
	onSelect: (value: T) => void;
	small?: boolean;
}) {
	return (
		<div
			role="tablist"
			aria-label={label}
			className={`grid auto-cols-fr grid-flow-col gap-0.5 rounded-[10px] p-[3px] ${small ? "border border-line" : "bg-surface-2"}`}
		>
			{items.map(([value, text]) => (
				<button
					key={value}
					type="button"
					role="tab"
					aria-selected={current === value}
					onClick={() => onSelect(value)}
					className={`rounded-lg px-0.5 text-xs whitespace-nowrap sm:text-[13px] ${small ? "h-8" : "h-9"} ${current === value ? (small ? "bg-surface-2 font-bold text-text" : "bg-surface font-bold text-text shadow-sm") : "text-text-2"}`}
				>
					{text}
				</button>
			))}
		</div>
	);
}

const OPTIONS: [ThemePreference, string][] = [
	["system", "OS に合わせる"],
	["light", "ライト"],
	["dark", "ダーク"],
];

function ThemeSetting() {
	const { preference, setPreference } = useTheme();
	return (
		<section className="flex flex-col gap-2.5 rounded-xl border border-line bg-surface px-4 py-3.5">
			<h2 className="text-[15px] font-bold">画面の色</h2>
			<fieldset className="grid auto-cols-fr grid-flow-col gap-0.5 rounded-[10px] bg-surface-2 p-[3px]">
				<legend className="sr-only">画面の色</legend>
				{OPTIONS.map(([value, label]) => (
					<label
						key={value}
						className="flex h-9 cursor-pointer items-center justify-center rounded-lg text-[13px] text-text-2 has-checked:bg-surface has-checked:font-bold has-checked:text-text has-checked:shadow-sm has-focus-visible:outline-2 has-focus-visible:outline-accent"
					>
						<input
							type="radio"
							name="theme"
							value={value}
							checked={preference === value}
							onChange={() => setPreference(value)}
							className="sr-only"
						/>
						{label}
					</label>
				))}
			</fieldset>
			<p className="text-xs text-text-2">選んだ設定はこのブラウザに保存する</p>
		</section>
	);
}

type NewsSettingsData = {
	rule: AggregationRule;
	collector: NewsCollectorStatus;
};

/** ニュースの設定。集計ルールと収集の状態を読み、収集の状態は定期的に読み直す */
function NewsSettings({ tab }: { tab: NewsSettingsTab }) {
	const api = useApi();
	const visible = usePageVisible();
	const [data, setData] = useState<NewsSettingsData | null>(null);
	const [error, setError] = useState<string | null>(null);
	// 操作の直後と定期の問い合わせが重なると応答の順が入れ替わりうるので、最後に出したものだけ使う
	const seq = useRef(0);
	const load = useCallback(async () => {
		const id = ++seq.current;
		try {
			const [current, collector] = await Promise.all([
				api.api.judgments.current
					.$get()
					.then((r) => readJson<CurrentJudgment>(r)),
				api.api.news.status
					.$get()
					.then((r) => readJson<NewsCollectorStatus>(r)),
			]);
			if (id !== seq.current) return;
			setData({ rule: current.rule, collector });
			setError(null);
		} catch (e) {
			if (id === seq.current) setError(errorMessage(e));
		}
	}, [api]);
	useEffect(() => {
		if (visible) load();
	}, [visible, load]);
	useInterval(load, POLL_MS, visible);

	if (!data) {
		return error ? (
			<ErrorState
				what="設定を読み込めなかった"
				next={error}
				action={<Button onClick={load}>もう一度読み込む</Button>}
			/>
		) : (
			<LoadingCard lines={6} />
		);
	}
	return (
		<>
			{error && (
				<p role="alert" className="text-xs font-semibold text-loss">
					最新の状態を読み込めなかった（{error}）。5秒ごとに読み直している
				</p>
			)}
			{tab === "rule" && <RuleTab saved={data.rule} onSaved={load} />}
			{tab === "prompt" && <PromptTab rule={data.rule} onChanged={load} />}
			{tab === "sources" && (
				<SourcesTab collector={data.collector} onChanged={load} />
			)}
		</>
	);
}
