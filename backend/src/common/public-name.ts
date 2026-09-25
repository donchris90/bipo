// The name other people see for a user. Registration does not require a display name,
// so some accounts have none; those show as a short stable handle ("User 3FA2") instead
// of an anonymous "Guest"/"Someone". Never derived from the email or phone number.
export function publicName(displayName: string | null | undefined, userId: string): string {
  const name = displayName?.trim();
  if (name) return name;
  const handle = userId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 4).toUpperCase() || '0000';
  return `User ${handle}`;
}
