# media-service

**Owns:** uploads of images, videos and PDFs to DigitalOcean Spaces (S3 API), with compression. No database.
**Port:** 3002 (`MEDIA_SERVICE_PORT`), internal only. Through the gateway: `POST /v1/upload`, docs in the single gateway Swagger at `/api-docs` (D-29).
**Route:** `POST /upload` (multipart/form-data, one `file` field, optional `?type=image|video|document`) → 201 `{ url, key, kind, contentType, size, originalSize, width?, height?, durationSeconds? }`.

| Kind     | Allowed         | Max   | Stored as                                                                      |
| -------- | --------------- | ----- | ------------------------------------------------------------------------------ |
| image    | JPEG, PNG, WebP | 5 MB  | WebP q80, ≤1920×1080, auto-oriented, metadata stripped (sharp)                 |
| video    | MP4             | 50 MB | H.264 + AAC MP4, ≤1080p, faststart (ffmpeg-static, ≤2 parallel, 120 s timeout) |
| document | PDF             | 10 MB | unchanged                                                                      |

**Security:**

- logged-in users only: the auth-service access token is verified with `JWT_PUBLIC_KEY`, plus the Redis revocation flags;
- 30 uploads per 10 minutes per user;
- extension, MIME type and magic bytes must all agree;
- size limits are enforced while streaming;
- temp files are always deleted.

**Storage:** `<BUCKET_FOLDER_PATH>/<uuidv7>.<ext>`, `ACL: public-read`, immutable cache headers. All files are public by URL, PDFs included.
**Reuse:** `mediaService.uploadMedia(file, type)` (`src/features/media/media.service.ts`).
**Run:** `pnpm dev` (or `pnpm --filter @farmx/media-service dev`). Needs Redis and the `AWS_*`, `BUCKET_FOLDER_PATH` and `JWT_PUBLIC_KEY` env vars.
**Test / build:** `pnpm --filter @farmx/media-service test` (real sharp and ffmpeg runs, Spaces mocked) · `build` → `dist/server.js`.
