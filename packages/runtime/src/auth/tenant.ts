import type { UserContext } from "./user.js";

const TENANT_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$/;

function validateTenant(s: string): boolean {
	return TENANT_REGEX.test(s);
}

function tenantSet(user: UserContext): ReadonlySet<string> {
	const set = new Set<string>();
	for (const org of user.orgs) {
		if (validateTenant(org)) {
			set.add(org);
		}
	}
	if (validateTenant(user.name)) {
		set.add(user.name);
	}
	return set;
}

function isMember(user: UserContext, tenant: string): boolean {
	if (!validateTenant(tenant)) {
		return false;
	}
	return tenantSet(user).has(tenant);
}

export { isMember, TENANT_REGEX, tenantSet, validateTenant };
