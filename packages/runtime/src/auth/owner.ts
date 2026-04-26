import { OWNER_NAME_RE, REPO_NAME_RE } from "@workflow-engine/core";
import type { UserContext } from "./user-context.js";

function validateOwner(s: string): boolean {
	return OWNER_NAME_RE.test(s);
}

function validateRepo(s: string): boolean {
	return REPO_NAME_RE.test(s);
}

function ownerSet(user: UserContext): ReadonlySet<string> {
	const set = new Set<string>();
	for (const org of user.orgs) {
		if (validateOwner(org)) {
			set.add(org);
		}
	}
	return set;
}

function isMember(user: UserContext, owner: string): boolean {
	if (!validateOwner(owner)) {
		return false;
	}
	return ownerSet(user).has(owner);
}

export { isMember, ownerSet, validateOwner, validateRepo };
