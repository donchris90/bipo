INSERT INTO "MissionDefinition" ("id","code","title","description","metric","target","rewardCoins","sortOrder") VALUES
 ('00000000-0000-4000-8000-000000000001','daily_live_60','Daily live broadcast','Broadcast for 60 minutes today','LIVE_MINUTES',60,180,1),
 ('00000000-0000-4000-8000-000000000002','daily_pk_win','PK battle win','Win 1 PK battle today','PK_WINS',1,300,2),
 ('00000000-0000-4000-8000-000000000003','daily_gifts_1000','Fan gifting milestone','Receive 1,000 coins in gifts today','GIFT_COINS_RECEIVED',1000,500,3),
 ('00000000-0000-4000-8000-000000000004','daily_new_fans_100','New fan acquisition','Gain 100 new followers today','NEW_FOLLOWERS',100,200,4)
ON CONFLICT ("code") DO NOTHING;

-- Migration 20260926120000_mission_journey marks the four rows above creatorOnly = true.
-- The rows below are the Rryda Journey: creatorOnly defaults to false, so every signed-in user
-- sees and can complete them (see MissionsService.list). Together they are the "TODAY" journey
-- from the product brief: watch, chat, gift, play, meet someone new.
INSERT INTO "MissionDefinition" ("id","code","title","description","metric","target","rewardCoins","sortOrder") VALUES
 ('00000000-0000-4000-8000-000000000005','journey_watch_2','Watch 2 lives','Watch 2 different live rooms today','LIVE_SESSIONS_WATCHED',2,15,10),
 ('00000000-0000-4000-8000-000000000006','journey_chat_5','Send 5 messages','Chat 5 times in a live or party room today','MESSAGES_SENT',5,15,11),
 ('00000000-0000-4000-8000-000000000007','journey_gift_1','Send a gift','Send at least 1 gift today','GIFTS_SENT',1,20,12),
 ('00000000-0000-4000-8000-000000000008','journey_game_1','Play a game','Play 1 round of any game today','GAMES_PLAYED',1,15,13),
 ('00000000-0000-4000-8000-000000000009','journey_meet_1','Meet someone new','Follow someone new today','NEW_FOLLOWS_MADE',1,15,14)
ON CONFLICT ("code") DO NOTHING;
