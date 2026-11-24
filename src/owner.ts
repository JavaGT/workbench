import { ref } from './field.ts';
import { scope } from './scope.ts';
import { grant, deny } from './grant.ts';
import { OWNER_CAPABILITIES } from './auth/membership.ts';

type IsHandle = { is: Record<string, (...args: unknown[]) => unknown> };

export function owner(): unknown {
  return ref('User', { role: 'owner', readonly: true });
}

(owner as unknown as { only: () => unknown[] }).only = () => [
  scope(({ is }: IsHandle) => is.owner()).can(
    async ({ is }: IsHandle) =>
      (await is.owner())
        ? grant(...OWNER_CAPABILITIES)
        : deny('not the owner'),
  ),
];
