# DNS on Bunny DNS, managed via the existing bunnynet provider. The stho.net
# zone is owned out-of-band (registered at Scaleway, delegated to Bunny's
# kiki/coco.bunny.net nameservers); we reference it READ-ONLY via a data source
# and manage only the two workflow-engine subdomain records — never the apex or
# any sibling record. The VPS public IP is stable across instance stop/start
# (a separate scaleway_instance_ip resource), so the prod A record stays valid
# even if the instance is replaced.
data "bunnynet_dns_zone" "stho" {
  domain = var.base_domain
}

# prod → A record at the VPS IP. `name` is relative to the zone, so the FQDN
# workflow-engine.${base_domain} becomes name = "workflow-engine".
resource "bunnynet_dns_record" "prod_a" {
  zone  = data.bunnynet_dns_zone.stho.id
  name  = local.envs["prod"].dns_node
  type  = "A"
  value = scaleway_instance_ip.vps.address
  ttl   = 300
}

# staging → CNAME to the Bunny Magic Containers CDN host. Deliberately NOT
# depends_on the pullzone hostname: the cutover is a two-step targeted apply
# (see docs/infrastructure.md + the change's design.md). Step 1 applies ONLY
# these records so the CNAME propagates; step 2 (full apply) then lets Bunny
# validate the hostname's Let's Encrypt cert against the already-live CNAME. A
# depends_on here would drag the hostname into step 1 and make validation race
# DNS propagation, risking an LE lockout.
resource "bunnynet_dns_record" "staging_cname" {
  zone  = data.bunnynet_dns_zone.stho.id
  name  = local.envs["staging"].dns_node
  type  = "CNAME"
  value = local.bunny_staging_cdn_host
  ttl   = 300
}
