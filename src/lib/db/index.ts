import { createDexieRepository } from "./dexie-repository";
import type { AppRepository } from "./repository";

export * from "./schema";
export * from "./repository";
export * from "./transfer";
export {
  DEFAULT_PARTY_NAME,
  DEFAULT_USER_NAME,
  DexieRepository,
  DmFriendDb,
  createDexieRepository,
  type DexieRepositoryOptions,
} from "./dexie-repository";

/*
 * App-wide repository. Dexie opens IndexedDB lazily on first query, so
 * importing this on the server is safe as long as it is only used client-side.
 * It is also a (legacy) `Repository`, whose characters/combatants act on the
 * default party profile until screens move to `repository.forParty(id)`.
 */
export const repository: AppRepository = createDexieRepository();
