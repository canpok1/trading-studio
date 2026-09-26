import type { StoredStrategy } from "@trading-studio/backend";
import type { ConditionSet, TemplateId } from "@trading-studio/core";
import {
	strategyTemplate,
	TEMPLATE_IDS,
	validateConditionSet,
} from "@trading-studio/core";
import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { Navigate, useNavigate, useParams } from "react-router";
import { useApi } from "../api";
import { Modal } from "../components/Modal";
import { Page } from "../components/Page";
import { EmptyState, ErrorState, LoadingCard } from "../components/States";
import {
	ConditionGroups,
	FrequencyCard,
	OrderSizeCard,
} from "../components/strategy/ConditionEditor";
import { Button, Card } from "../components/ui";
import { errorMessage, readJson, useAsync } from "../lib/useAsync";

type Data = { strategies: StoredStrategy[]; latest: number | null };

type Dialog = "create" | "rename" | "delete" | null;

const sameParams = (a: ConditionSet, b: ConditionSet) =>
	JSON.stringify(a) === JSON.stringify(b);

export function StrategiesPage() {
	const api = useApi();
	const navigate = useNavigate();
	const { id: idParam } = useParams();
	const [dialog, setDialog] = useState<Dialog>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const selectId = useId();

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
			strategies: list.strategies,
			latest: latest.latest?.close ?? null,
		};
	}, [api]);
	const { state, reload } = useAsync(load);

	const strategies = state.kind === "ok" ? state.data.strategies : [];
	const current = strategies.find((s) => String(s.id) === idParam) ?? null;

	// 編集中の条件は下書きに持ち、「保存」で戦略へ反映する
	const [draft, setDraft] = useState<{
		id: number;
		params: ConditionSet;
	} | null>(null);
	useEffect(() => {
		if (current && draft?.id !== current.id) {
			setDraft({ id: current.id, params: current.params });
		}
	}, [current, draft?.id]);
	const params =
		current && draft?.id === current.id ? draft.params : current?.params;
	const errors = useMemo(
		() => (params ? validateConditionSet(params) : []),
		[params],
	);

	const open = (id: number) => {
		setNotice(null);
		navigate(`/strategies/${id}`);
	};

	if (state.kind === "loading") {
		return (
			<Page title="戦略">
				<LoadingCard />
			</Page>
		);
	}
	if (state.kind === "error") {
		return (
			<Page title="戦略">
				<Card>
					<ErrorState
						what={`戦略を読み込めなかった（${state.message}）`}
						next="サーバーが動いているか確かめてから、もう一度読み込む"
						action={<Button onClick={reload}>もう一度読み込む</Button>}
					/>
				</Card>
			</Page>
		);
	}

	const first = strategies[0];
	if (!current && first) {
		return <Navigate to={`/strategies/${first.id}`} replace />;
	}

	const createDialog = dialog === "create" && (
		<CreateDialog
			copyFrom={current}
			onClose={() => setDialog(null)}
			onCreated={async (s) => {
				setDialog(null);
				await reload();
				open(s.id);
				setNotice(`「${s.name}」を作った`);
			}}
		/>
	);

	if (!current || !params) {
		return (
			<Page title="戦略">
				<Card>
					<EmptyState
						title="戦略がまだない"
						description="ひな形から作って、条件を調整する。"
						action={
							<Button variant="primary" onClick={() => setDialog("create")}>
								＋ 新しい戦略
							</Button>
						}
					/>
				</Card>
				{createDialog}
			</Page>
		);
	}

	const dirty = !sameParams(params, current.params);
	const hasErr = errors.length > 0;
	const setParams = (p: ConditionSet) => {
		setNotice(null);
		setDraft({ id: current.id, params: p });
	};
	const save = async () => {
		try {
			const saved = await api.api.strategies[":id"].params
				.$put({ param: { id: String(current.id) }, json: { params } })
				.then((r) => readJson<{ strategy: StoredStrategy }>(r));
			// 保存した値を下書きにも入れ、差分が無い状態にする
			setDraft({ id: saved.strategy.id, params: saved.strategy.params });
			await reload();
			setNotice("保存した");
		} catch (e) {
			setNotice(`保存できなかった: ${errorMessage(e)}`);
		}
	};
	const editor = {
		params,
		onChange: setParams,
		errors,
	};

	return (
		<Page title="戦略">
			{/* PC は左に戦略・頻度・注文量、右に注文条件。スマホは 戦略→頻度→条件→注文量→保存 の順 */}
			<div className="flex flex-col gap-3.5 lg:grid lg:grid-cols-2 lg:items-start">
				<div className="contents lg:flex lg:flex-col lg:gap-3.5">
					<Card className="flex flex-col gap-3">
						<div className="flex flex-col gap-1.5">
							<label htmlFor={selectId} className="text-[13px] font-semibold">
								戦略
							</label>
							<div className="flex gap-2">
								<select
									id={selectId}
									value={current.id}
									onChange={(e) => open(Number(e.target.value))}
									className="h-12 min-w-0 flex-1 rounded-[10px] border border-line bg-surface px-3 text-[15px] font-semibold"
								>
									{strategies.map((s) => (
										<option key={s.id} value={s.id}>
											{s.name}
										</option>
									))}
								</select>
								<Button onClick={() => setDialog("create")}>
									＋ 新しい戦略
								</Button>
							</div>
						</div>
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
							<Button size="sm" onClick={() => setDialog("rename")}>
								この戦略をリネーム
							</Button>
							<Button
								size="sm"
								className="text-loss"
								onClick={() => setDialog("delete")}
							>
								この戦略を削除
							</Button>
						</div>
					</Card>
					<FrequencyCard {...editor} />
					<div className="order-last lg:order-none">
						<OrderSizeCard {...editor} latestPrice={state.data.latest} />
					</div>
				</div>
				<div className="contents lg:flex lg:flex-col lg:gap-3.5">
					<ConditionGroups {...editor} />
				</div>
				<div className="order-last flex flex-col gap-2 lg:col-span-2">
					{notice && (
						<p role="status" className="text-[13px] font-semibold">
							{notice}
						</p>
					)}
					<div className="flex gap-2">
						<Button
							variant="primary"
							className="flex-1"
							disabled={!dirty || hasErr}
							onClick={save}
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
			{createDialog}
			{dialog === "rename" && (
				<RenameDialog
					strategy={current}
					onClose={() => setDialog(null)}
					onDone={async () => {
						setDialog(null);
						await reload();
						setNotice("名前を変えた");
					}}
				/>
			)}
			{dialog === "delete" && (
				<DeleteDialog
					strategy={current}
					onClose={() => setDialog(null)}
					onDone={async () => {
						setDialog(null);
						await reload();
						navigate("/strategies", { replace: true });
						setNotice("削除した");
					}}
				/>
			)}
		</Page>
	);
}

function NameField({
	value,
	onChange,
	error,
	label,
}: {
	value: string;
	onChange: (v: string) => void;
	error: string | null;
	label: string;
}) {
	const id = useId();
	return (
		<div className="flex flex-col gap-1.5">
			<label htmlFor={id} className="text-[13px] font-semibold">
				{label}
			</label>
			<input
				id={id}
				value={value}
				onChange={(e) => onChange(e.target.value)}
				aria-invalid={error ? true : undefined}
				className="h-12 rounded-[10px] border border-line bg-surface px-3 text-[15px] aria-invalid:border-2 aria-invalid:border-loss"
			/>
			{error && (
				<span className="text-xs font-semibold text-loss">{error}</span>
			)}
		</div>
	);
}

function CreateDialog({
	copyFrom,
	onClose,
	onCreated,
}: {
	copyFrom: StoredStrategy | null;
	onClose: () => void;
	onCreated: (s: StoredStrategy) => void;
}) {
	const api = useApi();
	const [name, setName] = useState("新しい戦略");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const create = async (
		from: { template: TemplateId } | { copyOf: number },
	) => {
		setBusy(true);
		try {
			const r = await api.api.strategies
				.$post({ json: { name, from } })
				.then((res) => readJson<{ strategy: StoredStrategy }>(res));
			onCreated(r.strategy);
		} catch (e) {
			setError(errorMessage(e));
			setBusy(false);
		}
	};
	const options: [string, string, () => void][] = [
		...TEMPLATE_IDS.map((t): [string, string, () => void] => {
			const tpl = strategyTemplate(t);
			return [
				t === "blank" ? tpl.name : `${tpl.name}（ひな形）`,
				tpl.description,
				() => create({ template: t }),
			];
		}),
	];
	if (copyFrom) {
		options.push([
			`「${copyFrom.name}」を複製`,
			"保存済みの条件をそのまま写す。",
			() => create({ copyOf: copyFrom.id }),
		]);
	}
	return (
		<Modal title="新しい戦略" onClose={onClose}>
			<NameField
				label="名前"
				value={name}
				onChange={(v) => {
					setName(v);
					setError(null);
				}}
				error={error}
			/>
			<span className="text-xs text-text-2">何から作るか</span>
			<div className="overflow-hidden rounded-xl border border-line">
				{options.map(([label, desc, run]) => (
					<button
						key={label}
						type="button"
						disabled={busy}
						onClick={run}
						className="flex w-full flex-col gap-0.5 border-b border-line px-4 py-3 text-left last:border-b-0 hover:bg-surface-2 disabled:opacity-45"
					>
						<strong className="text-sm">{label}</strong>
						<span className="text-xs text-text-2">{desc}</span>
					</button>
				))}
			</div>
			<Button onClick={onClose}>やめる</Button>
		</Modal>
	);
}

function RenameDialog({
	strategy,
	onClose,
	onDone,
}: {
	strategy: StoredStrategy;
	onClose: () => void;
	onDone: () => void;
}) {
	const api = useApi();
	const [name, setName] = useState(strategy.name);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const run = async () => {
		setBusy(true);
		try {
			await api.api.strategies[":id"].name
				.$put({ param: { id: String(strategy.id) }, json: { name } })
				.then((r) => readJson(r));
			onDone();
		} catch (e) {
			setError(errorMessage(e));
			setBusy(false);
		}
	};
	return (
		<Modal title="戦略の名前を変える" onClose={onClose}>
			<NameField
				label="新しい名前"
				value={name}
				onChange={(v) => {
					setName(v);
					setError(null);
				}}
				error={error}
			/>
			<Button variant="primary" disabled={busy} onClick={run}>
				名前を変える
			</Button>
			<Button onClick={onClose}>やめる</Button>
		</Modal>
	);
}

function DeleteDialog({
	strategy,
	onClose,
	onDone,
}: {
	strategy: StoredStrategy;
	onClose: () => void;
	onDone: () => void;
}) {
	const api = useApi();
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const run = async () => {
		setBusy(true);
		try {
			await api.api.strategies[":id"]
				.$delete({ param: { id: String(strategy.id) } })
				.then((r) => readJson(r));
			onDone();
		} catch (e) {
			setError(errorMessage(e));
			setBusy(false);
		}
	};
	return (
		<Modal title={`「${strategy.name}」を削除する`} onClose={onClose}>
			<p className="text-[13px]">
				条件は元に戻せない。過去のバックテスト結果は残る。
			</p>
			{error && (
				<span className="text-xs font-semibold text-loss">{error}</span>
			)}
			<Button variant="danger" disabled={busy} onClick={run}>
				削除する
			</Button>
			<Button onClick={onClose}>やめる</Button>
		</Modal>
	);
}
