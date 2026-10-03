// Single source of truth for the referral reward. Both the signup credit
// (AuthService) and the /users/me/referrals response (UsersService) read this,
// so the amount shown in the app can never drift from the amount paid.
// The reward is always credited to the BONUS wallet (never COIN / earnings).
export const REFERRAL_BONUS_COINS = 100n;
export const REFERRAL_BONUS_COINS_NUMBER = Number(REFERRAL_BONUS_COINS);
