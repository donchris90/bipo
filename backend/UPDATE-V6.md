# Room System V6

Continued room-system hardening from V5.

## Fixes
- INVITE_ONLY guests can now use the room's Join button after receiving a host invite; the pending invite is consumed and the guest is assigned the first available unlocked seat.
- INVITE_ONLY direct seat requests now consume a valid invite and assign the requested seat instead of returning a pending invite object.
- Private-room approval now rejects a request if the requester became banned after creating the request.
- Moderator add/remove changes are broadcast immediately so all room clients update moderator state without waiting for polling.
- Added `REMOVE_MODERATOR` to the moderation-action type used by the audit log.
- Existing host/moderator permission checks remain server-enforced.

## Validation
The source was inspected after patching. A full TypeScript build still requires the project's dependencies (`node_modules`) and should be run in the normal development environment.
