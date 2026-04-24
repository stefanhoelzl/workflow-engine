import type { UserContext } from "./user-context.js";

const OWNER_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$/;
const REPO_REGEX = /^[a-zA-Z0-9._-]{1,100}$/;

function validateOwner(s: string): boolean {
	return OWNER_REGEX.test(s);
}

function validateRepo(s: string): boolean {
	return REPO_REGEX.test(s);
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

export {
	isMember,
	OWNER_REGEX,
	ownerSet,
	REPO_REGEX,
	validateOwner,
	validateRepo,
};
