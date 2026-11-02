"use client";

import { useId, useMemo, useState, type FormEvent, type ReactNode } from "react";

import {
  ABILITIES,
  CONDITIONS,
  SKILLS,
  repository as defaultRepository,
  type Character,
  type CharacterInput,
  type Repository,
} from "@/lib/db";
import {
  formatLabel,
  toFormValues,
  validateCharacterForm,
  type CharacterDraft,
  type CharacterFormValues,
} from "@/lib/character-form-values";

export type CharacterFormProps = {
  /**
   * Pre-fills the form: an existing character when editing, or partial data
   * (e.g. scan output) when creating. Read once on mount — remount the form
   * (change its `key`) to load different values.
   */
  initialValues?: CharacterDraft;
  /** When set, the form updates this character instead of creating one. */
  characterId?: string;
  onSaved?: (character: Character) => void;
  onCancel?: () => void;
  /** Injectable for tests; defaults to the app-wide IndexedDB repository. */
  repo?: Repository;
};

type NumericField = "level" | "armorClass" | "passivePerception";
type TextField = "name" | "race" | "className" | "notes";
type ListField = "savingThrowProficiencies" | "skillProficiencies" | "conditions";

export function CharacterForm({
  initialValues,
  characterId,
  onSaved,
  onCancel,
  repo = defaultRepository,
}: CharacterFormProps) {
  const idPrefix = useId();
  const [values, setValues] = useState<CharacterFormValues>(() =>
    toFormValues(initialValues),
  );
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const isEdit = characterId !== undefined;
  // Errors are derived from the schema on every change once the user has tried to submit.
  const validation = useMemo(() => validateCharacterForm(values), [values]);
  const errors = submitted ? validation.errors : {};
  const errorCount = Object.keys(errors).length;

  const fieldId = (path: string) => `${idPrefix}-${path.replace(/\./g, "-")}`;
  const errorId = (path: string) => `${fieldId(path)}-error`;
  const fieldProps = (path: string) => ({
    id: fieldId(path),
    "aria-invalid": errors[path] ? true : undefined,
    "aria-describedby": errors[path] ? errorId(path) : undefined,
  });

  const setField = (field: TextField | NumericField, value: string) =>
    setValues((current) => ({ ...current, [field]: value }));

  const setNested = <K extends "hitPoints" | "abilityScores">(
    group: K,
    key: keyof CharacterFormValues[K],
    value: string,
  ) =>
    setValues((current) => ({
      ...current,
      [group]: { ...current[group], [key]: value },
    }));

  const toggle = (field: ListField, item: string, checked: boolean) =>
    setValues((current) => {
      const list = current[field] as string[];
      const next = checked
        ? [...list, item]
        : list.filter((entry) => entry !== item);
      return { ...current, [field]: next };
    });

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitted(true);
    setSaveError(null);

    if (!validation.success) {
      const firstKey = Object.keys(validation.errors)[0];
      if (firstKey) document.getElementById(fieldId(firstKey))?.focus();
      return;
    }

    const data = validation.data;
    // Keep any scan reference supplied by the caller; the form doesn't edit it.
    const input: CharacterInput =
      initialValues?.rawScan !== undefined
        ? { ...data, rawScan: initialValues.rawScan }
        : data;

    setSaving(true);
    try {
      const saved = isEdit
        ? await repo.characters.update(characterId, {
            ...input,
            // Explicit so clearing an optional field overwrites the stored value.
            race: data.race,
            passivePerception: data.passivePerception,
            notes: data.notes,
          })
        : await repo.characters.create(input);
      onSaved?.(saved);
    } catch (error) {
      setSaveError(
        error instanceof Error ? error.message : "Could not save character.",
      );
    } finally {
      setSaving(false);
    }
  }

  const textInput = (field: TextField, label: string, required = false) => (
    <Field label={label} path={field} errors={errors} fieldId={fieldId} errorId={errorId}>
      <input
        {...fieldProps(field)}
        type="text"
        name={field}
        value={values[field]}
        onChange={(event) => setField(field, event.target.value)}
        aria-required={required || undefined}
        autoComplete="off"
      />
    </Field>
  );

  const numberInput = (
    path: string,
    label: string,
    value: string,
    onChange: (value: string) => void,
    required = true,
  ) => (
    <Field label={label} path={path} errors={errors} fieldId={fieldId} errorId={errorId}>
      <input
        {...fieldProps(path)}
        type="number"
        inputMode="numeric"
        step={1}
        name={path}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-required={required || undefined}
      />
    </Field>
  );

  const checkboxGroup = <T extends string>(
    field: ListField,
    legend: string,
    options: readonly T[],
  ) => (
    <fieldset
      className="character-form__group character-form__checkboxes"
      aria-describedby={errors[field] ? errorId(field) : undefined}
    >
      <legend>{legend}</legend>
      <ul className="character-form__options">
        {options.map((option) => (
          <li key={option}>
            <label>
              <input
                type="checkbox"
                name={field}
                value={option}
                checked={(values[field] as string[]).includes(option)}
                onChange={(event) =>
                  toggle(field, option, event.target.checked)
                }
              />{" "}
              {formatLabel(option)}
            </label>
          </li>
        ))}
      </ul>
      <FieldError id={errorId(field)} message={errors[field]} />
    </fieldset>
  );

  return (
    <form
      className="character-form"
      onSubmit={handleSubmit}
      noValidate
      aria-label={isEdit ? "Edit character" : "New character"}
    >
      {errorCount > 0 && (
        <p className="character-form__summary" role="alert">
          Please fix {errorCount} {errorCount === 1 ? "field" : "fields"} before
          saving.
        </p>
      )}

      <fieldset className="character-form__group character-form__group--basics">
        <legend>Basics</legend>
        {textInput("name", "Name", true)}
        {textInput("race", "Race")}
        {textInput("className", "Class", true)}
        {numberInput("level", "Level", values.level, (v) => setField("level", v))}
        {numberInput("armorClass", "Armor Class", values.armorClass, (v) =>
          setField("armorClass", v),
        )}
      </fieldset>

      <fieldset className="character-form__group character-form__group--hit-points">
        <legend>Hit Points</legend>
        {numberInput("hitPoints.max", "Max HP", values.hitPoints.max, (v) =>
          setNested("hitPoints", "max", v),
        )}
        {numberInput(
          "hitPoints.current",
          "Current HP",
          values.hitPoints.current,
          (v) => setNested("hitPoints", "current", v),
        )}
        {numberInput(
          "hitPoints.temporary",
          "Temporary HP",
          values.hitPoints.temporary,
          (v) => setNested("hitPoints", "temporary", v),
          false,
        )}
      </fieldset>

      <fieldset className="character-form__group character-form__group--abilities">
        <legend>Ability Scores</legend>
        {ABILITIES.map((ability) => (
          <div key={ability} className="character-form__ability">
            {numberInput(
              `abilityScores.${ability}`,
              formatLabel(ability),
              values.abilityScores[ability],
              (v) => setNested("abilityScores", ability, v),
            )}
          </div>
        ))}
      </fieldset>

      {checkboxGroup("savingThrowProficiencies", "Saving Throw Proficiencies", ABILITIES)}
      {checkboxGroup("skillProficiencies", "Skill Proficiencies", SKILLS)}

      <fieldset className="character-form__group">
        <legend>Other</legend>
        {numberInput(
          "passivePerception",
          "Passive Perception",
          values.passivePerception,
          (v) => setField("passivePerception", v),
          false,
        )}
      </fieldset>

      {checkboxGroup("conditions", "Conditions", CONDITIONS)}

      <Field label="Notes" path="notes" errors={errors} fieldId={fieldId} errorId={errorId}>
        <textarea
          {...fieldProps("notes")}
          name="notes"
          rows={4}
          value={values.notes}
          onChange={(event) => setField("notes", event.target.value)}
        />
      </Field>

      {saveError && (
        <p className="character-form__save-error" role="alert">
          {saveError}
        </p>
      )}

      <div className="character-form__actions">
        <button type="submit" disabled={saving}>
          {saving ? "Saving…" : isEdit ? "Save changes" : "Add character"}
        </button>
        {onCancel && (
          <button type="button" onClick={onCancel} disabled={saving}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

function Field({
  label,
  path,
  errors,
  fieldId,
  errorId,
  children,
}: {
  label: string;
  path: string;
  errors: Partial<Record<string, string>>;
  fieldId: (path: string) => string;
  errorId: (path: string) => string;
  children: ReactNode;
}) {
  return (
    <div
      className="character-form__field"
      data-invalid={errors[path] ? "true" : undefined}
    >
      <label htmlFor={fieldId(path)}>{label}</label>
      {children}
      <FieldError id={errorId(path)} message={errors[path]} />
    </div>
  );
}

function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return (
    <p id={id} className="character-form__error">
      {message}
    </p>
  );
}
