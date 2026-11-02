import { z } from "zod";

import {
  characterSchema,
  chatMessageRecordSchema,
  combatantSchema,
  partyProfileSchema,
  userProfileSchema,
  type Character,
  type ChatMessageRecord,
  type Combatant,
  type PartyProfile,
  type UserProfile,
} from "./schema";

/*
 * Export/import of a whole user profile as one versioned JSON document: the
 * user, its party profiles, and every party's characters, monster stable and
 * chat history. Records are embedded exactly as stored, so the stored schemas
 * double as the import validator. Legacy `parties` rows are not part of the
 * format (they are superseded by party profiles).
 */

export const USER_PROFILE_EXPORT_FORMAT_VERSION = 1;

export const userProfileExportSchema = z
  .object({
    formatVersion: z.literal(USER_PROFILE_EXPORT_FORMAT_VERSION),
    exportedAt: z.iso.datetime(),
    user: userProfileSchema,
    partyProfiles: z.array(partyProfileSchema),
    characters: z.array(characterSchema),
    combatants: z.array(combatantSchema),
    chatMessages: z.array(chatMessageRecordSchema),
  })
  .superRefine((data, ctx) => {
    const partyIds = new Set<string>();
    data.partyProfiles.forEach((party, i) => {
      if (party.userId !== data.user.id) {
        ctx.addIssue({
          code: "custom",
          message: "party profile belongs to a different user",
          path: ["partyProfiles", i, "userId"],
        });
      }
      if (partyIds.has(party.id)) {
        ctx.addIssue({
          code: "custom",
          message: "duplicate party profile id",
          path: ["partyProfiles", i, "id"],
        });
      }
      partyIds.add(party.id);
    });
    for (const key of ["characters", "combatants", "chatMessages"] as const) {
      data[key].forEach((record, i) => {
        if (!partyIds.has(record.partyProfileId)) {
          ctx.addIssue({
            code: "custom",
            message: "references a party profile not in the export",
            path: [key, i, "partyProfileId"],
          });
        }
      });
    }
  });

export type UserProfileExport = z.infer<typeof userProfileExportSchema>;

/** The data offered for import is not a valid (or a supported) user profile export. */
export class ImportError extends Error {
  readonly issues: z.core.$ZodIssue[];

  constructor(message: string, issues: z.core.$ZodIssue[] = []) {
    super(message);
    this.name = "ImportError";
    this.issues = issues;
  }
}

/** Validates an export given as a parsed object or a JSON string; throws ImportError. */
export function parseUserProfileExport(data: unknown): UserProfileExport {
  let value = data;
  if (typeof data === "string") {
    try {
      value = JSON.parse(data);
    } catch {
      throw new ImportError("Invalid user profile export: not valid JSON");
    }
  }
  const version = (value as { formatVersion?: unknown } | null)?.formatVersion;
  if (
    typeof value === "object" &&
    value !== null &&
    version !== USER_PROFILE_EXPORT_FORMAT_VERSION
  ) {
    throw new ImportError(
      `Unsupported user profile export format version: ${String(version)}`,
    );
  }
  const result = userProfileExportSchema.safeParse(value);
  if (!result.success) {
    throw new ImportError(
      `Invalid user profile export:\n${z.prettifyError(result.error)}`,
      result.error.issues,
    );
  }
  return result.data;
}

export interface RemappedUserProfile {
  user: UserProfile;
  partyProfiles: PartyProfile[];
  characters: Character[];
  combatants: Combatant[];
  chatMessages: ChatMessageRecord[];
}

/**
 * Gives every record in an export a fresh id, rewiring the references (party
 * → user, record → party) so the copy shares nothing with the original. The
 * user is stamped `now` — it is a new profile on this device — while nested
 * records keep their timestamps (and chat its sequence) so ordering survives.
 */
export function remapUserProfileExport(
  data: UserProfileExport,
  { generateId, now }: { generateId: () => string; now: () => string },
): RemappedUserProfile {
  const timestamp = now();
  const user = {
    ...data.user,
    id: generateId(),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const partyIds = new Map<string, string>();
  const partyProfiles = data.partyProfiles.map((party) => {
    const id = generateId();
    partyIds.set(party.id, id);
    return { ...party, id, userId: user.id };
  });
  const rescope = <T extends { id: string; partyProfileId: string }>(
    record: T,
  ): T => ({
    ...record,
    id: generateId(),
    partyProfileId: partyIds.get(record.partyProfileId)!,
  });
  return {
    user,
    partyProfiles,
    characters: data.characters.map(rescope),
    combatants: data.combatants.map(rescope),
    chatMessages: data.chatMessages.map(rescope),
  };
}
