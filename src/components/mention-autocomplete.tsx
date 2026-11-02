"use client";

import type { Mentionable, PinnedReference } from "@/lib/chat/mentions";

/** The id of option `index` in the listbox `listboxId`, for aria-activedescendant. */
export function mentionOptionId(listboxId: string, index: number): string {
  return `${listboxId}-option-${index}`;
}

export type MentionListboxProps = {
  id: string;
  options: readonly Mentionable[];
  /** Index of the highlighted option (the combobox's active descendant). */
  highlighted: number;
  onSelect: (option: Mentionable) => void;
  onHighlight: (index: number) => void;
};

/*
 * The @mention suggestions, a listbox driven by the message textarea (the
 * combobox): focus never leaves the textarea, which points at the highlighted
 * option with aria-activedescendant. Always rendered (hidden when empty) so
 * the combobox's aria-controls always resolves.
 */
export function MentionListbox({ id, options, highlighted, onSelect, onHighlight }: MentionListboxProps) {
  return (
    <ul
      id={id}
      role="listbox"
      aria-label="Tag suggestions"
      className="mention-autocomplete"
      hidden={options.length === 0}
    >
      {options.map((option, index) => (
        <li
          key={option.id}
          id={mentionOptionId(id, index)}
          role="option"
          aria-selected={index === highlighted}
          className={`mention-option mention-option--${option.kind}${
            index === highlighted ? " mention-option--active" : ""
          }`}
          // Keep focus (and the caret) in the textarea.
          onMouseDown={(event) => event.preventDefault()}
          onMouseEnter={() => onHighlight(index)}
          onClick={() => onSelect(option)}
        >
          <span className="mention-option__name">@{option.token}</span>{" "}
          <span className="mention-option__hint">{option.hint}</span>
        </li>
      ))}
    </ul>
  );
}

export type MentionChipsProps = {
  tagged: readonly PinnedReference[];
  onRemove: (id: string) => void;
};

/** The entities the draft currently tags (what Send will pin), each removable. */
export function MentionChips({ tagged, onRemove }: MentionChipsProps) {
  if (tagged.length === 0) return null;
  return (
    <ul className="mention-chips" aria-label="Tagged">
      {tagged.map((ref) => (
        <li key={ref.id} className={`mention-chip mention-chip--${ref.kind}`}>
          <span className="mention-chip__name">@{ref.token}</span>
          <button
            type="button"
            className="mention-chip__remove"
            aria-label={`Untag ${ref.token}`}
            onClick={() => onRemove(ref.id)}
          >
            ×
          </button>
        </li>
      ))}
    </ul>
  );
}
