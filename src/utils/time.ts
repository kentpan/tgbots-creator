export function utcnow(): Date {
  return new Date();
}

export function toUtcNaive(date: Date): Date {
  return new Date(date.getTime() + date.getTimezoneOffset() * 60000);
}
