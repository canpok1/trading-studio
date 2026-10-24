import type {
	AutoTradingStatus,
	StoredStrategy,
} from "@trading-studio/backend";
import type { ConditionSet } from "@trading-studio/core";
import {
	instrumentOf,
	marketOf,
	validateConditionSet,
} from "@trading-studio/core";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router";
import {
	BuyRulesEditor,
	FrequencyCard,
	RiskLimitCard,
} from "../../shared/components/ConditionEditor";
import { Modal } from "../../shared/components/Modal";
import { Page } from "../../shared/components/Page";
import { ErrorState, LoadingCard } from "../../shared/components/States";
import { Button, Card } from "../../shared/components/ui";
import { useApi } from "../../shared/lib/api";
import { formatInt } from "../../shared/lib/number";
import { useTradingStatus } from "../../shared/lib/trading";
import { errorMessage, readJson, useAsync } from "../../shared/lib/useAsync";

type Data = { strategy: StoredStrategy | null; latest: number | null };

const sameParams = (a: ConditionSet, b: ConditionSet) =>
	JSON.stringify(a) === JSON.stringify(b);

/** 戦略の条件の編集。自動取引がオフで、保有も未約定の注文も無いときだけ変えられる */
export function StrategyEditPage() {
	const api = useApi();
	const navigate = useNavigate();
	const { id: idParam } = useParams();
	const strategyId = Number(idParam);
	const [notice, setNotice] = useState<string | null>(null);
	const [asking, setAsking] = useState(false);
	const { runs, set: setRun } = useTradingStatus();
	const run = runs?.find((r) => r.id === strategyId) ?? null;

	const load = useCallback(async (): Promise<Data> => {
		const [list, latest] = await Promise.all([
			api.api.strategies
				.$get()
				.then((r) => readJson<{ strategies: StoredStrategy[] }>(r)),
			api.api.data.latest
				.$get()
				.then((r) => readJson<{ latest: { close: number } | null }>(r)),
		]);
		return {
			strategy: list.strategies.find((s) => s.id === strategyId) ?? null,
			latest: latest.latest?.close ?? null,
		};
	}, [api, strategyId]);
	const { state, reload } = useAsync(load);
	const current = state.kind === "ok" ? state.data.strategy : null;

	// 編集中の条件は下書きに持ち、「保存」で戦略へ反映する
	// 開いた戦略が変わったときだけ入れ直す。保存後の読み直しで、保存中に続けた編集を消さないため
	const [draft, setDraft] = useState<{
		id: number;
		params: ConditionSet;
	} | null>(null);
	useEffect(() => {
		if (current && draft?.id !== current.id) {
			setDraft({ id: current.id, params: current.params });
		}
	}, [current, draft?.id]);
	const [saving, setSaving] = useState(false);
	const params =
		current && draft?.id === current.id
			? draft.params
			: (current?.params ?? null);
	const errors = useMemo(
		() =>
			params && current
				? validateConditionSet(
						params,
						marketOf(instrumentOf(current.instruments[0] as string)),
					)
				: [],
		[params, current],
	);

	const back = {
		to: `/strategies/${strategyId}`,
		label: current?.name ?? "戦略",
	};
	// 自動取引の状態が読めるまでは、条件を変えられるかも成績の確認が要るかも分からない
	if (state.kind === "loading" || runs === null) {
		return (
			<Page title="戦略の編集" back={back}>
				<LoadingCard />
			</Page>
		);
	}
	if (state.kind === "error" || !current || !params) {
		return (
			<Page title="戦略の編集" back={{ to: "/strategies", label: "戦略" }}>
				<Card>
					<ErrorState
						what={
							state.kind === "error"
								? `戦略を読み込めなかった（${state.message}）`
								: "戦略が見つからない"
						}
						next={
							state.kind === "error"
								? "サーバーが動いているか確かめてから、もう一度読み込む"
								: "削除されたか、URL が違う"
						}
						action={
							state.kind === "error" ? (
								<Button onClick={reload}>もう一度読み込む</Button>
							) : undefined
						}
					/>
				</Card>
			</Page>
		);
	}

	const lock = run?.strategyLock ?? null;
	const dirty = !sameParams(params, current.params);
	const hasErr = errors.length > 0;
	const setParams = (p: ConditionSet) => {
		setNotice(null);
		setDraft({ id: current.id, params: p });
	};
	const save = async (resetAccount: boolean) => {
		setAsking(false);
		setSaving(true);
		try {
			await api.api.strategies[":id"].params
				.$put({ param: { id: String(current.id) }, json: { params } })
				.then((r) => readJson<{ strategy: StoredStrategy }>(r));
		} catch (e) {
			setNotice(`保存できなかった: ${errorMessage(e)}`);
			return;
		} finally {
			setSaving(false);
		}
		await reload();
		if (!resetAccount || !run) {
			setNotice("保存した");
			return;
		}
		try {
			const r = await api.api.trading.strategies[":id"].reset
				.$post({
					param: { id: String(run.id) },
					json: { initialCash: run.account.initialCash },
				})
				.then((res) => readJson<{ status: AutoTradingStatus }>(res));
			setRun(r.status);
			setNotice("保存し、成績をリセットした");
		} catch (e) {
			setNotice(`保存したが、成績をリセットできなかった: ${errorMessage(e)}`);
		}
	};
	const editor = {
		params,
		onChange: setParams,
		errors,
	};

	return (
		<Page title={`「${current.name}」の編集`} back={back}>
			{/* PC は左に操作・頻度・リスク上限、右に買い。スマホは 操作→頻度→買い→リスク上限→保存 の順 */}
			<div className="flex flex-col gap-3.5 lg:grid lg:grid-cols-2 lg:items-start">
				<div className="contents lg:flex lg:flex-col lg:gap-3.5">
					<Card className="flex flex-col gap-3">
						<div className="flex flex-wrap gap-2">
							<Button
								size="sm"
								onClick={() =>
									navigate(`/backtest?strategy=${current.id}`, {
										state: { params },
									})
								}
							>
								この条件でバックテスト
							</Button>
						</div>
						{lock && (
							<p role="status" className="text-[13px] font-semibold">
								{lock === "running"
									? "自動取引が稼働中のため、条件を変えられない。停止してから編集する"
									: "保有か未約定の注文があるため、条件を変えられない。売り切るか口座をリセットしてから編集する"}
							</p>
						)}
					</Card>
					<fieldset disabled={lock !== null} className="contents">
						<FrequencyCard {...editor} />
					</fieldset>
					<fieldset
						disabled={lock !== null}
						className="order-last flex min-w-0 flex-col gap-3.5 lg:order-none"
					>
						<RiskLimitCard {...editor} />
					</fieldset>
				</div>
				<fieldset
					disabled={lock !== null}
					className="contents min-w-0 lg:flex lg:flex-col lg:gap-3.5"
				>
					<BuyRulesEditor
						{...editor}
						latestPrice={state.data.latest}
						instrument={instrumentOf(current.instruments[0] as string)}
					/>
				</fieldset>
				<div className="order-last flex flex-col gap-2 lg:col-span-2">
					{notice && (
						<p role="status" className="text-[13px] font-semibold">
							{notice}
						</p>
					)}
					<div className={lock ? "hidden" : "flex gap-2"}>
						<Button
							variant="primary"
							className="flex-1"
							disabled={!dirty || hasErr || saving}
							// 成績は変更前の条件で取引したものなので、残すかを聞く
							onClick={() =>
								run?.ranSinceReset ? setAsking(true) : save(false)
							}
						>
							{hasErr ? "入力を直すと保存できる" : dirty ? "保存" : "変更なし"}
						</Button>
						{dirty && (
							<Button onClick={() => setParams(current.params)}>
								元に戻す
							</Button>
						)}
					</div>
				</div>
			</div>
			{asking && run && (
				<Modal title="成績をリセットするか" onClose={() => setAsking(false)}>
					<p className="leading-relaxed">
						今の成績は変更前の条件で取引したもの。リセットすると、口座を開始時の資金（
						{formatInt(run.account.initialCash)}
						円）に戻し、成績を今から数え直す。注文・約定の記録は残る。
					</p>
					<Button variant="primary" onClick={() => save(true)}>
						リセットして保存
					</Button>
					<Button onClick={() => save(false)}>成績を残して保存</Button>
					<Button onClick={() => setAsking(false)}>やめる</Button>
				</Modal>
			)}
		</Page>
	);
}
