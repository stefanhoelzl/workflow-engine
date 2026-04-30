{
	admin off
%{ if acme_email != "" ~}
	email ${acme_email}
%{ endif ~}
}

%{ for site in sites ~}
${site.domain} {
%{ if acme_email == "" ~}
	tls internal
%{ endif ~}
	reverse_proxy ${site.upstream.name}.${site.upstream.namespace}.svc.cluster.local:${site.upstream.port}
}

%{ endfor ~}
