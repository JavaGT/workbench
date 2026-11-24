import { ref } from './field.mjs';
import { scope } from './scope.mjs';
import { grant, deny } from './grant.mjs';
import { OWNER_CAPABILITIES } from './auth/membership.mjs';



export function owner()          {
  return ref('User', { role: 'owner', readonly: true });
}

(owner                                        ).only = () => [
  scope(({ is }          ) => is.owner()).can(
    async ({ is }          ) =>
      (await is.owner())
        ? grant(...OWNER_CAPABILITIES)
        : deny('not the owner'),
  ),
];
