import type { Middleware } from "../triggers/http.js";

const CSP_DIRECTIVES: ReadonlyArray<readonly [string, string]> = [
	["default-src", "'none'"],
	["script-src", "'self'"],
	["style-src", "'self'"],
	["img-src", "'self' data:"],
	["connect-src", "'self'"],
	["form-action", "'self'"],
	["frame-ancestors", "'none'"],
	["base-uri", "'none'"],
];

// Local-dev override: allow embedding in the VS Code Simple Browser webview,
// which loads pages inside an iframe. Production keeps `frame-ancestors 'none'`
// and `X-Frame-Options: DENY` (clickjacking defence, SECURITY.md §6).
const LOCAL_CSP_DIRECTIVES: ReadonlyArray<readonly [string, string]> =
	CSP_DIRECTIVES.map(([name, value]) =>
		name === "frame-ancestors"
			? ([name, "'self' vscode-webview:"] as const)
			: ([name, value] as const),
	);

const PERMISSIONS_DISABLED_FEATURES: readonly string[] = [
	"accelerometer",
	"ambient-light-sensor",
	"autoplay",
	"battery",
	"camera",
	"display-capture",
	"document-domain",
	"encrypted-media",
	"fullscreen",
	"geolocation",
	"gyroscope",
	"hid",
	"idle-detection",
	"magnetometer",
	"microphone",
	"midi",
	"payment",
	"picture-in-picture",
	"publickey-credentials-get",
	"screen-wake-lock",
	"serial",
	"usb",
	"web-share",
	"xr-spatial-tracking",
	"clipboard-read",
];

const HSTS_VALUE = "max-age=31536000; includeSubDomains";
const LOCAL_DEPLOYMENT_FLAG = "1";

function buildCsp(isLocal = false): string {
	const directives = isLocal ? LOCAL_CSP_DIRECTIVES : CSP_DIRECTIVES;
	return directives.map(([name, value]) => `${name} ${value}`).join("; ");
}

function buildPermissionsPolicy(): string {
	const disabled = PERMISSIONS_DISABLED_FEATURES.map((f) => `${f}=()`);
	return [...disabled, "clipboard-write=(self)"].join(", ");
}

interface SecureHeadersOptions {
	localDeployment?: string | undefined;
}

function secureHeadersMiddleware(
	options: SecureHeadersOptions = {},
): Middleware {
	const isLocal = options.localDeployment === LOCAL_DEPLOYMENT_FLAG;
	const csp = buildCsp(isLocal);
	const permissionsPolicy = buildPermissionsPolicy();

	return {
		match: "*",
		handler: async (c, next) => {
			c.header("Content-Security-Policy", csp);
			c.header("X-Content-Type-Options", "nosniff");
			if (!isLocal) {
				c.header("X-Frame-Options", "DENY");
			}
			c.header("Referrer-Policy", "strict-origin-when-cross-origin");
			c.header("Cross-Origin-Opener-Policy", "same-origin");
			c.header("Cross-Origin-Resource-Policy", "same-origin");
			c.header("Permissions-Policy", permissionsPolicy);
			if (!isLocal) {
				c.header("Strict-Transport-Security", HSTS_VALUE);
			}
			await next();
		},
	};
}

export { buildCsp, buildPermissionsPolicy, secureHeadersMiddleware };
