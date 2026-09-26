/* A two-state switch on a real button, so it is focusable and announced.
 *
 * `aria-pressed` rather than a checkbox role: these toggle a view setting that
 * takes effect immediately, which is what a pressed button means, and it keeps
 * the label clickable without a `for`/`id` pair.
 */

import { memo } from 'react';

export interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  /** Hide the visible label but keep it for screen readers. */
  labelHidden?: boolean;
  disabled?: boolean;
}

export const Switch = memo(function Switch({
  checked,
  onChange,
  label,
  labelHidden = false,
  disabled = false,
}: SwitchProps) {
  return (
    <button
      type="button"
      className="switch"
      aria-pressed={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      style={disabled ? { opacity: 0.45, cursor: 'not-allowed' } : undefined}
    >
      <span className={labelHidden ? 'sr-only' : undefined}>{label}</span>
      <span className="switch__track" aria-hidden="true">
        <span className="switch__knob" />
      </span>
    </button>
  );
});
