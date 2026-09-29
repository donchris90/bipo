// A hand-rolled fake rather than a mocking library: the pieces under test
// (WalletService, GiftService) call `$transaction(cb)` and expect the
// callback to receive an object with the same shape as `prisma` — this
// fake IS that shape, backed by plain Maps, so `$transaction` just invokes
// the callback with `this`.
export class FakePrisma {
  wallets = new Map<string, any>(); // key: `${userId}:${type}`
  ledger = new Map<string, any>(); // key: idempotencyKey
  users = new Map<string, any>();
  gifts = new Map<string, any>();
  giftTransactions = new Map<string, any>();
  revenueSplitConfigs: any[] = [];
  private ledgerSeq = 0;

  wallet = {
    upsert: async ({ where, create }: any) => {
      const key = `${where.userId_type.userId}:${where.userId_type.type}`;
      let w = this.wallets.get(key);
      if (!w) {
        w = { id: key, balance: 0n, ...create };
        this.wallets.set(key, w);
      }
      return w;
    },
    update: async ({ where, data }: any) => {
      const w = [...this.wallets.values()].find((w) => w.id === where.id);
      Object.assign(w, data);
      return w;
    },
    // Missed on the first pass — WalletService.getBalance() calls this
    // directly (outside $transaction), unlike upsert/update which only run
    // inside applyMovement's transaction callback.
    findUnique: async ({ where }: any) => {
      if (where.userId_type) {
        const key = `${where.userId_type.userId}:${where.userId_type.type}`;
        return this.wallets.get(key) ?? null;
      }
      if (where.id) {
        return [...this.wallets.values()].find((w) => w.id === where.id) ?? null;
      }
      return null;
    },
  };

  ledgerEntry = {
    findUnique: async ({ where: { idempotencyKey } }: any) => this.ledger.get(idempotencyKey) ?? null,
    create: async ({ data }: any) => {
      // Deliberately not simulating the P2002 concurrent-race path here —
      // that requires Prisma.PrismaClientKnownRequestError, a real Prisma
      // export unavailable without a generated client. Sequential
      // idempotency (the common case: a client retry after a timeout) is
      // covered via the findUnique short-circuit above, which is what
      // these tests exercise.
      const entry = { id: `entry_${this.ledgerSeq++}`, ...data };
      this.ledger.set(data.idempotencyKey, entry);
      return entry;
    },
  };

  user = {
    findUnique: async ({ where: { id } }: any) => this.users.get(id) ?? null,
  };

  gift = {
    findUnique: async ({ where: { id } }: any) => this.gifts.get(id) ?? null,
  };

  giftTransaction = {
    findUnique: async ({ where: { idempotencyKey } }: any) => this.giftTransactions.get(idempotencyKey) ?? null,
    create: async ({ data }: any) => {
      const tx = { id: `gift_tx_${this.giftTransactions.size}`, createdAt: new Date(), ...data };
      this.giftTransactions.set(data.idempotencyKey, tx);
      return tx;
    },
  };

  pKBattle = {
    findUnique: async () => null, // no PK tests exercise this path here
    findFirst: async () => null, // same — GiftService.resolvePkBattleId checks this to see if the recipient is in an active PK; no test here puts them in one
  };

  agencyMemberships = new Map<string, any>(); // key: creatorId (only one ACTIVE membership per creator, matches the real uniqueness rule)
  agencies = new Map<string, any>(); // key: agencyId

  agencyMembership = {
    findFirst: async ({ where }: any) => {
      const m = this.agencyMemberships.get(where.creatorId);
      return m && m.status === (where.status ?? m.status) ? m : null;
    },
  };

  agency = {
    findUnique: async ({ where: { id } }: any) => this.agencies.get(id) ?? null,
  };

  revenueSplitConfig = {
    findFirst: async ({ where }: any) =>
      this.revenueSplitConfigs.find((c) => c.scope === where.scope && (!where.scopeKey || c.scopeKey === where.scopeKey)) ??
      null,
  };

  // key: `${roomId}:${userId}` — matches the real @@unique([roomId, userId]) on RoomSeat.
  roomSeats = new Map<string, any>();

  roomSeat = {
    // Only updateMany is used by the code under test (GiftService.send, for the ROOM-context
    // per-seat gift total). At most one row can ever match, since (roomId, userId) is unique —
    // matching zero rows (the recipient isn't actually seated) is a normal no-op, not an error.
    updateMany: async ({ where, data }: any) => {
      const key = `${where.roomId}:${where.userId}`;
      const seat = this.roomSeats.get(key);
      if (!seat) return { count: 0 };
      if (data.giftCoins?.increment !== undefined) seat.giftCoins = (seat.giftCoins ?? 0) + data.giftCoins.increment;
      return { count: 1 };
    },
  };

  // Row-locking read used by WalletService.applyMovement (`SELECT ... FOR UPDATE`) before it
  // debits/credits a balance. There is no concurrency to simulate here — these tests run
  // sequentially — so this only needs to hand back the wallet's current row. Recognizes the
  // query by shape (the id is the tagged template's first interpolated value) rather than by
  // parsing SQL text, since that's all Prisma.sql actually gives us to go on. If a second raw
  // query is ever added elsewhere, this will need a real dispatch — it deliberately doesn't try
  // to guess that in advance.
  $queryRaw = async (query: any) => {
    const walletId = query?.values?.[0];
    const wallet = walletId ? [...this.wallets.values()].find((w) => w.id === walletId) : undefined;
    return wallet ? [{ id: wallet.id, balance: wallet.balance }] : [];
  };

  $transaction = async (cb: (tx: any) => Promise<any>) => cb(this);
}
