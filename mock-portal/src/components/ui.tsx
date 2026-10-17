import { useEffect } from "react";
import type { ReactNode } from "react";
import type { EffectiveStatus, StoredStatus } from "../domain/types";

export function usePageTitle(title: string): void {
  useEffect(() => {
    document.title = `${title} | Northstar Mock Bank (simulated)`;
  }, [title]);
}

export function Card({ children, className = "" }: { readonly children: ReactNode; readonly className?: string }) {
  return <section className={`rounded-xl border border-slate-200 bg-white p-6 shadow-sm ${className}`}>{children}</section>;
}

const STATUS_STYLES: Record<EffectiveStatus, string> = {
  scheduled: "bg-sky-100 text-sky-800",
  pending: "bg-amber-100 text-amber-800",
  processing: "bg-indigo-100 text-indigo-800",
  completed: "bg-emerald-100 text-emerald-800",
  canceled: "bg-slate-200 text-slate-700",
};

const STATUS_LABELS: Record<EffectiveStatus, string> = {
  scheduled: "Scheduled",
  pending: "Pending",
  processing: "Processing",
  completed: "Completed",
  canceled: "Canceled",
};

export function statusLabel(status: EffectiveStatus | StoredStatus): string {
  return STATUS_LABELS[status];
}

export function StatusBadge({ status }: { readonly status: EffectiveStatus }) {
  return (
    <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-semibold ${STATUS_STYLES[status]}`}>
      {STATUS_LABELS[status]}
    </span>
  );
}

type AlertTone = "success" | "error" | "info" | "warning";

const ALERT_STYLES: Record<AlertTone, string> = {
  success: "border-emerald-300 bg-emerald-50 text-emerald-900",
  error: "border-rose-300 bg-rose-50 text-rose-900",
  info: "border-sky-300 bg-sky-50 text-sky-900",
  warning: "border-amber-300 bg-amber-50 text-amber-900",
};

export function Alert({
  tone,
  title,
  children,
}: {
  readonly tone: AlertTone;
  readonly title?: string;
  readonly children: ReactNode;
}) {
  return (
    <div role={tone === "error" ? "alert" : "status"} className={`rounded-lg border px-4 py-3 text-sm ${ALERT_STYLES[tone]}`}>
      {title === undefined ? null : <p className="font-semibold">{title}</p>}
      <div>{children}</div>
    </div>
  );
}

export const buttonClass = {
  primary:
    "inline-flex items-center rounded-md bg-teal-700 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-800 focus:outline-2 focus:outline-offset-2 focus:outline-teal-700 disabled:cursor-not-allowed disabled:bg-slate-300 disabled:text-slate-500",
  danger:
    "inline-flex items-center rounded-md bg-rose-700 px-4 py-2 text-sm font-semibold text-white hover:bg-rose-800 focus:outline-2 focus:outline-offset-2 focus:outline-rose-700 disabled:cursor-not-allowed disabled:bg-slate-300 disabled:text-slate-500",
  secondary:
    "inline-flex items-center rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 focus:outline-2 focus:outline-offset-2 focus:outline-teal-700 disabled:cursor-not-allowed disabled:text-slate-400",
} as const;

export const linkClass = "text-teal-700 underline underline-offset-2 hover:text-teal-900";

// --- Form controls ---------------------------------------------------------------

interface FieldShellProps {
  readonly id: string;
  readonly label: string;
  readonly hint?: string;
  readonly error: string | undefined;
  readonly required?: boolean;
  readonly children: ReactNode;
}

function FieldShell({ id, label, hint, error, required = false, children }: FieldShellProps) {
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium text-slate-800">
        {label}
        {required ? <span aria-hidden="true"> *</span> : null}
      </label>
      {hint === undefined ? null : (
        <p id={`${id}-hint`} className="text-xs text-slate-500">
          {hint}
        </p>
      )}
      <div className="mt-1">{children}</div>
      {error === undefined ? null : (
        <p id={`${id}-error`} className="mt-1 text-sm text-rose-700">
          {error}
        </p>
      )}
    </div>
  );
}

const inputClass =
  "block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-teal-600 focus:outline-2 focus:outline-teal-600 aria-[invalid=true]:border-rose-500";

function describedBy(id: string, hint: string | undefined, error: string | undefined): string | undefined {
  const ids = [hint === undefined ? null : `${id}-hint`, error === undefined ? null : `${id}-error`].filter(
    (value): value is string => value !== null,
  );
  return ids.length === 0 ? undefined : ids.join(" ");
}

interface TextFieldProps {
  readonly id: string;
  readonly name: string;
  readonly label: string;
  readonly hint?: string;
  readonly error: string | undefined;
  readonly required?: boolean;
  readonly type?: "text" | "email" | "date" | "tel";
  readonly autoComplete?: string;
}

export function TextField({ id, name, label, hint, error, required, type = "text", autoComplete = "off" }: TextFieldProps) {
  return (
    <FieldShell id={id} label={label} error={error} {...(hint === undefined ? {} : { hint })} {...(required === undefined ? {} : { required })}>
      <input
        id={id}
        name={name}
        type={type}
        autoComplete={autoComplete}
        aria-required={required === true}
        aria-invalid={error !== undefined}
        aria-describedby={describedBy(id, hint, error)}
        className={inputClass}
      />
    </FieldShell>
  );
}

export function TextAreaField({ id, name, label, hint, error, required }: Omit<TextFieldProps, "type" | "autoComplete">) {
  return (
    <FieldShell id={id} label={label} error={error} {...(hint === undefined ? {} : { hint })} {...(required === undefined ? {} : { required })}>
      <textarea
        id={id}
        name={name}
        rows={4}
        aria-required={required === true}
        aria-invalid={error !== undefined}
        aria-describedby={describedBy(id, hint, error)}
        className={inputClass}
      />
    </FieldShell>
  );
}

export function SelectField({
  id,
  name,
  label,
  hint,
  error,
  required,
  options,
}: Omit<TextFieldProps, "type" | "autoComplete"> & {
  readonly options: readonly { readonly value: string; readonly label: string }[];
}) {
  return (
    <FieldShell id={id} label={label} error={error} {...(hint === undefined ? {} : { hint })} {...(required === undefined ? {} : { required })}>
      <select
        id={id}
        name={name}
        defaultValue=""
        aria-required={required === true}
        aria-invalid={error !== undefined}
        aria-describedby={describedBy(id, hint, error)}
        className={inputClass}
      >
        <option value="">Select an option</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </FieldShell>
  );
}

export function RadioGroup({
  id,
  name,
  legend,
  error,
  options,
}: {
  readonly id: string;
  readonly name: string;
  readonly legend: string;
  readonly error: string | undefined;
  readonly options: readonly { readonly value: string; readonly label: string }[];
}) {
  return (
    <fieldset aria-describedby={error === undefined ? undefined : `${id}-error`}>
      <legend className="text-sm font-medium text-slate-800">
        {legend}
        <span aria-hidden="true"> *</span>
      </legend>
      <div className="mt-1 space-y-1">
        {options.map((option) => (
          <label key={option.value} className="flex items-center gap-2 text-sm">
            <input type="radio" name={name} value={option.value} />
            {option.label}
          </label>
        ))}
      </div>
      {error === undefined ? null : (
        <p id={`${id}-error`} className="mt-1 text-sm text-rose-700">
          {error}
        </p>
      )}
    </fieldset>
  );
}

export function CheckboxField({
  id,
  name,
  label,
  error,
}: {
  readonly id: string;
  readonly name: string;
  readonly label: string;
  readonly error: string | undefined;
}) {
  return (
    <div>
      <label htmlFor={id} className="flex items-start gap-2 text-sm">
        <input id={id} name={name} type="checkbox" className="mt-1" aria-invalid={error !== undefined} />
        <span>{label}</span>
      </label>
      {error === undefined ? null : <p className="mt-1 text-sm text-rose-700">{error}</p>}
    </div>
  );
}

/** Reads a string field from a submitted form without assuming it exists. */
export function readString(data: FormData, name: string): string {
  const value = data.get(name);
  return typeof value === "string" ? value : "";
}

export function readChecked(data: FormData, name: string): boolean {
  return data.get(name) !== null;
}
