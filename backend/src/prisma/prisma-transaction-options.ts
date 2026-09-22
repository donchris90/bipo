// Prisma's default interactive-transaction timeout is 5000ms — fine
// against a co-located database, but this app's database is on the other
// side of the world from where it runs (Oregon vs. Nigeria), and every
// query inside a transaction is a network round-trip. A few of them
// stacked together routinely exceeds 5s with nothing actually wrong.
//
// This was first found and fixed inside WalletService's own internal
// transaction — then reintroduced at a NEW call site (EntryService opening
// its own outer transaction to fix a different bug, the money-loss issue)
// that didn't get the same extended timeout, because the value was only
// set in one place rather than shared. Import this constant into any new
// `$transaction(...)` call rather than typing `{ timeout: ..., maxWait:
// ... }` again — that's exactly the class of mistake that caused the
// regression.
export const EXTENDED_TX_OPTIONS: { timeout: number; maxWait: number } = {
  timeout: 15000,
  maxWait: 5000,
};
