// 画面の描画中の例外で、画面全体が背景だけにならないようにする。
// ブラウザに保存した下書きや設定が原因だと開き直しても同じく落ちるので、消して開き直せるようにする

import type { ErrorInfo, ReactNode } from "react";
import { Component } from "react";
import { ErrorState } from "./States";
import { Button, Card } from "./ui";

type Props = {
	children: ReactNode;
	/** 変わったら落ちた状態を捨てて描き直す（画面を移ったとき） */
	resetKey: string;
};
type State = { error: Error | null };

export class PageErrorBoundary extends Component<Props, State> {
	override state: State = { error: null };

	static getDerivedStateFromError(error: unknown): State {
		return {
			error: error instanceof Error ? error : new Error(String(error)),
		};
	}

	override componentDidCatch(error: unknown, info: ErrorInfo) {
		console.error("画面の描画に失敗", error, info.componentStack);
	}

	override componentDidUpdate(prev: Props) {
		if (prev.resetKey !== this.props.resetKey && this.state.error) {
			this.setState({ error: null });
		}
	}

	override render() {
		const { error } = this.state;
		if (!error) return this.props.children;
		return (
			<div className="mx-auto max-w-[720px] px-4 py-5">
				<Card>
					<ErrorState
						what="この画面を表示できなかった"
						next={
							<>
								開き直しても直らなければ、この端末に保存した入力途中の内容と表示の設定を消して開き直す。
								<br />
								<code className="break-all text-[12px]">{error.message}</code>
							</>
						}
						action={
							<div className="flex flex-wrap justify-center gap-2">
								<Button
									variant="primary"
									onClick={() => window.location.reload()}
								>
									開き直す
								</Button>
								<Button
									onClick={() => {
										try {
											localStorage.clear();
										} catch {
											// 消せない環境でも開き直しはする
										}
										window.location.reload();
									}}
								>
									保存した内容を消して開き直す
								</Button>
							</div>
						}
					/>
				</Card>
			</div>
		);
	}
}
