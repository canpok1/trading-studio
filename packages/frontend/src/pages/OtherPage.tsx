import { Link } from "react-router";
import { Page } from "../components/Page";

export function OtherPage() {
	return (
		<Page title="その他">
			<div className="overflow-hidden rounded-xl border border-line bg-surface">
				<Link
					to="/ai"
					className="flex w-full items-center gap-3 border-b border-line px-4 py-3.5 text-[15px] hover:bg-surface-2"
				>
					<span className="flex-1">
						AI判定
						<span className="block text-xs text-text-2">
							ニュースから判定した相場の状態と、その根拠
						</span>
					</span>
					›
				</Link>
				<Link
					to="/data"
					className="flex w-full items-center gap-3 border-b border-line px-4 py-3.5 text-[15px] hover:bg-surface-2"
				>
					<span className="flex-1">
						過去データの取り込み
						<span className="block text-xs text-text-2">
							CSV の取り込みと取り込み済みの期間
						</span>
					</span>
					›
				</Link>
				<Link
					to="/settings"
					className="flex w-full items-center gap-3 px-4 py-3.5 text-[15px] hover:bg-surface-2"
				>
					<span className="flex-1">
						設定
						<span className="block text-xs text-text-2">
							画面の色、AI判定の集計ルール・プロンプト・収集と採点
						</span>
					</span>
					›
				</Link>
			</div>
		</Page>
	);
}
