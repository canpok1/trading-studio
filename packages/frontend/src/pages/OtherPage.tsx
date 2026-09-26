import { Link } from "react-router";
import { Page } from "../components/Page";

export function OtherPage() {
	return (
		<Page title="その他">
			<div className="overflow-hidden rounded-xl border border-line bg-surface">
				<Link
					to="/settings"
					className="flex w-full items-center gap-3 px-4 py-3.5 text-[15px] hover:bg-surface-2"
				>
					<span className="flex-1">
						表示設定
						<span className="block text-xs text-text-2">ライト / ダーク</span>
					</span>
					›
				</Link>
			</div>
		</Page>
	);
}
