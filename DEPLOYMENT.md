# Railway deployment

1. Connect this GitHub repository to a Railway app service.
2. Add a Redis service to the same Railway project.
3. Reference the Redis service's `REDIS_URL` from the app service.
4. Confirm that `/health` returns `{"ok":true,"storage":"redis"}`.

Room state is retained in Redis for seven days, so players can reconnect with
their existing token after an app restart. Change the retention period with
`ROOM_TTL_SECONDS`. Keep the app at one replica so Socket.IO clients share the
same process; Redis provides restart recovery rather than cross-replica fan-out.

Without `REDIS_URL`, the app falls back to in-memory state for local development.
