ROOM PK (multi-guest PK) - install

BACKEND (C:\rydaapp\backend)
  1. Copy prisma/ and src/ from this zip over your backend (new files + full schema.prisma).
  2. Apply the edits to files that already exist:
       git apply patches/room-pk-edits.patch        (gift.service.ts, rooms.module.ts)
       git apply patches/economy-controller.patch   (economy.controller.ts)
  3. npx prisma generate ; npx tsc --noEmit ; npx jest room-pk   (29 tests: 14 rules + 15 service/gift-hook)
  4. Push. Render's pre-deploy `prisma migrate deploy` applies 20261006090000_room_pk.

MOBILE (C:\rydaapp\mobile)
  1. Copy mobile/src/api/roomPk.ts and mobile/src/components/RoomPkPanel.tsx into src/.
  2. git apply patches/mobile-roomscreen.patch patches/mobile-miniroomcontext.patch
     (1 import + 1 JSX line in RoomScreen; a ROOM_PK_* branch in the socket handler)
  3. npx tsc --noEmit

If `git apply` complains, the file has drifted from the zip I worked on: make the small edits by hand
(each patch is 10-20 lines).
