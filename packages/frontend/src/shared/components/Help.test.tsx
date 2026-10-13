import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { Help } from "./Help";

// test-setup は最初に読み込んだテストファイルでしか DOM を用意しないため、このファイルの間だけ自分で用意する
beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());
afterEach(cleanup);

const renderHelp = () =>
	render(
		<div>
			<p>外側</p>
			<Help label="リスク上限">
				<p>含み損は数えない。</p>
			</Help>
		</div>,
	);

test("「？」を押すと説明が出て、もう一度押すと閉じる", () => {
	const v = renderHelp();
	const button = v.getByRole("button", { name: "リスク上限の説明" });
	expect(v.queryByText("含み損は数えない。")).toBeNull();
	fireEvent.click(button);
	expect(v.getByText("含み損は数えない。")).toBeTruthy();
	expect(button.getAttribute("aria-expanded")).toBe("true");
	fireEvent.click(button);
	expect(v.queryByText("含み損は数えない。")).toBeNull();
});

test("外側を押す・Esc で閉じ、吹き出しの中を押しても閉じない", () => {
	const v = renderHelp();
	const button = v.getByRole("button", { name: "リスク上限の説明" });
	fireEvent.click(button);
	fireEvent.pointerDown(v.getByText("含み損は数えない。"));
	expect(v.getByText("含み損は数えない。")).toBeTruthy();
	fireEvent.pointerDown(v.getByText("外側"));
	expect(v.queryByText("含み損は数えない。")).toBeNull();
	fireEvent.click(button);
	fireEvent.keyDown(window, { key: "Escape" });
	expect(v.queryByText("含み損は数えない。")).toBeNull();
});
