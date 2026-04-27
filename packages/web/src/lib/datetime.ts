export function formatLocalOffsetTimestamp(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return timestamp;
  return `${formatLocalDateTimeParts(date)}${formatLocalOffset(date)}`;
}

export function formatDatetimeLocalInputValue(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "";
  return formatLocalDateTimeParts(date);
}

export function localOffsetTimestampFromDatetimeLocalValue(
  value: string,
): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `${value}${formatLocalOffset(date)}`;
}

export function formatHumanTemporalTimestamp(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return timestamp;
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: date.getMilliseconds() === 0 ? undefined : 3,
    timeZoneName: "short",
  }).format(date);
}

function formatLocalDateTimeParts(date: Date): string {
  const year = date.getFullYear();
  const month = padDatePart(date.getMonth() + 1);
  const day = padDatePart(date.getDate());
  const hour = padDatePart(date.getHours());
  const minute = padDatePart(date.getMinutes());
  const second = padDatePart(date.getSeconds());
  const millisecond = date.getMilliseconds();
  const fractionalSecond =
    millisecond === 0 ? "" : `.${String(millisecond).padStart(3, "0")}`;
  return `${year}-${month}-${day}T${hour}:${minute}:${second}${fractionalSecond}`;
}

function formatLocalOffset(date: Date): string {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absOffsetMinutes = Math.abs(offsetMinutes);
  const hours = padDatePart(Math.floor(absOffsetMinutes / 60));
  const minutes = padDatePart(absOffsetMinutes % 60);
  return `${sign}${hours}:${minutes}`;
}

function padDatePart(value: number): string {
  return String(value).padStart(2, "0");
}
