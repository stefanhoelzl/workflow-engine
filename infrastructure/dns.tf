# DNS on Bunny DNS, managed via the bunnynet provider. The stho.net zone is
# owned out-of-band (registered at Scaleway, delegated to Bunny's
# kiki/coco.bunny.net nameservers); we reference it READ-ONLY via a data source
# and manage only the two workflow-engine subdomain records — never the apex or
# any sibling record.
data "bunnynet_dns_zone" "stho" {
  domain = var.base_domain
}

# One CNAME per env → that env's Bunny Magic Containers CDN host. `name` is
# relative to the zone, so workflow-engine.${base_domain} becomes
# name = "workflow-engine".
#
# Deliberately NOT depends_on the pullzone hostname: the custom-hostname cutover
# is a two-step targeted apply (see bunny.tf + docs/infrastructure.md). Step 1
# applies ONLY these records so the CNAME propagates; step 2 (full apply) then
# lets Bunny validate the hostname's Let's Encrypt cert against the already-live
# CNAME. A depends_on here would drag the hostname into step 1 and make
# validation race DNS propagation, risking an LE lockout.
resource "bunnynet_dns_record" "cname" {
  for_each = local.bunny_envs
  zone     = data.bunnynet_dns_zone.stho.id
  name     = each.value.dns_node
  type     = "CNAME"
  value    = each.value.cdn_host
  ttl      = 300
}
