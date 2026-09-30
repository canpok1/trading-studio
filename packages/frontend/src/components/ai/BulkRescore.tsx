import { useState } from "react";
import { useApi } from "../../api";
import type { NewsFilterState } from "../../lib/news-filter";
import { newsQuery } from "../../lib/news-filter";
import { errorMessage, readJson } from "../../lib/useAsync";
import { Modal } from "../Modal";
import { Button } from "../ui";

/** まとめて採点し直せる件数の上限（API の上限と同じ） */
const BULK_MAX = 1000;
/** 採点の問い合わせの最短の間隔（秒）。かかる時間の目安に使う */
const INTERVAL_SEC = 5;

/** 絞り込みの条件に当てはまるニュースを、使用中の版でまとめて採点し直す。運用の採点を置き換える */
export function BulkRescore({
	filter,
	total,
	activeVersion,
	onDone,
}: {
	filter: NewsFilterState;
	/** 条件に当てはまる件数 */
	total: number;
	activeVersion: number | null;
	onDone: () => void;
}) {
	const api = useApi();
	const [open, setOpen] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [result, setResult] = useState<string | null>(null);
	if (total === 0 || activeVersion === null) return null;
	const tooMany = total > BULK_MAX;

	const run = async () => {
		setBusy(true);
		setError(null);
		try {
			const r = await api.api.scoring.news.rescore
				.$post({ query: newsQuery(filter, Date.now(), BULK_MAX) })
				.then((res) =>
					readJson<{ version: number; requested: number; skipped: number }>(
						res,
					),
				);
			setResult(
				r.requested === 0
					? `採点し直すものは無かった（v${r.version} で採点済みか、採点済みでない）`
					: `${r.requested} 件を v${r.version} で採点し直す${r.skipped > 0 ? `（${r.skipped} 件は v${r.version} で採点済みか採点済みでないので飛ばした）` : ""}`,
			);
			setOpen(false);
			onDone();
		} catch (e) {
			setError(errorMessage(e));
		} finally {
			setBusy(false);
		}
	};

	return (
		<>
			<div className="flex flex-col items-end gap-1 text-right">
				<Button
					size="sm"
					disabled={tooMany}
					onClick={() => {
						setResult(null);
						setError(null);
						setOpen(true);
					}}
				>
					この {total} 件を採点し直す
				</Button>
				{tooMany && (
					<p className="text-xs text-text-2">
						採点し直せるのは {BULK_MAX} 件まで。期間や条件で絞る
					</p>
				)}
				{result && (
					<p role="status" className="text-xs text-text-2">
						{result}
					</p>
				)}
			</div>
			{open && (
				<Modal title="まとめて採点し直す" onClose={() => setOpen(false)}>
					<p className="text-sm leading-relaxed">
						条件に当てはまる {total} 件を、使用中のプロンプト v{activeVersion}{" "}
						で採点し直す。v{activeVersion}{" "}
						で採点済みのものと、採点済みでないものは飛ばす。
					</p>
					<ul className="list-disc pl-5 text-xs leading-relaxed text-text-2">
						<li>
							採点し直した点数で今の採点を置き換える。今の市場評価とペーパー取引にも反映する
						</li>
						<li>
							集計に使い始める時刻は元の採点時刻のまま。元の点数は元の版の採点として残り、バックテストで版を選ぶと使える
						</li>
						<li>
							新着の採点を先にし、1件ずつ {INTERVAL_SEC} 秒以上空けて進める（
							{total} 件で約 {Math.ceil((total * INTERVAL_SEC) / 60)} 分）
						</li>
					</ul>
					{error && (
						<p role="alert" className="text-xs font-semibold text-loss">
							採点し直せなかった: {error}
						</p>
					)}
					<div className="flex justify-end gap-2">
						<Button onClick={() => setOpen(false)}>やめる</Button>
						<Button variant="primary" onClick={run} disabled={busy}>
							採点し直す
						</Button>
					</div>
				</Modal>
			)}
		</>
	);
}
