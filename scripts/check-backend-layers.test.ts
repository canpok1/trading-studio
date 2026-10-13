import { expect, test } from "bun:test";
import { layerViolations } from "./check-backend-layers";

test("機能フォルダの中は -app・-domain・-infra で終わるファイルだけ通す", () => {
	expect(
		layerViolations([
			"trading/trading-app.ts",
			"trading/trading-domain.ts",
			"trading/trading-domain.test.ts",
			"trading/repository-infra.ts",
			"trading/service.ts",
			"trading/trading.test.ts",
			"trading/trading.domain.ts",
		]),
	).toEqual([
		"trading/service.ts",
		"trading/trading.test.ts",
		"trading/trading.domain.ts",
	]);
});

test("src/ 直下は起動まわりだけ通す", () => {
	expect(
		layerViolations(["main.ts", "app.ts", "index.ts", "version.ts"]),
	).toEqual(["version.ts"]);
});
