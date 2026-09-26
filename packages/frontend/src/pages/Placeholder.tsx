import { Page } from "../components/Page";
import { EmptyState } from "../components/States";

/** 中身を作る前の画面 */
export function Placeholder({ title }: { title: string }) {
	return (
		<Page title={title}>
			<EmptyState title="準備中" />
		</Page>
	);
}
