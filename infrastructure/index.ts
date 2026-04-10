import { resolve } from "node:path";
import {
	BuilderVersion,
	Container,
	Image,
	Network,
	Volume,
} from "@pulumi/docker";
import { Config, interpolate } from "@pulumi/pulumi";
import { RandomPassword } from "@pulumi/random";

const config = new Config();
const domain = config.require("domain");
const httpsPort = config.requireNumber("httpsPort");
const oauth2ClientId = config.requireSecret("oauth2ClientId");
const oauth2ClientSecret = config.requireSecret("oauth2ClientSecret");
const oauth2GithubUser = config.require("oauth2GithubUser");

// oauth2-proxy requires a 16, 24, or 32 byte cookie secret for AES
const oauth2CookieSecret = new RandomPassword("oauth2-cookie-secret", {
	length: 32,
});

const infraDir = import.meta.dirname;
const repoRoot = resolve(infraDir, "..");

// Network for inter-container DNS resolution
const network = new Network("network", { name: "workflow-engine" });

// Image build
const appImage = new Image("app", {
	imageName: "workflow-engine:dev",
	build: {
		context: repoRoot,
		dockerfile: resolve(infraDir, "Dockerfile"),
		builderVersion: BuilderVersion.BuilderV1,
	},
	skipPush: true,
});

// Volumes
const caddyData = new Volume("caddy-data", { name: "caddy-data" });
const persistence = new Volume("persistence", { name: "persistence" });

const logDriver = "json-file";
const logOpts = { "max-size": "10m", "max-file": "3" };
const restart = "unless-stopped";

// App container
new Container("app", {
	name: "app",
	image: appImage.imageName,
	envs: ["PERSISTENCE_PATH=/events"],
	volumes: [{ volumeName: persistence.name, containerPath: "/events" }],
	networksAdvanced: [{ name: network.name, aliases: ["app"] }],
	restart,
	logDriver,
	logOpts,
});

// Caddy reverse proxy
new Container("proxy", {
	name: "proxy",
	image: "caddy:2.11.2",
	command: ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--watch"],
	envs: [`DOMAIN=${domain}`, "XDG_DATA_HOME=/caddy"],
	ports: [{ internal: 443, external: httpsPort }],
	volumes: [
		{
			hostPath: resolve(infraDir, "Caddyfile"),
			containerPath: "/etc/caddy/Caddyfile",
			readOnly: true,
		},
		{ volumeName: caddyData.name, containerPath: "/caddy" },
	],
	networksAdvanced: [{ name: network.name, aliases: ["proxy"] }],
	restart,
	logDriver,
	logOpts,
});

// OAuth2 proxy
const redirectUrl = `https://${domain}:${httpsPort}/oauth2/callback`;

new Container("oauth2-proxy", {
	name: "oauth2-proxy",
	image: "quay.io/oauth2-proxy/oauth2-proxy:v7.15.1",
	envs: [
		interpolate`OAUTH2_PROXY_CLIENT_ID=${oauth2ClientId}`,
		interpolate`OAUTH2_PROXY_CLIENT_SECRET=${oauth2ClientSecret}`,
		interpolate`OAUTH2_PROXY_COOKIE_SECRET=${oauth2CookieSecret.result}`,
		`OAUTH2_PROXY_GITHUB_USER=${oauth2GithubUser}`,
		"OAUTH2_PROXY_PROVIDER=github",
		`OAUTH2_PROXY_REDIRECT_URL=${redirectUrl}`,
		"OAUTH2_PROXY_HTTP_ADDRESS=0.0.0.0:4180",
		"OAUTH2_PROXY_REVERSE_PROXY=true",
		"OAUTH2_PROXY_EMAIL_DOMAINS=*",
		"OAUTH2_PROXY_COOKIE_SECURE=true",
		"OAUTH2_PROXY_SET_XAUTHREQUEST=true",
		"OAUTH2_PROXY_UPSTREAMS=static://202",
	],
	networksAdvanced: [{ name: network.name, aliases: ["oauth2-proxy"] }],
	restart,
	logDriver,
	logOpts,
});
