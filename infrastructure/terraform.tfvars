# Non-secret defaults committed to the repo. Operators do not need to set
# these as env vars or pass `-var` flags. Secrets continue to flow through
# `TF_VAR_*` env vars (state_passphrase, dynu_api_key, deploy_ssh_*, acme_email).

scaleway_project_id      = "1b415db2-d4ff-4a8c-962b-034d13cebf8b"
scaleway_organization_id = "c616f89b-3d2b-4cb3-98fb-b531fa68c06a"
acme_email               = "stefanh+acme@posteo.de"
