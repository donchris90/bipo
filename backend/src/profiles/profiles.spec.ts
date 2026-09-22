import { NotFoundException } from '@nestjs/common';
import { ProfilesService } from './profiles.service';

const user = { id: 'host', displayName: 'Ada', avatarUrl: 'https://x/a.jpg', countryCode: 'NG', kycVerified: true, status: 'ACTIVE' };

function build(over: { target?: any; blocked?: boolean; follows?: boolean; live?: any; notified?: any } = {}) {
  const prisma: any = {
    user: { findUnique: jest.fn(async ({ where }: any) => (where.id === 'host' ? (over.target === undefined ? user : over.target) : { displayName: 'Bo', avatarUrl: null })) },
    follow: { count: jest.fn(async ({ where }: any) => (where.followingId ? 12 : 3)), findUnique: jest.fn().mockResolvedValue(over.follows ? { followerId: 'me' } : null) },
    liveSession: { findFirst: jest.fn().mockResolvedValue(over.live ?? null) },
    block: { findFirst: jest.fn().mockResolvedValue(over.blocked ? { id: 'b' } : null) },
  };
  const notifications: any = { notifyOnce: jest.fn().mockResolvedValue(over.notified === undefined ? { id: 'n1' } : over.notified) };
  return { svc: new ProfilesService(prisma, notifications), notifications, prisma };
}

describe('ProfilesService.get', () => {
  it('returns what a profile card needs — counts, whether you follow them, whether they are live — and nothing private', async () => {
    const { svc } = build({ follows: true, live: { id: 's1', title: 'Late night chat' } });
    const p = await svc.get('me', 'host');
    expect(p).toEqual({ id: 'host', displayName: 'Ada', avatarUrl: 'https://x/a.jpg', countryCode: 'NG', verified: true, followerCount: 12, followingCount: 3, isMe: false, isFollowing: true, live: { sessionId: 's1', title: 'Late night chat' } });
    expect(Object.keys(p)).not.toEqual(expect.arrayContaining(['email', 'passwordHash', 'phone']));
  });

  it('your own profile is flagged and has no follow state', async () => {
    const { svc } = build();
    expect(await svc.get('host', 'host')).toMatchObject({ isMe: true, isFollowing: false });
  });

  it('a missing, suspended or blocked person all look the same — "not found"', async () => {
    await expect(build({ target: null }).svc.get('me', 'host')).rejects.toThrow('Profile not found');
    await expect(build({ target: { ...user, status: 'SUSPENDED' } }).svc.get('me', 'host')).rejects.toBeInstanceOf(NotFoundException);
    await expect(build({ blocked: true }).svc.get('me', 'host')).rejects.toThrow('Profile not found');
  });
});

describe('ProfilesService.recordView (profile-visit notification)', () => {
  it('notifies the person once per visitor per day, with who visited', async () => {
    const { svc, notifications } = build();
    const out = await svc.recordView('me', 'host', Date.UTC(2026, 8, 21, 10));
    expect(out).toEqual({ recorded: true });
    expect(notifications.notifyOnce).toHaveBeenCalledWith('host', 'PROFILE_VISIT', 'visit:me:2026-09-21', { visitorId: 'me', visitorName: 'Bo', visitorAvatarUrl: null });
  });

  it('a second visit the same day is not a second notification (the dedupe key is the same)', async () => {
    const { svc, notifications } = build({ notified: null }); // notifyOnce reports "already exists"
    expect(await svc.recordView('me', 'host', Date.UTC(2026, 8, 21, 22))).toEqual({ recorded: false });
    expect(notifications.notifyOnce.mock.calls[0][2]).toBe('visit:me:2026-09-21');
    // and the next day is a new key
    await svc.recordView('me', 'host', Date.UTC(2026, 8, 22, 1));
    expect(notifications.notifyOnce.mock.calls[1][2]).toBe('visit:me:2026-09-22');
  });

  it('never notifies for your own profile, and never across a block', async () => {
    const own = build();
    expect(await own.svc.recordView('host', 'host')).toEqual({ recorded: false });
    expect(own.notifications.notifyOnce).not.toHaveBeenCalled();
    const blocked = build({ blocked: true });
    await expect(blocked.svc.recordView('me', 'host')).rejects.toBeInstanceOf(NotFoundException);
    expect(blocked.notifications.notifyOnce).not.toHaveBeenCalled();
  });
});
