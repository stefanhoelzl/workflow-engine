locals {
  base_url         = var.network.https_port == 443 ? "https://${var.network.domain}" : "https://${var.network.domain}:${var.network.https_port}"
  redirect_url     = "${local.base_url}/oauth2/callback"
  whitelist_domain = var.network.https_port == 443 ? var.network.domain : "${var.network.domain}:${var.network.https_port}"

  oauth2_env = {
    OAUTH2_PROXY_PROVIDER             = "github"
    OAUTH2_PROXY_GITHUB_USERS         = var.oauth2.github_users
    OAUTH2_PROXY_REDIRECT_URL         = local.redirect_url
    OAUTH2_PROXY_WHITELIST_DOMAINS    = local.whitelist_domain
    OAUTH2_PROXY_HTTP_ADDRESS         = "0.0.0.0:4180"
    OAUTH2_PROXY_REVERSE_PROXY        = "true"
    OAUTH2_PROXY_EMAIL_DOMAINS        = "*"
    OAUTH2_PROXY_COOKIE_SECURE        = "true"
    OAUTH2_PROXY_SET_XAUTHREQUEST     = "true"
    OAUTH2_PROXY_UPSTREAMS            = "static://202"
    OAUTH2_PROXY_CUSTOM_TEMPLATES_DIR = "/templates"
  }

  oauth2_secret_env = {
    OAUTH2_PROXY_CLIENT_ID     = "client-id"
    OAUTH2_PROXY_CLIENT_SECRET = "client-secret"
    OAUTH2_PROXY_COOKIE_SECRET = "cookie-secret"
  }
}
