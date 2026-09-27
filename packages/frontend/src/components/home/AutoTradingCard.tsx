// ホームの自動取引のカード。オンオフ・運用する戦略・モード。止まっている理由があるときだけ添える

import type {
	AutoTradingStatus,
	StoredStrategy,
} from "@trading-studio/backend";
import { TIMEFRAME_LABELS, validateConditionSet } from "@trading-studio/core";
import { useState } from "react";
import { useApi } from "../../api";
import { formatClock } from "../../format";
import { useTradingStatus } from "../../lib/trading";
import { errorMessage, readJson } from "../../lib/useAsync";
import { Modal } from "../Modal";
import { Button, Segmented } from "../ui";
import { PANEL } from "./Panel";

const MODE_OPTIONS = [
	["paper", "ペーパー"],
	["live", "ライブ"],
] as const;

export function AutoTradingCard({
	strategies,
	active,
	saving,
	onChoose,
	onToast,
}: {
	strategies: StoredStrategy[];
	active: StoredStrategy | null;
	saving: boolean;
	onChoose: (id: number | null) => void;
	onToast: (message: string) => void;
}) {
	const api = useApi();
	const { status, set } = useTradingStatus();
	const [confirm, setConfirm] = useState(false);
	const [busy, setBusy] = useState(false);
	const on = status?.enabled ?? false;
	const now = Date.now();

	const send = async (
		call: () => Promise<{ status: AutoTradingStatus }>,
		done: (s: AutoTradingStatus) => string,
	) => {
		setBusy(true);
		try {
			const r = await call();
			set(r.status);
			onToast(done(r.status));
		} catch (e) {
			onToast(errorMessage(e));
		} finally {
			setBusy(false);
		}
	};

	const toggle = () => {
		if (!status) return;
		if (on) {
			// 停止は確認なしで即時
			send(
				() =>
					api.api.trading.stop
						.$post()
						.then((res) => readJson<{ status: AutoTradingStatus }>(res)),
				() => "自動取引を停止した。今から新しい注文は出ない",
			);
			return;
		}
		if (!active) {
			onToast("運用する戦略を選ぶと開始できる");
			return;
		}
		setConfirm(true);
	};

	const start = () => {
		setConfirm(false);
		send(
			() =>
				api.api.trading.start
					.$post({ json: { mode: "paper" } })
					.then((res) => readJson<{ status: AutoTradingStatus }>(res)),
			(s) =>
				`ペーパーで開始した。次の判定 ${s.nextEvalAt === null ? "—" : formatClock(s.nextEvalAt, Date.now())} から模擬売買する`,
		);
	};

	const choose = (id: number | null) => {
		const s = strategies.find((x) => x.id === id);
		// 条件が足りない戦略は動かせないので、運用する戦略に選ばせない
		if (s && validateConditionSet(s.params).length > 0) {
			onToast("この戦略は条件が足りないため選べない。「戦略」の画面で直す");
			return;
		}
		onChoose(id);
	};

	const loss = status?.dailyLoss;
	return (
		<section aria-label="自動取引設定" className={`${PANEL} flex-1`}>
			<div className="flex items-center justify-between gap-2">
				<div className="flex flex-col">
					<h2 className="text-[15px] font-bold">自動取引</h2>
					<span data-testid="auto-state" className="text-xs text-text-2">
						{on ? "稼働中" : "停止中"}
					</span>
				</div>
				<button
					type="button"
					role="switch"
					aria-checked={on}
					aria-label="自動取引"
					disabled={!status || busy}
					onClick={toggle}
					className="flex h-8 w-14 shrink-0 items-center rounded-full bg-surface-2 p-[3px] transition-colors disabled:opacity-45 aria-checked:bg-accent"
				>
					<span
						className={`h-[26px] w-[26px] rounded-full bg-white shadow transition-transform ${on ? "translate-x-6" : ""}`}
					/>
				</button>
			</div>
			<select
				aria-label="運用する戦略"
				className="h-11 w-full rounded-lg border border-line bg-surface px-3 text-[15px] font-semibold disabled:opacity-60"
				value={active?.id ?? ""}
				disabled={saving || on}
				onChange={(e) =>
					choose(e.target.value === "" ? null : Number(e.target.value))
				}
			>
				<option value="">未選択</option>
				{strategies.map((s) => (
					<option key={s.id} value={s.id}>
						{s.name}（{TIMEFRAME_LABELS[s.params.timeframe]}）
					</option>
				))}
			</select>
			{strategies.length === 0 && (
				<p className="text-xs text-text-2">
					戦略がまだ無い。「戦略」の画面で作ると選べる
				</p>
			)}
			<Segmented
				name="auto-mode"
				label="モード"
				options={MODE_OPTIONS}
				value={status?.mode ?? "paper"}
				onChange={() => {}}
				disabled={on}
				disabledValues={["live"]}
			/>
			{status?.waitingForMarket && (
				<p className="text-xs font-semibold">
					価格の収集が止まっているため、判定を待っている
				</p>
			)}
			{loss?.blocked && (
				<p className="text-xs font-semibold text-loss">
					1日の損失上限に達したため、翌 0 時まで新しい買いを止めている
				</p>
			)}
			{confirm && active && status && (
				<Modal
					title="ペーパーで自動取引を開始する"
					onClose={() => setConfirm(false)}
				>
					<p className="leading-relaxed">
						{active.name} が、次の判定（
						{status.nextEvalAt === null
							? "—"
							: formatClock(status.nextEvalAt, now)}
						）から最新の実データで模擬売買を始める。実資金は動かない。
					</p>
					<Button variant="primary" onClick={start}>
						開始する
					</Button>
					<Button onClick={() => setConfirm(false)}>やめる</Button>
				</Modal>
			)}
		</section>
	);
}
