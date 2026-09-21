const CHINA_TIME_ZONE = "Asia/Shanghai";
const DATABASE_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?/;

type DateTimeParts = {
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
  second: string;
};

function databaseParts(value: unknown): DateTimeParts | null {
  if (value === null || value === undefined || value === "") return null;
  const match = DATABASE_DATE_TIME.exec(String(value));
  if (!match) return null;
  const [, year, month, day, hour, minute, second = "00"] = match;
  const candidate = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)));
  if (candidate.getUTCFullYear() !== Number(year) || candidate.getUTCMonth() !== Number(month) - 1 || candidate.getUTCDate() !== Number(day)
    || candidate.getUTCHours() !== Number(hour) || candidate.getUTCMinutes() !== Number(minute) || candidate.getUTCSeconds() !== Number(second)) return null;
  return { year: year!, month: month!, day: day!, hour: hour!, minute: minute!, second };
}

function instantParts(value: unknown): DateTimeParts | null {
  if (value === null || value === undefined || value === "") return null;
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.valueOf())) return null;
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: CHINA_TIME_ZONE,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value || "";
  return { year: part("year"), month: part("month"), day: part("day"), hour: part("hour"), minute: part("minute"), second: part("second") };
}

function display(parts: DateTimeParts | null, fallback: string): string {
  return parts ? `${parts.year}/${parts.month}/${parts.day} ${parts.hour}:${parts.minute}:${parts.second}` : fallback;
}

// MySQL CURRENT_TIMESTAMP fields are currently stored as Asia/Shanghai wall time,
// but mysql2 serializes the DATETIME value with a misleading trailing Z. Ignore
// that suffix for these fields so the browser does not add another eight hours.
export function formatDatabaseDateTime(value: unknown, fallback = "—"): string {
  return display(databaseParts(value), value ? String(value) : fallback);
}

export function formatDatabaseShortDate(value: unknown, fallback = "—"): string {
  const parts = databaseParts(value);
  return parts ? `${parts.month}-${parts.day}` : fallback;
}

// Use this only for values that are genuine instants, such as toISOString(),
// paid_at and the UTC-normalized credit consumption occurred_at column.
export function formatInstantDateTime(value: unknown, fallback = "—"): string {
  return display(instantParts(value), value ? String(value) : fallback);
}

export function databaseDateTimeLocalValue(value?: unknown): string {
  const parts = databaseParts(value) || instantParts(new Date());
  return parts ? `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}` : "";
}

export function instantDateTimeLocalValue(value?: unknown): string {
  const parts = instantParts(value || new Date());
  return parts ? `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}` : "";
}

export function chinaDateTimeLocalToIso(value: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (!match) return null;
  const [, year, month, day, hour, minute, second = "00"] = match;
  const timestamp = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour) - 8, Number(minute), Number(second));
  const date = new Date(timestamp);
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
}
