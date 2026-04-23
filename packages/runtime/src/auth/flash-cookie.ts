import { SIXTY_SECONDS_MS } from "./constants.js";
import { createSealedCookie } from "./sealed-cookie.js";

type FlashPayload =
	| {
			readonly kind: "denied";
			readonly login: string;
			readonly provider: "github" | "local";
	  }
	| {
			readonly kind: "logged-out";
			readonly provider?: "github" | "local";
	  };

const flashCookie = createSealedCookie<FlashPayload>(SIXTY_SECONDS_MS);

const sealFlash = flashCookie.seal;
const unsealFlash = flashCookie.unseal;

export type { FlashPayload };
export { sealFlash, unsealFlash };
