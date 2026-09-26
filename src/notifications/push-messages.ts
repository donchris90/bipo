import type { NotificationType } from '@prisma/client';

export interface PushContent {
  title: string;
  body: string;
}

const coins = (v: unknown) => Number(v ?? 0).toLocaleString('en-US');

// The phone-notification wording for each notification type — the server-side
// twin of the inbox's describeNotification(), because a push has to be
// composed before the app is ever opened. `names` supplies display names the
// payload only holds as ids (FOLLOW, MESSAGE). Returns null for a type that
// shouldn't reach the lock screen.
//
// Deliberately never includes message text: DM content doesn't belong on a
// lock screen.
export function describeForPush(
  type: NotificationType | string,
  payload: Record<string, any> = {},
  names: { follower?: string | null; sender?: string | null } = {},
): PushContent | null {
  switch (type) {
    case 'FOLLOW':
      return { title: 'New follower', body: names.follower ? `${names.follower} started following you` : 'Someone started following you' };
    case 'MESSAGE':
      return { title: 'New message', body: names.sender ? `${names.sender} sent you a message` : 'You have a new message' };
    case 'GIFT_RECEIVED': {
      const who = payload.senderDisplayName ?? 'Someone';
      return { title: 'You received a gift', body: `${who} sent you a gift worth ${coins(payload.totalCoins)} coins` };
    }
    case 'PK_CHALLENGE':
      return { title: 'PK challenge', body: `${payload.challengerDisplayName ?? 'A host'} challenged you to a PK battle` };
    case 'PK_RESULT': {
      const vs = payload.opponentDisplayName ? ` against ${payload.opponentDisplayName}` : '';
      const body =
        payload.result === 'WIN'
          ? `You won your PK battle${vs}`
          : payload.result === 'LOSS'
            ? `You lost your PK battle${vs}`
            : `Your PK battle${vs} ended in a draw`;
      return { title: 'PK battle finished', body };
    }
    case 'SEAT_APPROVED':
      return { title: 'Seat approved', body: `Your seat request in ${payload.roomTitle ?? 'a party room'} was approved` };
    case 'WITHDRAWAL_UPDATE': {
      const amount = `${coins(payload.amountCoins)} coins`;
      if (payload.status === 'PAID') return { title: 'Withdrawal paid', body: `Your withdrawal of ${amount} was paid` };
      if (payload.status === 'REJECTED') return { title: 'Withdrawal rejected', body: `Your withdrawal of ${amount} was rejected. The coins were returned to your balance.` };
      if (payload.status === 'FAILED') return { title: 'Withdrawal failed', body: `Your withdrawal of ${amount} failed. The coins were returned to your balance.` };
      return { title: 'Withdrawal approved', body: `Your withdrawal of ${amount} is being processed` };
    }
    case 'COIN_PURCHASE':
      return { title: 'Coins added', body: `${coins(payload.coins)} coins were added to your wallet` };
    case 'CREATOR_APPLICATION':
      return payload.status === 'APPROVED'
        ? { title: 'Creator application', body: 'Your creator application was approved' }
        : { title: 'Creator application', body: 'Your creator application was not approved' };
    case 'MISSED_CALL':
      return { title: 'Missed call', body: `Missed call from ${payload.callerDisplayName ?? 'someone'}` };
    case 'HOST_LEVEL_UP':
      return { title: `Host Level ${payload.level}`, body: `Congratulations! You reached ${payload.name ?? `Level ${payload.level}`}.` };
    case 'RRYDA_LEVEL_UP':
      return { title: `Rryda Level ${payload.level}`, body: `You're now ${payload.name ?? `Level ${payload.level}`}! Keep going.` };
    case 'BADGE_EARNED':
      return { title: 'Badge earned', body: `${payload.emoji ?? '🏅'} You earned the ${payload.label ?? 'a'} badge` };
    case 'HOST_TASK_COMPLETED':
      return { title: 'Host task completed', body: `${payload.taskLabel ?? 'Daily host task'} completed${payload.rewardXp ? ` — +${payload.rewardXp} XP` : ''}` };
    case 'HOST_ACHIEVEMENT':
      return { title: 'Achievement unlocked', body: `You unlocked ${payload.label ?? 'a host achievement'}` };
    case 'HOST_RANKING':
      return { title: 'Host ranking update', body: `You are now ranked #${payload.rank ?? '?'} among hosts` };
    case 'SYSTEM':
      if (payload.event === 'PARTY_INVITE') {
        return { title: 'Party invitation', body: `${payload.hostDisplayName ?? 'A host'} invited you to ${payload.roomTitle ?? 'a party room'}` };
      }
      return null;
    case 'SECURITY':
      switch (payload.event) {
        case 'kyc_approved':
          return { title: 'Identity verified', body: 'Your identity has been verified.' };
        case 'kyc_rejected':
          return { title: 'Verification not approved', body: `Your identity check was not approved${payload.reason ? `: ${payload.reason}` : ''}. You can submit it again.` };
        case 'payout_account_added':
        case 'payout_account_changed':
          return { title: 'Payout account updated', body: `Your payout account is now ${payload.bankName ?? 'a bank account'} ••••${payload.accountLast4 ?? ''}. If this wasn't you, contact support.` };
        default:
          return { title: 'Security alert', body: 'There was a security alert on your account' };
      }
    default:
      return null; // SYSTEM and anything unknown stay in-app only
  }
}
