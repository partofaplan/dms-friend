import { createDexieRepository } from "./dexie-repository";
import type { Repository } from "./repository";

export * from "./schema";
export * from "./repository";
export {
  DexieRepository,
  DmFriendDb,
  createDexieRepository,
  type DexieRepositoryOptions,
} from "./dexie-repository";

/*
 * App-wide repository. Dexie opens IndexedDB lazily on first query, so
 * importing this on the server is safe as long as it is only used client-side.
 */
export const repository: Repository = createDexieRepository();
