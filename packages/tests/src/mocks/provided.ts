import "vitest";
import type { ProvidedMocks } from "./index.js";

declare module "vitest" {
	interface ProvidedContext {
		mocks: ProvidedMocks;
	}
}
